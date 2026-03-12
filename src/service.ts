import { computeReviewMetrics } from "./metrics";
import { buildPrompts } from "./prompt";
import { sendToOpenRouter } from "./openrouter";
import { config } from "./config";
import { logReviewTextPair } from "./review-pair-logger";
import { logReviewAnalytics } from "./analytics-logger";
import { getTemplateRegistry } from "./template-registry";
import { renderFeedbackFromTemplateMatches } from "./template-renderer";
import type {
  BabelDiffPayload,
  GenerateResponse,
  NormalizedState,
  PreparedPayload,
  SubmitTranscriptReviewAnalyticsResponse
} from "./types";

export function buildPreparedPayload(input: {
  reviewActionId: string;
  original: NormalizedState;
  current: NormalizedState;
  babelDiff?: BabelDiffPayload | null;
}): PreparedPayload {
  const computed = computeReviewMetrics(
    input.original,
    input.current,
    input.reviewActionId,
    input.babelDiff
  );
  const registry = getTemplateRegistry();
  const prompts = buildPrompts(computed.promptPacket, registry.promptCatalog);

  return {
    preparedAt: new Date().toISOString(),
    stats: computed.stats,
    featurePacket: computed.featurePacket,
    promptPacket: computed.promptPacket,
    metricsVersion: computed.metricsVersion,
    promptVersion: computed.promptPacket.session.promptVersion,
    prompts
  };
}

async function safeLogAnalytics(input: {
  reviewActionId: string;
  original: NormalizedState;
  current: NormalizedState;
  prepared: PreparedPayload;
  babelDiff?: BabelDiffPayload | null;
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
      babelDiff: input.babelDiff,
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

function buildLlmResult(input: {
  reviewActionId: string;
  prepared: PreparedPayload;
  rawContent: string;
  model: string;
  latencyMs: number;
  receivedAt: string;
  matchedTemplateIds: string[];
  repaired?: boolean;
}): GenerateResponse {
  const registry = getTemplateRegistry();
  const rendered = renderFeedbackFromTemplateMatches(
    input.reviewActionId,
    input.matchedTemplateIds,
    registry
  );

  return {
    prepared: input.prepared,
    llm: {
      feedback: rendered.feedback,
      rawContent: input.rawContent,
      model: input.model,
      latencyMs: input.latencyMs,
      receivedAt: input.receivedAt,
      matchedTemplateIds: rendered.matchedTemplateIds,
      templateRegistryVersion: registry.registryVersion,
      ...(input.repaired ? { repaired: true } : {})
    }
  };
}

export async function generateFeedback(input: {
  reviewActionId: string;
  original: NormalizedState;
  current: NormalizedState;
  babelDiff?: BabelDiffPayload | null;
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
  const registry = getTemplateRegistry();

  if (config.openRouterTestMode) {
    const result = buildLlmResult({
      reviewActionId: input.reviewActionId,
      prepared,
      rawContent: JSON.stringify({ findings: [] }),
      model: "test-mode",
      latencyMs: 0,
      receivedAt: new Date().toISOString(),
      matchedTemplateIds: []
    });

    await safeLogAnalytics({
      eventType: "review_generate",
      reviewActionId: input.reviewActionId,
      original: input.original,
      current: input.current,
      babelDiff: input.babelDiff,
      prepared: result.prepared,
      aiReview: result.llm,
      metadata: {
        source: "generateFeedback",
        testMode: true,
        templateRegistryVersion: registry.registryVersion
      }
    });

    return result;
  }

  const llmSelection = await sendToOpenRouter({
    apiKey: config.openRouterApiKey,
    model: config.openRouterModel,
    prompts: prepared.prompts,
    registry
  });

  const result = buildLlmResult({
    reviewActionId: input.reviewActionId,
    prepared,
    rawContent: llmSelection.rawContent,
    model: llmSelection.model,
    latencyMs: llmSelection.latencyMs,
    receivedAt: llmSelection.receivedAt,
    matchedTemplateIds: llmSelection.findings,
    repaired: llmSelection.repaired
  });

  await safeLogAnalytics({
    eventType: "review_generate",
    reviewActionId: input.reviewActionId,
    original: input.original,
    current: input.current,
    babelDiff: input.babelDiff,
    prepared: result.prepared,
    aiReview: result.llm,
    metadata: {
      source: "generateFeedback",
      testMode: false,
      templateRegistryVersion: registry.registryVersion
    }
  });

  return result;
}

export async function submitTranscriptReviewActionAnalytics(input: {
  reviewActionId: string;
  original: NormalizedState;
  current: NormalizedState;
  babelDiff?: BabelDiffPayload | null;
  inputBoxes?: Record<string, unknown>;
  aiReview?: unknown;
  metadata?: Record<string, unknown>;
}): Promise<SubmitTranscriptReviewAnalyticsResponse> {
  const prepared = buildPreparedPayload({
    reviewActionId: input.reviewActionId,
    original: input.original,
    current: input.current,
    babelDiff: input.babelDiff
  });

  await safeLogAnalytics({
    eventType: "submit_transcript_review_action",
    reviewActionId: input.reviewActionId,
    original: input.original,
    current: input.current,
    babelDiff: input.babelDiff,
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
