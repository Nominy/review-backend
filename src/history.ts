import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildPreparedPayload } from "./service";
import type { AnalyticsEventType, BabelDiffPayload, NormalizedState } from "./types";

type HistoryMetricsAnalysis = {
  stats?: Record<string, unknown>;
  featurePacket?: Record<string, unknown>;
  promptPacket?: Record<string, unknown>;
  metricsVersion?: string;
  promptVersion?: string;
  promptInputChars?: number;
  templateRegistryVersion?: string | null;
  matchedTemplateIds?: string[];
};

type RawHistoryEntry = {
  loggedAt?: string;
  eventType?: AnalyticsEventType;
  reviewActionId?: string;
  original?: NormalizedState;
  current?: NormalizedState;
  babelDiff?: BabelDiffPayload;
  originalText?: string;
  currentText?: string;
  aiReview?: unknown;
  metadata?: Record<string, unknown>;
  metricsAnalysis?: HistoryMetricsAnalysis;
};

export type ReviewHistorySummary = {
  historyId: string;
  loggedAt: string;
  eventType: AnalyticsEventType;
  reviewActionId: string;
  originalSegments: number;
  currentSegments: number;
  textDiffCount: number;
  timingDiffCount: number;
  unmatchedOriginalCount: number;
  unmatchedCurrentCount: number;
  matchedTemplateIds: string[];
  feedbackCount: number;
  model: string | null;
};

export type ReviewHistoryDetail = {
  historyId: string;
  loggedAt: string;
  eventType: AnalyticsEventType;
  reviewActionId: string;
  original: NormalizedState;
  current: NormalizedState;
  babelDiff?: BabelDiffPayload;
  originalText: string;
  currentText: string;
  aiReview: unknown;
  metadata: Record<string, unknown>;
  metricsAnalysis: HistoryMetricsAnalysis;
  reconstructedPrepared: ReturnType<typeof buildPreparedPayload>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNormalizedState(value: unknown): value is NormalizedState {
  return (
    isObject(value) &&
    typeof value.actionId === "string" &&
    Array.isArray(value.annotations) &&
    Array.isArray(value.recordings) &&
    Array.isArray(value.lintErrors)
  );
}

function toEventType(value: unknown): AnalyticsEventType | null {
  const normalized = typeof value === "string" ? value : "";
  switch (normalized) {
    case "review_generate":
    case "submit_transcript_review_action":
    case "review_session_created":
    case "review_session_opened":
    case "review_card_commented":
    case "template_suggestions_generated":
    case "template_suggestion_approved":
    case "template_suggestion_rejected":
    case "interactive_session_skipped":
    case "interactive_review_applied":
      return normalized;
    default:
      return null;
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && !!item.trim());
}

function buildHistoryId(lineNumber: number): string {
  return String(lineNumber);
}

function parseHistoryId(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("Invalid history ID.");
  }
  return parsed;
}

function parseHistoryEntry(line: string): RawHistoryEntry | null {
  const trimmed = String(line || "").trim();
  if (!trimmed) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!isObject(parsed)) {
    return null;
  }

  const eventType = toEventType(parsed.eventType);
  const reviewActionId = typeof parsed.reviewActionId === "string" ? parsed.reviewActionId.trim() : "";
  const original = isNormalizedState(parsed.original) ? parsed.original : null;
  const current = isNormalizedState(parsed.current) ? parsed.current : null;
  if (!eventType || !reviewActionId || !original || !current) {
    return null;
  }

  return {
    loggedAt: typeof parsed.loggedAt === "string" ? parsed.loggedAt : "",
    eventType,
    reviewActionId,
    original,
    current,
    babelDiff: isObject(parsed.babelDiff) ? (parsed.babelDiff as BabelDiffPayload) : undefined,
    originalText: typeof parsed.originalText === "string" ? parsed.originalText : "",
    currentText: typeof parsed.currentText === "string" ? parsed.currentText : "",
    aiReview: "aiReview" in parsed ? parsed.aiReview : null,
    metadata: isObject(parsed.metadata) ? parsed.metadata : {},
    metricsAnalysis: isObject(parsed.metricsAnalysis)
      ? (parsed.metricsAnalysis as HistoryMetricsAnalysis)
      : {}
  };
}

