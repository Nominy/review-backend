import type { Elysia } from "elysia";
import { config } from "../../config";
import { isObject } from "../../shared/http";
import { assertOpenRouterModelExists, assertOpenRouterModelSupportsAudio } from "../../shared/openrouter-client";
import { generateDraft } from "./service";
import type {
  AudioCueAudioTrackInput,
  DraftingTranscriptRowInput,
  GenerateDraftRequest
} from "./types";

type AnyElysia = Elysia<any, any, any, any, any, any, any>;
const encoder = new TextEncoder();

function toSseChunk(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function isRow(value: unknown): value is DraftingTranscriptRowInput {
  return (
    isObject(value) &&
    typeof value.rowId === "string" &&
    typeof value.speakerKey === "string" &&
    typeof value.text === "string" &&
    Number.isInteger(value.index)
  );
}

function assertGenerateDraftBody(body: unknown): asserts body is GenerateDraftRequest {
  if (!isObject(body)) {
    throw new Error("Body must be an object.");
  }

  if (body.projectPreset !== "ru-gold-2sp-v1") {
    throw new Error("projectPreset must be ru-gold-2sp-v1.");
  }

  if (typeof body.jobId !== "string" || !body.jobId.trim()) {
    throw new Error("jobId is required.");
  }

  if (!Array.isArray(body.rows) || !body.rows.every(isRow)) {
    throw new Error("rows must be a valid transcript row array.");
  }

  if (typeof body.openRouterApiKey !== "string" || !body.openRouterApiKey.trim()) {
    throw new Error("openRouterApiKey is required.");
  }

  if ("model" in body && body.model !== undefined && body.model !== null && typeof body.model !== "string") {
    throw new Error("model must be a string when provided.");
  }
}

type GenerateDraftParsedBody = {
  request: GenerateDraftRequest;
  audioTracks: AudioCueAudioTrackInput[];
};

function parseAudioTrackMeta(value: unknown): { speakerKey?: string; trackLabel?: string } {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!isObject(parsed)) {
    return {};
  }

  const speakerKey = typeof parsed.speakerKey === "string" ? parsed.speakerKey.trim() : "";
  const trackLabel = typeof parsed.trackLabel === "string" ? parsed.trackLabel.trim() : "";
  return {
    ...(speakerKey ? { speakerKey } : {}),
    ...(trackLabel ? { trackLabel } : {})
  };
}

async function bodyToGenerateDraftRequest(body: unknown): Promise<GenerateDraftParsedBody> {
  if (!isObject(body)) {
    throw new Error("Body must be an object.");
  }

  if (!("payload" in body)) {
    assertGenerateDraftBody(body);
    return {
      request: body,
      audioTracks: []
    };
  }

  const rawPayload = body.payload;
  const payload = typeof rawPayload === "string" ? (JSON.parse(rawPayload) as unknown) : rawPayload;
  assertGenerateDraftBody(payload);

  const audioTracks: AudioCueAudioTrackInput[] = [];
  const audioTrackMetaById = new Map<string, { speakerKey?: string; trackLabel?: string }>();
  for (const [key, value] of Object.entries(body)) {
    if (!key.startsWith("audioTrackMeta:")) {
      continue;
    }
    const trackId = key.split(":").slice(1).join(":");
    if (!trackId) {
      continue;
    }
    audioTrackMetaById.set(trackId, parseAudioTrackMeta(value));
  }

  for (const [key, value] of Object.entries(body)) {
    if (!key.startsWith("audioTrack:")) {
      continue;
    }
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (!(item instanceof File)) {
        continue;
      }
      const trackId = key.split(":").slice(1).join(":") || `audio-${audioTracks.length + 1}`;
      const meta = audioTrackMetaById.get(trackId) || {};
      audioTracks.push({
        trackId,
        ...meta,
        fileName: item.name || `${key}.bin`,
        mimeType: item.type || "application/octet-stream",
        bytes: new Uint8Array(await item.arrayBuffer())
      });
    }
  }

  if (process.env.DEBUG_AUDIO_CUES === "1") {
    console.log(
      "[draft] parsed request",
      JSON.stringify({
        jobId: payload.jobId,
        model: payload.model || "(default)",
        rows: payload.rows.length,
        audioTracks: audioTracks.map((track) => ({
          trackId: track.trackId,
          speakerKey: track.speakerKey,
          trackLabel: track.trackLabel,
          fileName: track.fileName,
          mimeType: track.mimeType,
          bytes: track.bytes.byteLength
        }))
      })
    );
  }

  return {
    request: payload,
    audioTracks
  };
}

