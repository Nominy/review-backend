import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  assertOpenRouterModelSupportsAudio,
  buildCachedOpenRouterTextContent,
  requestOpenRouterChat,
  shouldUseGeminiPromptCaching
} from "../../shared/openrouter-client";
import { parseResponseText } from "./openrouter";
import type {
  AudioCueAudioTrackInput,
  AudioCueClipInput,
  AudioCueDraftRequest,
  AudioCueRewriteContext,
  DraftRowResult,
  DraftSummary,
  DraftingTranscriptRowInput,
  GenerateDraftResponse
} from "./types";

const execFileAsync = promisify(execFile);
const TAG_SYSTEM_PATH = fileURLToPath(
  new URL("../../../docs/reference/russian-transcription-project-res-bank-tags.csv", import.meta.url)
);
export const DEFAULT_AUDIO_CUE_MODEL = "google/gemini-3-flash-preview";
const AUDIO_PADDING_SECONDS = 0.2;
const MIN_AUDIO_SLICE_SECONDS = 0.05;

export type SliceAudioArgs = {
  track: AudioCueAudioTrackInput;
  row: DraftingTranscriptRowInput;
};

export type SliceAudioBatchTask = SliceAudioArgs;

export type SliceAudioBatchArgs = {
  tasks: SliceAudioBatchTask[];
};

export type SliceAudioBatchResult = {
  clipsByRowId: Map<string, AudioCueClipInput[]>;
  errorsByRowId: Map<string, string[]>;
};

export type AudioCueBatchSlice = {
  row: DraftingTranscriptRowInput;
  outputPath: string;
  range: {
    start: number;
    duration: number;
    truncatedAtEnd: boolean;
  };
};

type GenerateAudioCueDraftDeps = {
  validateAudioModel?: (model: string) => Promise<void>;
  sliceAudio?: (args: SliceAudioArgs) => Promise<AudioCueClipInput>;
  rewriteRowWithAudio?: (context: AudioCueRewriteContext) => Promise<string>;
  model?: string;
  apiKey?: string;
  onRowComplete?: (args: {
    row: DraftRowResult;
    completedRows: number;
    totalRows: number;
    summary: DraftSummary;
  }) => void | Promise<void>;
};

let cachedTagSystem: string | null = null;
let cachedAllowedTags: Set<string> | null = null;

function summarizeDraftRows(draftRows: DraftRowResult[]): DraftSummary {
  const anomalyCounts: Record<string, number> = {};
  let rewrittenRows = 0;
  let unchangedRows = 0;
  let failedRows = 0;

  for (const row of draftRows) {
    if (row.status === "rewritten") {
      rewrittenRows += 1;
    } else if (row.status === "unchanged") {
      unchangedRows += 1;
    } else {
      failedRows += 1;
    }

    for (const warning of row.warnings) {
      anomalyCounts[warning] = (anomalyCounts[warning] || 0) + 1;
    }
  }

  return {
    totalRows: draftRows.length,
    rewrittenRows,
    unchangedRows,
    failedRows,
    anomalyCounts
  };
}

function summarizeCompletedDraftRows(draftRows: Array<DraftRowResult | undefined>): DraftSummary {
  return summarizeDraftRows(draftRows.filter((row): row is DraftRowResult => Boolean(row)));
}

function getAudioCueModel(request: AudioCueDraftRequest, deps: GenerateAudioCueDraftDeps): string {
  const requestedModel = typeof request.model === "string" ? request.model.trim() : "";
  return deps.model || requestedModel || DEFAULT_AUDIO_CUE_MODEL;
}

function normalizeServiceTier(value: AudioCueDraftRequest["serviceTier"]) {
  return value === "default" || value === "priority" || value === "flex" ? value : "flex";
}

export async function loadAudioCueTagSystem(): Promise<string> {
  if (cachedTagSystem === null) {
    cachedTagSystem = (await Bun.file(TAG_SYSTEM_PATH).text()).trim();
  }
  return cachedTagSystem;
}

async function loadAllowedTags(): Promise<Set<string>> {
  if (cachedAllowedTags === null) {
    const tagSystem = await loadAudioCueTagSystem();
    cachedAllowedTags = new Set(tagSystem.match(/\[[^\]\r\n]+\]|<[^<>\r\n]+>|\{[^{}\r\n]+\}/gu) || []);
  }
  return cachedAllowedTags;
}

function extractTagTokens(text: string): string[] {
  return text.match(/\{[^{}]*\}|\[[^[\]]*\]|<[^<>]*>/gu) ?? [];
}

