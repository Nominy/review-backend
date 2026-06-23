import { config } from "../../config";
import {
  assertOpenRouterModelExists,
  assertOpenRouterModelSupportsAudio,
  buildCachedOpenRouterTextContent,
  requestOpenRouterChat,
  shouldUseGeminiPromptCaching,
  type OpenRouterContentPart,
  type OpenRouterReasoningEffort,
  type OpenRouterServiceTier
} from "../../shared/openrouter-client";
import { selectAudioTracksForRow, sliceAudioTrackForRow, type SliceAudioArgs } from "./audio-cues";
import type {
  AudioCueAudioTrackInput,
  BrokerRedistributeTextRequest,
  BrokerRedistributeTextResponse,
  BrokerRedistributionGroup,
  BrokerRedistributionReview,
  BrokerTranscribeSegmentRequest,
  BrokerTranscribeSegmentResponse,
  DraftingTranscriptRowInput
} from "./types";

type BrokerTranscribeDeps = {
  audioTracks: AudioCueAudioTrackInput[];
  validateAudioModel?: (model: string) => Promise<void>;
  sliceAudio?: (args: SliceAudioArgs) => Promise<{ trackId: string; speakerKey?: string; trackLabel?: string; format: string; base64: string }>;
};

type BrokerRedistributeDeps = {
  validateModel?: (model: string) => Promise<void>;
};

type BrokerRedistributeTextGroupRequest = Omit<BrokerRedistributeTextRequest, "groups"> & {
  group: BrokerRedistributionGroup;
};

function normalizeServiceTier(value: OpenRouterServiceTier | undefined): OpenRouterServiceTier {
  return value === "default" || value === "priority" || value === "flex" ? value : "flex";
}

function normalizeReasoningEffort(value: BrokerTranscribeSegmentRequest["reasoningEffort"]): OpenRouterReasoningEffort | undefined {
  return value && value !== "default" ? value : undefined;
}

function resolveModel(model: string | undefined): string {
  return typeof model === "string" && model.trim() ? model.trim() : config.openRouterModel;
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  const trimmed = content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1").trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function parseTranscriptionText(content: string): string {
  const parsed = parseJsonObject(content);
  const text = parsed && typeof parsed.text === "string" ? parsed.text : content;
  return text.trim().replace(/\s+/g, " ");
}

function parseRedistributionReview(content: string): BrokerRedistributionReview {
  const parsed = parseJsonObject(content);
  if (!parsed) {
    throw new Error("Broker redistribution response is not valid JSON.");
  }

  const acceptDraft = parsed.acceptDraft === true;
  const rawMoves = Array.isArray(parsed.moves) ? parsed.moves : [];
  const moves = rawMoves.map((move) => {
    if (!move || typeof move !== "object") {
      throw new Error("Broker redistribution move is not an object.");
    }
    const record = move as Record<string, unknown>;
    const fromIndex = Math.round(Number(record.fromIndex));
    const toIndex = Math.round(Number(record.toIndex));
    const sentenceCount = Math.round(Number(record.sentenceCount));
    if (
      !Number.isInteger(fromIndex) ||
      !Number.isInteger(toIndex) ||
      Math.abs(fromIndex - toIndex) !== 1 ||
      !Number.isInteger(sentenceCount) ||
      sentenceCount < 1
    ) {
      throw new Error("Broker redistribution move is missing adjacent fromIndex, toIndex, or sentenceCount.");
    }
    return {
      fromIndex,
      toIndex,
      sentenceCount
    };
  });

  return {
    acceptDraft,
    moves,
    ...(typeof parsed.notes === "string" ? { notes: parsed.notes } : {})
  };
}

function toTranscriptRow(request: BrokerTranscribeSegmentRequest): DraftingTranscriptRowInput {
  return {
    rowId: request.segment.rowId,
    speakerKey: request.segment.speakerKey,
    startSeconds: request.segment.startSeconds,
    endSeconds: request.segment.endSeconds,
    text: "",
    index: 0
  };
}

function buildTranscriptionSystemPrompt(): string {
  return [
    "You transcribe one short Russian speech segment from audio.",
    "Return JSON only with this shape: {\"text\":\"...\"}.",
    "Return only the words that are actually spoken.",
    "Do not translate, explain, add punctuation you are unsure about, or add speaker labels."
  ].join("\n");
}

function buildTranscriptionContent(
  row: DraftingTranscriptRowInput,
  clips: Array<{ trackId: string; speakerKey?: string; trackLabel?: string; format: string; base64: string }>
): OpenRouterContentPart[] {
  return [
    {
      type: "text",
      text: [
        `Speaker key: ${row.speakerKey}`,
        `Time range: ${row.startSeconds}-${row.endSeconds}s`,
        `Audio clips: ${clips.map((clip) => clip.trackId).join(", ")}`
      ].join("\n")
    },
    ...clips.flatMap((clip, index) => [
      {
        type: "text" as const,
        text: `Audio clip ${index + 1}: trackId=${clip.trackId}${clip.speakerKey ? `, speakerKey=${clip.speakerKey}` : ""}${clip.trackLabel ? `, trackLabel=${clip.trackLabel}` : ""}.`
      },
      {
        type: "input_audio" as const,
        input_audio: {
          data: clip.base64,
          format: clip.format
        }
      }
    ])
  ];
}

