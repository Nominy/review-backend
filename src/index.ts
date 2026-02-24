import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import {
  buildPreparedPayload,
  generateFeedback,
  submitTranscriptReviewActionAnalytics
} from "./service";
import { config } from "./config";
import type { NormalizedState } from "./types";

type PrepareBody = {
  reviewActionId: string;
  original: NormalizedState;
  current: NormalizedState;
};

type SubmitTranscriptReviewActionBody = PrepareBody & {
  inputBoxes?: Record<string, unknown>;
  aiReview?: unknown;
  metadata?: Record<string, unknown>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertPrepareBody(body: unknown): asserts body is PrepareBody {
  if (!isObject(body)) throw new Error("Body must be an object.");
  if (typeof body.reviewActionId !== "string" || !body.reviewActionId.trim()) {
    throw new Error("reviewActionId is required.");
  }
  if (!isObject(body.original) || !isObject(body.current)) {
    throw new Error("original and current are required.");
  }
}

function assertGenerateBody(body: unknown): asserts body is PrepareBody {
  assertPrepareBody(body);
}

function assertSubmitTranscriptReviewActionBody(
  body: unknown
): asserts body is SubmitTranscriptReviewActionBody {
  assertPrepareBody(body);
  if (!isObject(body)) {
    throw new Error("Body must be an object.");
  }
  if (body.inputBoxes !== undefined && !isObject(body.inputBoxes)) {
    throw new Error("inputBoxes must be an object when provided.");
  }
  if (body.metadata !== undefined && !isObject(body.metadata)) {
    throw new Error("metadata must be an object when provided.");
  }
}

const app = new Elysia()
  .use(
    cors({
      origin: config.corsOrigin,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"]
    })
  )
  .get("/", () => ({
    ok: true,
    service: "babel-review-backend",
    docs: "/health",
    now: new Date().toISOString()
  }))
  .get("/health", () => ({
    ok: true,
    service: "babel-review-backend",
    testMode: config.openRouterTestMode,
    now: new Date().toISOString()
  }))
  .post("/api/review/prepare", ({ body, set }) => {
    try {
      assertPrepareBody(body);
      return buildPreparedPayload({
        reviewActionId: body.reviewActionId,
        original: body.original,
        current: body.current
      });
    } catch (error) {
      set.status = 400;
      return {
        error: error instanceof Error ? error.message : String(error)
      };
    }
  })
  .post("/api/review/generate", async ({ body, set }) => {
    try {
      assertGenerateBody(body);
      return await generateFeedback({
        reviewActionId: body.reviewActionId,
        original: body.original,
        current: body.current
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      set.status = msg.includes("required") || msg.includes("Body") ? 400 : 500;
      return { error: msg };
    }
  })
  .post("/api/trpc/transcriptions.submitTranscriptReviewAction", async ({ body, set }) => {
    try {
      assertSubmitTranscriptReviewActionBody(body);
      return await submitTranscriptReviewActionAnalytics({
        reviewActionId: body.reviewActionId,
        original: body.original,
        current: body.current,
        inputBoxes: body.inputBoxes,
        aiReview: body.aiReview,
        metadata: body.metadata
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      set.status = msg.includes("required") || msg.includes("Body") ? 400 : 500;
      return { error: msg };
    }
  })
  .post("/api/analytics/submit-transcript-review-action", async ({ body, set }) => {
    try {
      assertSubmitTranscriptReviewActionBody(body);
      return await submitTranscriptReviewActionAnalytics({
        reviewActionId: body.reviewActionId,
        original: body.original,
        current: body.current,
        inputBoxes: body.inputBoxes,
        aiReview: body.aiReview,
        metadata: body.metadata
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      set.status = msg.includes("required") || msg.includes("Body") ? 400 : 500;
      return { error: msg };
    }
  })
  .listen({ hostname: config.host, port: config.port });

console.log(`[babel-review-backend] listening on ${config.publicBaseUrl} (bind ${config.host}:${config.port})`);
console.log(
  `[babel-review-backend] cors origin: ${
    config.corsOrigin === true ? "*" : config.corsOrigin.join(", ")
  }`
);
console.log(`[babel-review-backend] model: ${config.openRouterModel}`);
console.log(`[babel-review-backend] test mode: ${config.openRouterTestMode}`);

export type App = typeof app;
