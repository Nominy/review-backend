import type { Elysia } from "elysia";
import { isObject } from "../../shared/http";
import { reviewRedistributionsWithModel, transcribeSegmentWithModel } from "./broker-service";
import type {
  AudioCueAudioTrackInput,
  BrokerRedistributeTextRequest,
  BrokerTranscribeSegmentRequest
} from "./types";

type AnyElysia = Elysia<any, any, any, any, any, any, any>;
const SUPPORTED_REASONING_EFFORTS = new Set(["default", "none", "minimal", "low", "medium", "high", "xhigh"]);

function getErrorStatus(message: string): number {
  return message.includes("required") ||
    message.includes("must") ||
    message.includes("missing_speaker_audio") ||
    message.includes("does not exist") ||
    message.includes("does not support audio input")
    ? 400
    : 500;
}

function assertCommonBrokerFields(body: Record<string, unknown>): void {
  if (typeof body.openRouterApiKey !== "string" || !body.openRouterApiKey.trim()) {
    throw new Error("openRouterApiKey is required.");
  }

  if ("model" in body && body.model !== undefined && body.model !== null && typeof body.model !== "string") {
    throw new Error("model must be a string when provided.");
  }

  if (
    "serviceTier" in body &&
    body.serviceTier !== undefined &&
    body.serviceTier !== null &&
    body.serviceTier !== "default" &&
    body.serviceTier !== "flex" &&
    body.serviceTier !== "priority"
  ) {
    throw new Error("serviceTier must be default, flex, or priority when provided.");
  }

  if (
    "reasoningEffort" in body &&
    body.reasoningEffort !== undefined &&
    body.reasoningEffort !== null &&
    (typeof body.reasoningEffort !== "string" || !SUPPORTED_REASONING_EFFORTS.has(body.reasoningEffort))
  ) {
    throw new Error("reasoningEffort must be default, none, minimal, low, medium, high, or xhigh when provided.");
  }
}

function assertTranscribeSegmentBody(body: unknown): asserts body is BrokerTranscribeSegmentRequest {
  if (!isObject(body)) {
    throw new Error("Body must be an object.");
  }
  assertCommonBrokerFields(body);

  if (!isObject(body.segment)) {
    throw new Error("segment is required.");
  }

  if (typeof body.segment.rowId !== "string" || !body.segment.rowId.trim()) {
    throw new Error("segment.rowId is required.");
  }
  if (typeof body.segment.speakerKey !== "string" || !body.segment.speakerKey.trim()) {
    throw new Error("segment.speakerKey is required.");
  }
  if (!Number.isFinite(body.segment.startSeconds) || !Number.isFinite(body.segment.endSeconds)) {
    throw new Error("segment startSeconds and endSeconds must be numbers.");
  }
}

function isRedistributionSegment(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    Number.isInteger(value.index) &&
    typeof value.speakerKey === "string" &&
    typeof value.text === "string"
  );
}

function isRedistributionAllocation(value: unknown): boolean {
  return isObject(value) && typeof value.segmentId === "string" && typeof value.text === "string";
}

function assertRedistributionGroup(group: unknown): void {
  if (!isObject(group)) {
    throw new Error("group is required.");
  }
  if (typeof group.groupId !== "string" || !group.groupId.trim()) {
    throw new Error("group.groupId is required.");
  }
  if (typeof group.speakerKey !== "string" || typeof group.fullText !== "string") {
    throw new Error("group speakerKey and fullText are required.");
  }
  if (!Array.isArray(group.segments) || !group.segments.every(isRedistributionSegment)) {
    throw new Error("group.segments must be a valid segment array.");
  }
  if (!Array.isArray(group.draftAllocations) || !group.draftAllocations.every(isRedistributionAllocation)) {
    throw new Error("group.draftAllocations must be a valid allocation array.");
  }
}

function assertRedistributeTextBody(body: unknown): asserts body is BrokerRedistributeTextRequest {
  if (!isObject(body)) {
    throw new Error("Body must be an object.");
  }
  assertCommonBrokerFields(body);
  if (!Array.isArray(body.groups) || !body.groups.length) {
    throw new Error("groups must be a non-empty valid group array.");
  }
  for (const group of body.groups) {
    assertRedistributionGroup(group);
  }
}

function parseAudioTrackMeta(value: unknown): { speakerKey?: string; trackLabel?: string } {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!isObject(parsed)) {
    return {};
  }
  return {
    ...(typeof parsed.speakerKey === "string" && parsed.speakerKey.trim() ? { speakerKey: parsed.speakerKey.trim() } : {}),
    ...(typeof parsed.trackLabel === "string" && parsed.trackLabel.trim() ? { trackLabel: parsed.trackLabel.trim() } : {})
  };
}

async function parseBrokerPayload<T>(
  body: unknown,
  assertBody: (payload: unknown) => asserts payload is T
): Promise<{ request: T; audioTracks: AudioCueAudioTrackInput[] }> {
  if (!isObject(body)) {
    throw new Error("Body must be an object.");
  }

  if (!("payload" in body)) {
    assertBody(body);
    return { request: body, audioTracks: [] };
  }

  const payload = typeof body.payload === "string" ? (JSON.parse(body.payload) as unknown) : body.payload;
  assertBody(payload);

  const audioTrackMetaById = new Map<string, { speakerKey?: string; trackLabel?: string }>();
  for (const [key, value] of Object.entries(body)) {
    if (!key.startsWith("audioTrackMeta:")) {
      continue;
    }
    const trackId = key.split(":").slice(1).join(":");
    if (trackId) {
      audioTrackMetaById.set(trackId, parseAudioTrackMeta(value));
    }
  }

  const audioTracks: AudioCueAudioTrackInput[] = [];
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
      audioTracks.push({
        trackId,
        ...(audioTrackMetaById.get(trackId) || {}),
        fileName: item.name || `${key}.bin`,
        mimeType: item.type || "application/octet-stream",
        bytes: new Uint8Array(await item.arrayBuffer())
      });
    }
  }

  return { request: payload, audioTracks };
}

export function registerBrokerRoutes(app: AnyElysia): void {
  app.post("/api/broker/transcribe-segment", async ({ body, set }) => {
    try {
      const { request, audioTracks } = await parseBrokerPayload(body, assertTranscribeSegmentBody);
      return await transcribeSegmentWithModel(request, { audioTracks });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set.status = getErrorStatus(message);
      return { error: message };
    }
  });

  app.post("/api/broker/redistribute-text", async ({ body, set }) => {
    try {
      const { request } = await parseBrokerPayload(body, assertRedistributeTextBody);
      return await reviewRedistributionsWithModel(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set.status = getErrorStatus(message);
      return { error: message };
    }
  });
}