function buildRedistributionSystemPrompt(): string {
  return [
    "You review a deterministic Russian transcript text redistribution draft.",
    "The fullText is the exact text that must remain preserved.",
    "The draftAllocations assign that text to adjacent time segments.",
    "Either accept the draft or return minimal adjacent whole-sentence moves.",
    "Return JSON only with this shape: {\"acceptDraft\":true,\"moves\":[],\"notes\":\"...\"}.",
    "Each move must be {\"fromIndex\":1,\"toIndex\":2,\"sentenceCount\":1}.",
    "Indexes are one-based row indexes in the segment list, and fromIndex/toIndex must be adjacent.",
    "Do not rewrite, correct, translate, deduplicate, invent, or remove words."
  ].join("\n");
}

function buildRedistributionUserPrompt(request: BrokerRedistributeTextGroupRequest): string {
  return [
    `Group id: ${request.group.groupId}`,
    `Speaker key: ${request.group.speakerKey}`,
    `Full text: ${request.group.fullText}`,
    "",
    "Segments:",
    ...request.group.segments.map(
      (segment) =>
        `- ${segment.id}: index=${segment.index}, time=${segment.startSeconds ?? "unknown"}-${segment.endSeconds ?? "unknown"}s, current=${JSON.stringify(segment.text)}`
    ),
    "",
    "Draft allocations:",
    ...request.group.draftAllocations.map((allocation) => `- ${allocation.segmentId}: ${JSON.stringify(allocation.text)}`)
  ].join("\n");
}

export async function transcribeSegmentWithModel(
  request: BrokerTranscribeSegmentRequest,
  deps: BrokerTranscribeDeps
): Promise<BrokerTranscribeSegmentResponse> {
  const apiKey = request.openRouterApiKey.trim();
  if (!apiKey) {
    throw new Error("openRouterApiKey is required.");
  }
  const model = resolveModel(request.model);
  await (deps.validateAudioModel ?? assertOpenRouterModelSupportsAudio)(model);

  const row = toTranscriptRow(request);
  const selectedTracks = selectAudioTracksForRow(deps.audioTracks, row);
  if (!selectedTracks.length) {
    throw new Error(`missing_speaker_audio:${row.speakerKey}`);
  }

  const sliceAudio = deps.sliceAudio ?? sliceAudioTrackForRow;
  const clips = await Promise.all(selectedTracks.map((track) => sliceAudio({ track, row })));
  const systemPrompt = buildTranscriptionSystemPrompt();
  const useGeminiPromptCaching = shouldUseGeminiPromptCaching(model);
  const content = buildTranscriptionContent(row, clips);
  const response = await requestOpenRouterChat({
    apiKey,
    model,
    messages: [
      {
        role: "system",
        content: useGeminiPromptCaching ? [buildCachedOpenRouterTextContent(systemPrompt)] : systemPrompt
      },
      { role: "user", content }
    ],
    providerSort: "latency",
    reasoningEffort: normalizeReasoningEffort(request.reasoningEffort),
    serviceTier: normalizeServiceTier(request.serviceTier),
    temperature: 0.05,
    title: "Babel Helper AI Broker"
  });

  const text = parseTranscriptionText(response);
  if (!text) {
    throw new Error("empty_transcription");
  }

  return { text, model };
}

async function reviewRedistributionGroupWithModel(
  request: BrokerRedistributeTextGroupRequest,
  deps: BrokerRedistributeDeps = {}
): Promise<{ review: BrokerRedistributionReview; model: string }> {
  const apiKey = request.openRouterApiKey.trim();
  if (!apiKey) {
    throw new Error("openRouterApiKey is required.");
  }
  const model = resolveModel(request.model);
  await (deps.validateModel ?? assertOpenRouterModelExists)(model);

  const response = await requestOpenRouterChat({
    apiKey,
    model,
    messages: [
      { role: "system", content: buildRedistributionSystemPrompt() },
      { role: "user", content: buildRedistributionUserPrompt(request) }
    ],
    providerSort: "latency",
    reasoningEffort: normalizeReasoningEffort(request.reasoningEffort),
    serviceTier: normalizeServiceTier(request.serviceTier),
    temperature: 0.1,
    title: "Babel Helper AI Broker"
  });

  return {
    review: parseRedistributionReview(response),
    model
  };
}

export async function reviewRedistributionsWithModel(
  request: BrokerRedistributeTextRequest,
  deps: BrokerRedistributeDeps = {}
): Promise<BrokerRedistributeTextResponse> {
  const apiKey = request.openRouterApiKey.trim();
  if (!apiKey) {
    throw new Error("openRouterApiKey is required.");
  }
  const model = resolveModel(request.model);
  await (deps.validateModel ?? assertOpenRouterModelExists)(model);

  const results = await Promise.all(
    request.groups.map(async (group) => {
      try {
        const response = await reviewRedistributionGroupWithModel(
          {
            openRouterApiKey: request.openRouterApiKey,
            model,
            serviceTier: request.serviceTier,
            reasoningEffort: request.reasoningEffort,
            group
          },
          {
            validateModel: async () => {}
          }
        );
        return {
          groupId: group.groupId,
          ok: true as const,
          review: response.review,
          model: response.model
        };
      } catch (error) {
        return {
          groupId: group.groupId,
          ok: false as const,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    })
  );

  return {
    model,
    results
  };
}
