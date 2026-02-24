import { computeReviewMetrics } from "./metrics";
import { buildPrompts } from "./prompt";
import { sendToOpenRouter } from "./openrouter";
import { config } from "./config";
import { CATEGORIES } from "./rules";
import { logReviewTextPair } from "./review-pair-logger";
import { logReviewAnalytics } from "./analytics-logger";
import type {
  GenerateResponse,
  NormalizedState,
  PreparedPayload,
  SubmitTranscriptReviewAnalyticsResponse
} from "./types";

export function buildPreparedPayload(input: {
  reviewActionId: string;
  original: NormalizedState;
  current: NormalizedState;
}): PreparedPayload {
  const computed = computeReviewMetrics(input.original, input.current, input.reviewActionId);
  const prompts = buildPrompts(computed.featurePacket);
  return {
    preparedAt: new Date().toISOString(),
    stats: computed.stats,
    featurePacket: computed.featurePacket,
    prompts
  };
}

async function safeLogAnalytics(input: {
  reviewActionId: string;
  original: NormalizedState;
  current: NormalizedState;
  prepared: PreparedPayload;
  aiReview?: unknown;
  inputBoxes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  eventType: "review_generate" | "submit_transcript_review_action";
}): Promise<void> {
  try {
    await logReviewAnalytics({
      eventType: input.eventType,
      reviewActionId: input.reviewActionId,
      original: input.original,
      current: input.current,
      prepared: input.prepared,
      aiReview: input.aiReview,
      inputBoxes: input.inputBoxes,
      metadata: input.metadata,
      logPath: config.analyticsLogPath
    });
  } catch (error) {
    console.error(
      `[babel-review-backend] failed to write analytics log: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export async function generateFeedback(input: {
  reviewActionId: string;
  original: NormalizedState;
  current: NormalizedState;
}): Promise<GenerateResponse> {
  try {
    await logReviewTextPair({
      reviewActionId: input.reviewActionId,
      original: input.original,
      current: input.current,
      logPath: config.reviewPairLogPath
    });
  } catch (error) {
    console.error(
      `[babel-review-backend] failed to write review pair log: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const prepared = buildPreparedPayload(input);

  if (config.openRouterTestMode) {
    const mockScores = [1, 2, 3] as const;
    const mockFeedback = CATEGORIES.map((category, index) => ({
      category,
      score: mockScores[index % mockScores.length],
      note: "test test test"
    }));

    const result: GenerateResponse = {
      prepared,
      llm: {
        feedback: mockFeedback,
        rawContent: JSON.stringify({ feedback: mockFeedback }),
        model: "test-mode",
        latencyMs: 0,
        receivedAt: new Date().toISOString()
      }
    };

    await safeLogAnalytics({
      eventType: "review_generate",
      reviewActionId: input.reviewActionId,
      original: input.original,
      current: input.current,
      prepared: result.prepared,
      aiReview: result.llm,
      metadata: { source: "generateFeedback", testMode: true }
    });

    return result;
  }

  const llm = await sendToOpenRouter({
    apiKey: config.openRouterApiKey,
    model: config.openRouterModel,
    prompts: prepared.prompts
  });

  const result: GenerateResponse = {
    prepared,
    llm
  };

  await safeLogAnalytics({
    eventType: "review_generate",
    reviewActionId: input.reviewActionId,
    original: input.original,
    current: input.current,
    prepared: result.prepared,
    aiReview: result.llm,
    metadata: { source: "generateFeedback", testMode: false }
  });

  return result;
}

export async function submitTranscriptReviewActionAnalytics(input: {
  reviewActionId: string;
  original: NormalizedState;
  current: NormalizedState;
  inputBoxes?: Record<string, unknown>;
  aiReview?: unknown;
  metadata?: Record<string, unknown>;
}): Promise<SubmitTranscriptReviewAnalyticsResponse> {
  const prepared = buildPreparedPayload({
    reviewActionId: input.reviewActionId,
    original: input.original,
    current: input.current
  });

  await safeLogAnalytics({
    eventType: "submit_transcript_review_action",
    reviewActionId: input.reviewActionId,
    original: input.original,
    current: input.current,
    prepared,
    aiReview: input.aiReview ?? null,
    inputBoxes: input.inputBoxes ?? {},
    metadata: input.metadata ?? {}
  });

  return {
    ok: true,
    savedAt: new Date().toISOString(),
    reviewActionId: input.reviewActionId,
    prepared
  };
}