function stripTagTokens(text: string): string {
  return text.replace(/\{[^{}]*\}|\[[^[\]]*\]|<[^<>]*>/gu, " ");
}

function wordTokens(text: string): string[] {
  return (stripTagTokens(text).toLocaleLowerCase().match(/[\p{L}\p{N}-]+/gu) ?? []).filter(Boolean);
}

function sameTranscriptWords(originalText: string, candidateText: string): boolean {
  return JSON.stringify(wordTokens(originalText)) === JSON.stringify(wordTokens(candidateText));
}

function validateAudioCueOutput(
  originalText: string,
  rewrittenText: string,
  allowedTags: Set<string>
): { row: Pick<DraftRowResult, "rewrittenText" | "status" | "warnings"> } {
  const original = originalText ?? "";
  const candidate = (rewrittenText ?? "").trim();
  if (!candidate) {
    return { row: { rewrittenText: original, status: "failed", warnings: ["empty_output"] } };
  }
  if (candidate.includes("\n")) {
    return { row: { rewrittenText: original, status: "failed", warnings: ["newline_drift"] } };
  }
  if (!sameTranscriptWords(original, candidate)) {
    return { row: { rewrittenText: original, status: "failed", warnings: ["text_drift"] } };
  }

  const originalTags = new Set(extractTagTokens(original));
  const unknownTags = extractTagTokens(candidate).filter((tag) => !allowedTags.has(tag) && !originalTags.has(tag));
  if (unknownTags.length) {
    return {
      row: {
        rewrittenText: original,
        status: "failed",
        warnings: [`unknown_audio_tag:${unknownTags[0]}`]
      }
    };
  }

  if (candidate === original) {
    return { row: { rewrittenText: candidate, status: "unchanged", warnings: [] } };
  }

  const addedTags = extractTagTokens(candidate).filter((tag) => !originalTags.has(tag));
  return {
    row: {
      rewrittenText: candidate,
      status: "rewritten",
      warnings: addedTags.length ? ["audio_cues_added"] : ["audio_cue_text_changed"]
    }
  };
}

export function buildAudioCueTempPaths(id: string, fileName: string): { inputPath: string; outputPath: string } {
  const rawExtension = path.extname(fileName || "");
  const extension = /^\.[a-z0-9]+$/i.test(rawExtension) ? rawExtension : ".bin";
  const basePath = path.join(tmpdir(), `babel-audio-cue-${id}`);
  return {
    inputPath: `${basePath}.input${extension}`,
    outputPath: `${basePath}.output.wav`
  };
}

export function buildAudioCueBatchTempPaths(
  id: string,
  fileName: string,
  outputCount: number
): { inputPath: string; outputPaths: string[] } {
  const rawExtension = path.extname(fileName || "");
  const extension = /^\.[a-z0-9]+$/i.test(rawExtension) ? rawExtension : ".bin";
  const basePath = path.join(tmpdir(), `babel-audio-cue-${id}`);
  return {
    inputPath: `${basePath}.input${extension}`,
    outputPaths: Array.from({ length: outputCount }, (_, index) => `${basePath}.output-${index}.wav`)
  };
}

function formatFfmpegSeconds(value: number): string {
  return Number(value.toFixed(6)).toString();
}

function getAudioSliceRange(
  row: DraftingTranscriptRowInput,
  trackDurationSeconds?: number | null
): { start: number; duration: number; truncatedAtEnd: boolean } | null {
  if (row.startSeconds === null || row.endSeconds === null || row.endSeconds <= row.startSeconds) {
    throw new Error("missing_row_timing");
  }

  const start = Math.max(0, row.startSeconds - AUDIO_PADDING_SECONDS);
  const requestedEnd = row.endSeconds + AUDIO_PADDING_SECONDS;
  const hasTrackDuration = typeof trackDurationSeconds === "number" && Number.isFinite(trackDurationSeconds);
  const end = hasTrackDuration ? Math.min(requestedEnd, trackDurationSeconds) : requestedEnd;
  const duration = end - start;
  const truncatedAtEnd = hasTrackDuration && requestedEnd > trackDurationSeconds;

  if (hasTrackDuration && duration < MIN_AUDIO_SLICE_SECONDS) {
    return null;
  }

  return {
    start,
    duration: hasTrackDuration ? duration : Math.max(MIN_AUDIO_SLICE_SECONDS, duration),
    truncatedAtEnd
  };
}