function resolveDraftingModel(body: GenerateDraftRequest): string {
  return typeof body.model === "string" && body.model.trim() ? body.model.trim() : config.openRouterModel;
}

function getErrorStatus(message: string): number {
  return message.includes("required") ||
    message.includes("must") ||
    message.includes("Body") ||
    message.includes("does not exist") ||
    message.includes("does not support audio input")
    ? 400
    : 500;
}

async function validateRequestedModel(request: GenerateDraftRequest, audioTracks: AudioCueAudioTrackInput[]): Promise<void> {
  const model = resolveDraftingModel(request);
  if (audioTracks.length) {
    await assertOpenRouterModelSupportsAudio(model);
    return;
  }
  await assertOpenRouterModelExists(model);
}

export function registerDraftingRoutes(app: AnyElysia): AnyElysia {
  app.post("/api/draft/generate", async ({ body, set }) => {
    if (process.env.DEBUG_AUDIO_CUES === "1") {
      console.log("[draft] generate request");
    }
    try {
      const { request, audioTracks } = await bodyToGenerateDraftRequest(body);
      await validateRequestedModel(request, audioTracks);
      return await generateDraft(request, {
        validateModel: async () => {},
        validateAudioModel: async () => {},
        audioTracks
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set.status = getErrorStatus(message);
      return { error: message };
    }
  });

  app.post("/api/draft/generate/stream", async ({ body, set }) => {
    if (process.env.DEBUG_AUDIO_CUES === "1") {
      console.log("[draft] generate/stream request");
    }
    let request: GenerateDraftRequest;
    let audioTracks: AudioCueAudioTrackInput[];
    try {
      const parsed = await bodyToGenerateDraftRequest(body);
      request = parsed.request;
      audioTracks = parsed.audioTracks;
      await validateRequestedModel(request, audioTracks);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set.status = getErrorStatus(message);
      return { error: message };
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(
          toSseChunk("started", {
            jobId: request.jobId,
            totalRows: request.rows.length
          })
        );

        try {
          const response = await generateDraft(request, {
            validateModel: async () => {},
            validateAudioModel: async () => {},
            audioTracks,
            onRowComplete: async ({ row, completedRows, totalRows, summary }) => {
              controller.enqueue(
                toSseChunk("row", {
                  row,
                  completedRows,
                  totalRows,
                  summary
                })
              );
            }
          });

          controller.enqueue(toSseChunk("done", response));
          if (process.env.DEBUG_AUDIO_CUES === "1") {
            console.log(
              "[draft] done",
              JSON.stringify({
                totalRows: response.summary.totalRows,
                rewrittenRows: response.summary.rewrittenRows,
                unchangedRows: response.summary.unchangedRows,
                failedRows: response.summary.failedRows
              })
            );
          }
        } catch (error) {
          if (process.env.DEBUG_AUDIO_CUES === "1") {
            console.log(
              "[draft] error",
              JSON.stringify({
                error: error instanceof Error ? error.message : String(error)
              })
            );
          }
          controller.enqueue(
            toSseChunk("error", {
              error: error instanceof Error ? error.message : String(error)
            })
          );
        } finally {
          controller.close();
        }
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive"
      }
    });
  });

  return app;
}
