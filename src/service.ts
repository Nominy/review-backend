import { computeReviewMetrics } from "./metrics";
import { buildPrompts } from "./prompt";
import { sendToOpenRouter } from "./openrouter";
import { config } from "./config";
import { CATEGORIES } from "./rules";
import { logReviewTextPair } from "./review-pair-logger";
import type { GenerateResponse, NormalizedState, PreparedPayload } from "./types";

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

    return {
      prepared,
      llm: {
        feedback: mockFeedback,
        rawContent: JSON.stringify({ feedback: mockFeedback }),
        model: "test-mode",
        latencyMs: 0,
        receivedAt: new Date().toISOString()
      }
    };
  }

  const llm = await sendToOpenRouter({
    apiKey: config.openRouterApiKey,
    model: config.openRouterModel,
    prompts: prepared.prompts
  });

  return {
    prepared,
    llm
  };
}