export function buildAudioCueBatchPlan(
  slices: Array<{ row: DraftingTranscriptRowInput; outputPath: string }>,
  trackDurationSeconds?: number | null
): { slices: AudioCueBatchSlice[]; skippedRows: DraftingTranscriptRowInput[] } {
  const plannedSlices: AudioCueBatchSlice[] = [];
  const skippedRows: DraftingTranscriptRowInput[] = [];

  for (const slice of slices) {
    const range = getAudioSliceRange(slice.row, trackDurationSeconds);
    if (!range) {
      skippedRows.push(slice.row);
      continue;
    }
    plannedSlices.push({
      ...slice,
      range
    });
  }

  return {
    slices: plannedSlices,
    skippedRows
  };
}

export function buildAudioCueBatchFfmpegArgs(
  inputPath: string,
  slices: AudioCueBatchSlice[] | Array<{ row: DraftingTranscriptRowInput; outputPath: string }>
): string[] {
  const filterGraph = slices
    .map((slice, index) => {
      const range = "range" in slice ? slice.range : getAudioSliceRange(slice.row);
      if (!range) {
        throw new Error(`audio_out_of_range:${slice.row.startSeconds}-${slice.row.endSeconds}`);
      }
      return `${[
        `[0:a]atrim=start=${formatFfmpegSeconds(range.start)}:duration=${formatFfmpegSeconds(range.duration)}`,
        "asetpts=PTS-STARTPTS",
        "aformat=channel_layouts=mono:sample_rates=24000"
      ].join(",")}[out${index}]`;
    })
    .join(";");

  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    "-filter_complex",
    filterGraph,
    ...slices.flatMap(({ outputPath }, index) => ["-map", `[out${index}]`, "-f", "wav", outputPath])
  ];
}

export async function sliceAudioTrackForRow({ track, row }: SliceAudioArgs): Promise<AudioCueClipInput> {
  const id = randomUUID();
  const { inputPath, outputPath } = buildAudioCueTempPaths(id, track.fileName);
  const range = getAudioSliceRange(row);
  if (!range) {
    throw new Error(`audio_out_of_range:${row.startSeconds}-${row.endSeconds}`);
  }

  try {
    await writeFile(inputPath, Buffer.from(track.bytes));
    await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      String(range.start),
      "-i",
      inputPath,
      "-t",
      String(range.duration),
      "-ac",
      "1",
      "-ar",
      "24000",
      "-f",
      "wav",
      outputPath
    ]);
    const wav = await readFile(outputPath);
    return {
      trackId: track.trackId,
      speakerKey: track.speakerKey,
      trackLabel: track.trackLabel,
      clipStartSeconds: range.start,
      clipEndSeconds: range.start + range.duration,
      truncatedAtEnd: range.truncatedAtEnd,
      format: "wav",
      base64: wav.toString("base64")
    };
  } finally {
    await Promise.allSettled([unlink(inputPath), unlink(outputPath)]);
  }
}

function appendMapValue<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const current = map.get(key) || [];
  current.push(value);
  map.set(key, current);
}

async function probeAudioDurationSeconds(inputPath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputPath
    ]);
    const duration = Number(stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    return null;
  }
}

async function sliceAudioTrackForRows(
  track: AudioCueAudioTrackInput,
  rows: DraftingTranscriptRowInput[]
): Promise<Array<{ rowId: string; clip: AudioCueClipInput }>> {
  const id = randomUUID();
  const { inputPath, outputPaths } = buildAudioCueBatchTempPaths(id, track.fileName, rows.length);
  const slices = rows.map((row, index) => ({
    row,
    outputPath: outputPaths[index]!
  }));

  try {
    await writeFile(inputPath, Buffer.from(track.bytes));
    const trackDurationSeconds = await probeAudioDurationSeconds(inputPath);
    const plan = buildAudioCueBatchPlan(slices, trackDurationSeconds);
    if (!plan.slices.length) {
      return [];
    }
    await execFileAsync("ffmpeg", buildAudioCueBatchFfmpegArgs(inputPath, plan.slices));
    return await Promise.all(
      plan.slices.map(async ({ row, outputPath, range }) => {
        const wav = await readFile(outputPath);
        return {
          rowId: row.rowId,
          clip: {
            trackId: track.trackId,
            speakerKey: track.speakerKey,
            trackLabel: track.trackLabel,
            clipStartSeconds: range.start,
            clipEndSeconds: range.start + range.duration,
            truncatedAtEnd: range.truncatedAtEnd,
            format: "wav",
            base64: wav.toString("base64")
          }
        };
      })
    );
  } finally {
    await Promise.allSettled([unlink(inputPath), ...outputPaths.map((outputPath) => unlink(outputPath))]);
  }
}

function taskGroupKey(task: SliceAudioBatchTask, index: number): string {
  return task.track.trackId || `${task.track.fileName}:${index}`;
}

