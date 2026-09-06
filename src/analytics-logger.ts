import type { AnalyticsEventType, BabelDiffPayload, NormalizedState, PreparedPayload } from "./types";
import { writeStructuredLog } from "./structured-logger";
import { isObject } from "./shared/http";

type ReviewAnalyticsLogEntry = {
  logType: "review_analytics";
  loggedAt: string;
  eventType: AnalyticsEventType;
  reviewActionId: string;
  originalCapturedAt: string;
  currentCapturedAt: string;
  originalText: string;
  currentText: string;
  original: NormalizedState;
  current: NormalizedState;
  babelDiff?: BabelDiffPayload | null;
  metricsAnalysis: {
    stats: Record<string, unknown>;
    featurePacket: Record<string, unknown>;
    promptPacket: Record<string, unknown>;
    metricsVersion: string;
    promptVersion: string;
    promptInputChars: number;
    templateRegistryVersion: string | null;
    matchedTemplateIds: string[];
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

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractTemplateMetadata(aiReview: unknown): {
  templateRegistryVersion: string | null;
  matchedTemplateIds: string[];
} {
  if (!isObject(aiReview)) {
    return {
      templateRegistryVersion: null,
      matchedTemplateIds: []
    };
  }

  return {
    templateRegistryVersion:
      typeof aiReview.templateRegistryVersion === "string"
        ? aiReview.templateRegistryVersion
        : null,
    matchedTemplateIds: toStringArray(aiReview.matchedTemplateIds)
  };
}

export async function logReviewAnalytics(input: {
  eventType: AnalyticsEventType;
  reviewActionId: string;
  original: NormalizedState;
  current: NormalizedState;
  babelDiff?: BabelDiffPayload | null;
  prepared: PreparedPayload;
  aiReview?: unknown;
  inputBoxes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const templateMetadata = extractTemplateMetadata(input.aiReview);

  const entry: ReviewAnalyticsLogEntry = {
    logType: "review_analytics",
    loggedAt: new Date().toISOString(),
    eventType: input.eventType,
    reviewActionId: input.reviewActionId,
    originalCapturedAt: input.original.capturedAt || "",
    currentCapturedAt: input.current.capturedAt || "",
    originalText: stateToText(input.original),
    currentText: stateToText(input.current),
    original: input.original,
    current: input.current,
    ...(input.babelDiff ? { babelDiff: input.babelDiff } : {}),
    metricsAnalysis: {
      stats: input.prepared.stats,
      featurePacket: input.prepared.featurePacket,
      promptPacket: input.prepared.promptPacket,
      metricsVersion: input.prepared.metricsVersion,
      promptVersion: input.prepared.promptVersion,
      promptInputChars: input.prepared.prompts.systemPrompt.length + input.prepared.prompts.userPrompt.length,
      templateRegistryVersion: templateMetadata.templateRegistryVersion,
      matchedTemplateIds: templateMetadata.matchedTemplateIds
    },
    aiReview: input.aiReview ?? null,
    inputBoxes: input.inputBoxes ?? {},
    metadata: input.metadata ?? {}
  };

  writeStructuredLog(entry);
}
