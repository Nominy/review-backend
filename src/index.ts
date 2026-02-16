import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { buildPreparedPayload, generateFeedback } from "./service";
import { config } from "./config";
import type { NormalizedState } from "./types";

type PrepareBody = {
  reviewActionId: string;
  original: NormalizedState;
  current: NormalizedState;
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

const app = new Elysia()
  .use(
    cors({
      origin: true,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"]
    })
  )
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
  .listen(config.port);

console.log(`[babel-review-backend] listening on http://127.0.0.1:${config.port}`);
console.log(`[babel-review-backend] model: ${config.openRouterModel}`);
console.log(`[babel-review-backend] test mode: ${config.openRouterTestMode}`);

export type App = typeof app;