export async function sliceAudioTracksForRows({ tasks }: SliceAudioBatchArgs): Promise<SliceAudioBatchResult> {
  const clipsByRowId = new Map<string, AudioCueClipInput[]>();
  const errorsByRowId = new Map<string, string[]>();
  const groups = new Map<
    string,
    { track: AudioCueAudioTrackInput; rows: DraftingTranscriptRowInput[]; rowIds: Set<string> }
  >();

  for (const [index, task] of tasks.entries()) {
    const key = taskGroupKey(task, index);
    const group = groups.get(key) || { track: task.track, rows: [], rowIds: new Set<string>() };
    if (!group.rowIds.has(task.row.rowId)) {
      group.rows.push(task.row);
      group.rowIds.add(task.row.rowId);
    }
    groups.set(key, group);
  }

  await Promise.all(
    Array.from(groups.values()).map(async ({ track, rows }) => {
      try {
        const clips = await sliceAudioTrackForRows(track, rows);
        const clippedRowIds = new Set(clips.map(({ rowId }) => rowId));
        for (const { rowId, clip } of clips) {
          appendMapValue(clipsByRowId, rowId, clip);
        }
        for (const row of rows) {
          if (!clippedRowIds.has(row.rowId)) {
            appendMapValue(errorsByRowId, row.rowId, `audio_out_of_range:${row.startSeconds}-${row.endSeconds}`);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const row of rows) {
          appendMapValue(errorsByRowId, row.rowId, message);
        }
      }
    })
  );

  return { clipsByRowId, errorsByRowId };
}

function normalizeSpeakerKey(value: string | undefined): string {
  const text = typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
  if (!text) {
    return "";
  }

  const speakerMatch = text.match(/\b(?:speaker|spk|sp)\s*[-_ ]?\s*(\d+)\b/u);
  if (speakerMatch) {
    return `speaker-${speakerMatch[1]}`;
  }

  return text.replace(/[^a-z0-9а-яё]+/giu, "-").replace(/^-+|-+$/gu, "");
}

function trackSpeakerKeys(track: AudioCueAudioTrackInput): Set<string> {
  if (!track.speakerKey && !track.trackLabel) {
    return new Set();
  }

  return new Set(
    [track.speakerKey, track.trackLabel, track.trackId]
      .map((value) => normalizeSpeakerKey(value))
      .filter(Boolean)
  );
}

export function selectAudioTracksForRow(
  tracks: AudioCueAudioTrackInput[],
  row: DraftingTranscriptRowInput
): AudioCueAudioTrackInput[] {
  const mappedTracks = tracks.filter((track) => trackSpeakerKeys(track).size);
  if (!mappedTracks.length) {
    return tracks;
  }

  const rowSpeaker = normalizeSpeakerKey(row.speakerKey);
  return mappedTracks.filter((track) => trackSpeakerKeys(track).has(rowSpeaker));
}

function buildAudioCueSystemPrompt(tagSystem: string): string {
  return [
    "You add audible-cue tags to one human-written Russian transcript row.",
    "The row text is the source of truth. Do not delete, replace, reorder, translate, or paraphrase any words.",
    "Only add tags for audible events, vocal styles, emotion, or background sounds that are clear in the supplied audio clips.",
    "Use only exact tags from the tag system below. Preserve existing tags literally.",
    "If there is no clear useful audio cue, return the original row text unchanged.",
    "Return JSON only, with this shape: {\"rewrittenText\":\"...\"}",
    "",
    "Tag system:",
    tagSystem
  ].join("\n");
}

function buildAudioCueUserPrompt(context: AudioCueRewriteContext): string {
  return [
    `Row ${context.currentRow.index + 1}`,
    `Speaker key: ${context.currentRow.speakerKey}`,
    `Time range: ${context.currentRow.startSeconds ?? "unknown"}-${context.currentRow.endSeconds ?? "unknown"}s`,
    `Human row text: ${JSON.stringify(context.currentRow.text)}`,
    `Audio clips: ${context.audioClips
      .map((clip) => `${clip.trackId}${clip.speakerKey ? ` speaker=${clip.speakerKey}` : ""}${clip.trackLabel ? ` label=${clip.trackLabel}` : ""}`)
      .join(", ")}`
  ].join("\n");
}

function buildAudioCuePrompt(context: AudioCueRewriteContext): string {
  return [buildAudioCueSystemPrompt(context.tagSystem), "", buildAudioCueUserPrompt(context)].join("\n");
}

async function defaultRewriteRowWithAudio(
  context: AudioCueRewriteContext,
  options: { apiKey: string; model: string; serviceTier: AudioCueDraftRequest["serviceTier"] }
): Promise<string> {
  const useGeminiPromptCaching = shouldUseGeminiPromptCaching(options.model);
  const content = [
    {
      type: "text" as const,
      text: useGeminiPromptCaching ? buildAudioCueUserPrompt(context) : buildAudioCuePrompt(context)
    },
    ...context.audioClips.flatMap((clip, index) => [
      {
        type: "text" as const,
        text: `Audio clip ${index + 1}: trackId=${clip.trackId}${
          clip.speakerKey ? `, speakerKey=${clip.speakerKey}` : ""
        }${clip.trackLabel ? `, trackLabel=${clip.trackLabel}` : ""}.`
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

  const response = await requestOpenRouterChat({
    apiKey: options.apiKey,
    model: options.model,
    messages: useGeminiPromptCaching
      ? [
        { role: "system", content: [buildCachedOpenRouterTextContent(buildAudioCueSystemPrompt(context.tagSystem))] },
        { role: "user", content }
      ]
      : [{ role: "user", content }],
    serviceTier: options.serviceTier,
    temperature: 0,
    title: "Babel Audio Cues"
  });

  return parseResponseText(response);
}

export async function generateAudioCueDraft(
  request: AudioCueDraftRequest,
  deps: GenerateAudioCueDraftDeps = {}
): Promise<GenerateDraftResponse> {
  if (!request.audioTracks.length) {
    throw new Error("At least one audio track is required.");
  }

  const requestedApiKey = typeof request.openRouterApiKey === "string" ? request.openRouterApiKey.trim() : "";
  const apiKey = deps.apiKey ?? requestedApiKey;
  if (!apiKey) {
    throw new Error("openRouterApiKey is required.");
  }

  const model = getAudioCueModel(request, deps);
  const serviceTier = normalizeServiceTier(request.serviceTier);
  await (deps.validateAudioModel ?? assertOpenRouterModelSupportsAudio)(model);

  const tagSystem = await loadAudioCueTagSystem();
  const allowedTags = await loadAllowedTags();
  const sliceAudio = deps.sliceAudio ?? sliceAudioTrackForRow;
  const rewriteRowWithAudio =
    deps.rewriteRowWithAudio ??
    ((context: AudioCueRewriteContext) =>
      defaultRewriteRowWithAudio(context, {
        apiKey,
        model,
        serviceTier
      }));

  const draftRows: Array<DraftRowResult | undefined> = new Array(request.rows.length);
  let completedRowCount = 0;

  await Promise.all(
    request.rows.map(async (currentRow, index) => {
      let rowResult: DraftRowResult;

      try {
        if (currentRow.startSeconds === null || currentRow.endSeconds === null) {
          throw new Error("missing_row_timing");
        }
        const selectedTracks = selectAudioTracksForRow(request.audioTracks, currentRow);
        if (!selectedTracks.length) {
          throw new Error(`missing_speaker_audio:${currentRow.speakerKey}`);
        }
        const audioClips = await Promise.all(
          selectedTracks.map(async (track) => {
            const clip = await sliceAudio({
              track,
              row: currentRow
            });
            return {
              ...clip,
              trackId: track.trackId,
              speakerKey: track.speakerKey,
              trackLabel: track.trackLabel
            };
          })
        );
        const candidate = await rewriteRowWithAudio({
          currentRow,
          audioClips,
          tagSystem
        });
        const validation = validateAudioCueOutput(currentRow.text, candidate, allowedTags);
        rowResult = {
          rowId: currentRow.rowId,
          rewrittenText: validation.row.rewrittenText,
          status: validation.row.status,
          warnings: validation.row.warnings
        };
      } catch (error) {
        rowResult = {
          rowId: currentRow.rowId,
          rewrittenText: currentRow.text,
          status: "failed",
          warnings: [error instanceof Error ? error.message : String(error)]
        };
      }

      draftRows[index] = rowResult;
      completedRowCount += 1;
      if (deps.onRowComplete) {
        await deps.onRowComplete({
          row: rowResult,
          completedRows: completedRowCount,
          totalRows: request.rows.length,
          summary: summarizeCompletedDraftRows(draftRows)
        });
      }
    })
  );

  const completedDraftRows = draftRows.filter((row): row is DraftRowResult => Boolean(row));
  return {
    draftRows: completedDraftRows,
    summary: summarizeDraftRows(completedDraftRows),
    generationMeta: {
      model,
      rulePackVersion: "audio-cues-v1",
      generatedAt: new Date().toISOString()
    }
  };
}
