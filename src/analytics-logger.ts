import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { NormalizedState, PreparedPayload } from "./types";

type AnalyticsEventType = "review_generate" | "submit_transcript_review_action";

type ReviewAnalyticsLogEntry = {
  loggedAt: string;
  eventType: AnalyticsEventType;
  reviewActionId: string;
  originalCapturedAt: string;
  currentCapturedAt: string;
  originalText: string;
  currentText: string;
  original: NormalizedState;
  current: NormalizedState;
  metricsAnalysis: {
    stats: Record<string, unknown>;
    featurePacket: Record<string, unknown>;
  };
  aiReview: unknown;
  inputBoxes: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

function stateToText(state: NormalizedState): string {
  if (!Array.isArray(state.annotations) || state.annotations.length === 0) {
    return "";
  }

  const ordered = [...state.annotations].sort((a, b) => {
    if (a.startTimeInSeconds !== b.startTimeInSeconds) {
      return a.startTimeInSeconds - b.startTimeInSeconds;
    }
    return a.id.localeCompare(b.id);
  });

  return ordered.map((annotation) => annotation.content || "").join("\n").trim();
}

export async function logReviewAnalytics(input: {
  eventType: AnalyticsEventType;
  reviewActionId: string;
  original: NormalizedState;
  current: NormalizedState;
  prepared: PreparedPayload;
  aiReview?: unknown;
  inputBoxes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  logPath: string;
}): Promise<void> {
  const entry: ReviewAnalyticsLogEntry = {
    loggedAt: new Date().toISOString(),
    eventType: input.eventType,
    reviewActionId: input.reviewActionId,
    originalCapturedAt: input.original.capturedAt || "",
    currentCapturedAt: input.current.capturedAt || "",
    originalText: stateToText(input.original),
    currentText: stateToText(input.current),
    original: input.original,
    current: input.current,
    metricsAnalysis: {
      stats: input.prepared.stats,
      featurePacket: input.prepared.featurePacket
    },
    aiReview: input.aiReview ?? null,
    inputBoxes: input.inputBoxes ?? {},
    metadata: input.metadata ?? {}
  };

  await mkdir(dirname(input.logPath), { recursive: true });
  await appendFile(input.logPath, `${JSON.stringify(entry)}\n`, "utf8");
}