async function readHistoryLines(logPath: string): Promise<string[]> {
  const resolved = resolve(logPath);
  try {
    const content = await readFile(resolved, "utf8");
    return content.split(/\r?\n/);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
}

function summarizeEntry(entry: RawHistoryEntry, lineNumber: number): ReviewHistorySummary {
  const overview = isObject(entry.metricsAnalysis?.promptPacket?.overview)
    ? (entry.metricsAnalysis?.promptPacket?.overview as Record<string, unknown>)
    : {};
  const aiReview = isObject(entry.aiReview) ? entry.aiReview : {};
  const feedback = Array.isArray(aiReview.feedback) ? aiReview.feedback : [];

  return {
    historyId: buildHistoryId(lineNumber),
    loggedAt: entry.loggedAt || "",
    eventType: entry.eventType || "review_generate",
    reviewActionId: entry.reviewActionId || "",
    originalSegments: Number(overview.originalSegments) || entry.original?.annotations.length || 0,
    currentSegments: Number(overview.currentSegments) || entry.current?.annotations.length || 0,
    textDiffCount: Number(overview.textDiffCount) || 0,
    timingDiffCount: Number(overview.timingDiffCount) || 0,
    unmatchedOriginalCount: Number(overview.unmatchedOriginalCount) || 0,
    unmatchedCurrentCount: Number(overview.unmatchedCurrentCount) || 0,
    matchedTemplateIds: toStringArray(entry.metricsAnalysis?.matchedTemplateIds),
    feedbackCount: feedback.length,
    model: typeof aiReview.model === "string" ? aiReview.model : null
  };
}

export async function listReviewHistory(input: {
  logPath: string;
  limit?: number;
  reviewActionId?: string;
  eventType?: AnalyticsEventType | "";
  query?: string;
}): Promise<{ items: ReviewHistorySummary[]; total: number }> {
  const lines = await readHistoryLines(input.logPath);
  const summaries: ReviewHistorySummary[] = [];
  const normalizedReviewActionId = String(input.reviewActionId || "").trim().toLowerCase();
  const normalizedQuery = String(input.query || "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(200, Number(input.limit) || 50));

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const lineNumber = index + 1;
    const entry = parseHistoryEntry(lines[index]);
    if (!entry) {
      continue;
    }
    const reviewActionId = String(entry.reviewActionId || "");
    if (input.eventType && entry.eventType !== input.eventType) {
      continue;
    }
    if (
      normalizedReviewActionId &&
      !reviewActionId.toLowerCase().includes(normalizedReviewActionId)
    ) {
      continue;
    }
    if (normalizedQuery) {
      const haystack = [
        reviewActionId,
        entry.originalText || "",
        entry.currentText || "",
        ...toStringArray(entry.metricsAnalysis?.matchedTemplateIds)
      ]
        .join("\n")
        .toLowerCase();
      if (!haystack.includes(normalizedQuery)) {
        continue;
      }
    }

    summaries.push(summarizeEntry(entry, lineNumber));
    if (summaries.length >= limit) {
      break;
    }
  }

  return {
    items: summaries,
    total: summaries.length
  };
}

export async function getReviewHistoryDetail(input: {
  logPath: string;
  historyId: string;
}): Promise<ReviewHistoryDetail> {
  const lineNumber = parseHistoryId(input.historyId);
  const lines = await readHistoryLines(input.logPath);
  const line = lines[lineNumber - 1];
  const entry = parseHistoryEntry(line);
  if (!entry || !entry.original || !entry.current || !entry.reviewActionId || !entry.eventType) {
    throw new Error("History entry not found.");
  }

  return {
    historyId: buildHistoryId(lineNumber),
    loggedAt: entry.loggedAt || "",
    eventType: entry.eventType,
    reviewActionId: entry.reviewActionId,
    original: entry.original,
    current: entry.current,
    ...(entry.babelDiff ? { babelDiff: entry.babelDiff } : {}),
    originalText: entry.originalText || "",
    currentText: entry.currentText || "",
    aiReview: entry.aiReview ?? null,
    metadata: entry.metadata || {},
    metricsAnalysis: entry.metricsAnalysis || {},
    reconstructedPrepared: buildPreparedPayload({
      reviewActionId: entry.reviewActionId,
      original: entry.original,
      current: entry.current,
      babelDiff: entry.babelDiff ?? null
    })
  };
}
