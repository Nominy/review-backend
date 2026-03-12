import { fileURLToPath } from "node:url";
import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import {
  buildPreparedPayload,
  generateFeedback,
  submitTranscriptReviewActionAnalytics
} from "./service";
import { getReviewHistoryDetail, listReviewHistory } from "./history";
import { config } from "./config";
import {
  createTemplateForLab,
  importTemplatesFromCsv,
  listTemplatesLabData,
  saveTemplatesLabDraft,
  updateTemplateForLab
} from "./template-admin";
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

type TemplatesLabCreateBody = {
  category: string;
  name: string;
  errorDescription: string;
  templateTexts: string[];
};

type TemplatesLabUpdateBody = {
  name: string;
  errorDescription: string;
  templateTexts: string[];
  enabled: boolean;
};

type TemplatesLabSaveBody = {
  categories: unknown[];
};

type CreditsSnapshot = {
  total: number | null;
  used: number | null;
  remaining: number | null;
  line: string;
  error?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value) || !value.length) {
    return false;
  }
  return value.every((item) => typeof item === "string" && !!item.trim());
}

const TEMPLATES_LAB_INDEX_PATH = fileURLToPath(new URL("./templates-lab/index.html", import.meta.url));
const TEMPLATES_LAB_STYLES_PATH = fileURLToPath(
  new URL("./templates-lab/styles.css", import.meta.url)
);
const TEMPLATES_LAB_APP_PATH = fileURLToPath(new URL("./templates-lab/app.js", import.meta.url));

function toFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fmtCredits(value: number | null): string {
  return value === null ? "?" : value.toFixed(4);
}

function getErrorStatus(error: unknown, fallback = 500): number {
  if (error && typeof error === "object" && "statusCode" in error) {
    const parsed = Number((error as { statusCode?: unknown }).statusCode);
    if (Number.isInteger(parsed) && parsed >= 100) {
      return parsed;
    }
  }
  return fallback;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function funnyCreditsLine(remaining: number | null): string {
  if (remaining === null) return "Wallet status: classified paperwork.";
  if (remaining <= 0) return "Wallet status: ramen mode engaged.";
  if (remaining < 1) return "Wallet status: fumes, but still rolling.";
  if (remaining < 10) return "Wallet status: comfy, no panic.";
  return "Wallet status: credits are chilling.";
}

async function fetchOpenRouterCredits(apiKey: string): Promise<CreditsSnapshot> {
  if (!apiKey.trim()) {
    return {
      total: null,
      used: null,
      remaining: null,
      line: "Wallet status: test mode, imaginary money."
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch("https://openrouter.ai/api/v1/credits", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`OpenRouter HTTP ${response.status}`);
    }

    const json = (await response.json()) as unknown;
    const data = isObject(json) && isObject(json.data) ? json.data : {};

    const total = toFiniteNumber(
      data.total_credits ?? data.totalCredits ?? data.total ?? data.credits
    );
    const used = toFiniteNumber(data.total_usage ?? data.totalUsage ?? data.used_credits ?? data.used);
    const remaining = toFiniteNumber(
      data.remaining_credits ??
        data.remainingCredits ??
        (total !== null && used !== null ? total - used : Number.NaN)
    );

    return {
      total,
      used,
      remaining,
      line: `OpenRouter credits: total=${fmtCredits(total)}, remaining=${fmtCredits(
        remaining
      )}. ${funnyCreditsLine(remaining)}`
    };
  } catch (error) {
    return {
      total: null,
      used: null,
      remaining: null,
      line: "OpenRouter credits: unavailable. Wallet taking a coffee break.",
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
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

function assertTemplatesLabCreateBody(body: unknown): asserts body is TemplatesLabCreateBody {
  if (!isObject(body)) {
    throw new Error("Body must be an object.");
  }
  if (typeof body.category !== "string" || !body.category.trim()) {
    throw new Error("category is required.");
  }
  if (typeof body.name !== "string" || !body.name.trim()) {
    throw new Error("name is required.");
  }
  if (typeof body.errorDescription !== "string" || !body.errorDescription.trim()) {
    throw new Error("errorDescription is required.");
  }
  if (!isNonEmptyStringArray(body.templateTexts)) {
    throw new Error("templateTexts is required.");
  }
}

function assertTemplatesLabUpdateBody(body: unknown): asserts body is TemplatesLabUpdateBody {
  if (!isObject(body)) {
    throw new Error("Body must be an object.");
  }
  if (typeof body.name !== "string" || !body.name.trim()) {
    throw new Error("name is required.");
  }
  if (typeof body.errorDescription !== "string" || !body.errorDescription.trim()) {
    throw new Error("errorDescription is required.");
  }
  if (!isNonEmptyStringArray(body.templateTexts)) {
    throw new Error("templateTexts is required.");
  }
  if (typeof body.enabled !== "boolean") {
    throw new Error("enabled is required.");
  }
}

function assertTemplatesLabSaveBody(body: unknown): asserts body is TemplatesLabSaveBody {
  if (!isObject(body)) {
    throw new Error("Body must be an object.");
  }
  if (!Array.isArray(body.categories)) {
    throw new Error("categories is required.");
  }
}

function requireTemplatesLabAccess(
  authorization: string | undefined,
  set: { status?: number; headers?: Record<string, string> }
): { error: string } | null {
  if (!config.templatesLabEnabled) {
    set.status = 404;
    return { error: "Templates Lab is disabled." };
  }

  const header = String(authorization || "").trim();
  if (!header.startsWith("Basic ")) {
    set.status = 401;
    set.headers = { ...(set.headers || {}), "WWW-Authenticate": 'Basic realm="Templates Lab"' };
    return { error: "Unauthorized" };
  }

  try {
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    const username = separator >= 0 ? decoded.slice(0, separator) : decoded;
    const password = separator >= 0 ? decoded.slice(separator + 1) : "";

    if (
      username === config.templatesLabUsername &&
      password === config.templatesLabPassword
    ) {
      return null;
    }
  } catch {
    // fall through to unauthorized
  }

  set.status = 401;
  set.headers = { ...(set.headers || {}), "WWW-Authenticate": 'Basic realm="Templates Lab"' };
  return { error: "Unauthorized" };
}

function requireHistoryAccess(
  authorization: string | undefined,
  set: { status?: number; headers?: Record<string, string> }
): { error: string } | null {
  if (!config.templatesLabEnabled) {
    set.status = 404;
    return { error: "History API is disabled." };
  }

  return requireTemplatesLabAccess(authorization, set);
}

const app = new Elysia()
  .use(
    cors({
      origin: config.corsOrigin,
      methods: ["GET", "POST", "PUT", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"]
    })
  )
  .get("/", () => ({
    ok: true,
    service: "babel-review-backend",
    docs: "/health",
    now: new Date().toISOString()
  }))
  .get("/health", async () => {
    const credits = await fetchOpenRouterCredits(config.openRouterApiKey);
    return {
      ok: true,
      service: "babel-review-backend",
      testMode: config.openRouterTestMode,
      now: new Date().toISOString(),
      openRouterCredits: credits
    };
  })
  .get("/templates-lab", ({ headers, set }) => {
    const blocked = requireTemplatesLabAccess(headers.authorization, set);
    if (blocked) {
      return blocked;
    }
    return Bun.file(TEMPLATES_LAB_INDEX_PATH);
  })
  .get("/templates-lab/styles.css", ({ headers, set }) => {
    const blocked = requireTemplatesLabAccess(headers.authorization, set);
    if (blocked) {
      return blocked;
    }
    return Bun.file(TEMPLATES_LAB_STYLES_PATH);
  })
  .get("/templates-lab/app.js", ({ headers, set }) => {
    const blocked = requireTemplatesLabAccess(headers.authorization, set);
    if (blocked) {
      return blocked;
    }
    return Bun.file(TEMPLATES_LAB_APP_PATH);
  })
  .post("/api/review/prepare", ({ body, set }) => {
    try {
      assertPrepareBody(body);
      return buildPreparedPayload({
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
  .get("/api/review-history", async ({ headers, query, set }) => {
    const blocked = requireHistoryAccess(headers.authorization, set);
    if (blocked) {
      return blocked;
    }

    try {
      const eventType =
        query.eventType === "review_generate" || query.eventType === "submit_transcript_review_action"
          ? query.eventType
          : "";

      return await listReviewHistory({
        logPath: config.analyticsLogPath,
        limit: Number(query.limit),
        reviewActionId: typeof query.reviewActionId === "string" ? query.reviewActionId : "",
        eventType,
        query: typeof query.query === "string" ? query.query : ""
      });
    } catch (error) {
      set.status = getErrorStatus(error, 500);
      return { error: getErrorMessage(error) };
    }
  })
  .get("/api/review-history/:historyId", async ({ headers, params, set }) => {
    const blocked = requireHistoryAccess(headers.authorization, set);
    if (blocked) {
      return blocked;
    }

    try {
      return await getReviewHistoryDetail({
        logPath: config.analyticsLogPath,
        historyId: params.historyId
      });
    } catch (error) {
      const message = getErrorMessage(error);
      set.status = message.includes("not found") || message.includes("Invalid history ID") ? 404 : 500;
      return { error: message };
    }
  })
  .get("/api/templates-lab/templates", ({ headers, set }) => {
    const blocked = requireTemplatesLabAccess(headers.authorization, set);
    if (blocked) {
      return blocked;
    }

    try {
      return listTemplatesLabData();
    } catch (error) {
      set.status = getErrorStatus(error);
      return { error: getErrorMessage(error) };
    }
  })
  .post("/api/templates-lab/save", async ({ body, headers, set }) => {
    const blocked = requireTemplatesLabAccess(headers.authorization, set);
    if (blocked) {
      return blocked;
    }

    try {
      assertTemplatesLabSaveBody(body);
      return await saveTemplatesLabDraft({
        categories: body.categories
      });
    } catch (error) {
      set.status = getErrorStatus(
        error,
        getErrorMessage(error).includes("required") || getErrorMessage(error).includes("Body")
          ? 400
          : 500
      );
      return { error: getErrorMessage(error) };
    }
  })
  .post("/api/templates-lab/templates", async ({ body, headers, set }) => {
    const blocked = requireTemplatesLabAccess(headers.authorization, set);
    if (blocked) {
      return blocked;
    }

    try {
      assertTemplatesLabCreateBody(body);
      set.status = 201;
      return await createTemplateForLab({
        category: body.category,
        name: body.name,
        errorDescription: body.errorDescription,
        templateTexts: body.templateTexts
      });
    } catch (error) {
      set.status = getErrorStatus(
        error,
        getErrorMessage(error).includes("required") || getErrorMessage(error).includes("Body")
          ? 400
          : 500
      );
      return { error: getErrorMessage(error) };
    }
  })
  .put("/api/templates-lab/templates/:id", async ({ params, body, headers, set }) => {
    const blocked = requireTemplatesLabAccess(headers.authorization, set);
    if (blocked) {
      return blocked;
    }

    try {
      assertTemplatesLabUpdateBody(body);
      return await updateTemplateForLab({
        id: params.id,
        name: body.name,
        errorDescription: body.errorDescription,
        templateTexts: body.templateTexts,
        enabled: body.enabled
      });
    } catch (error) {
      set.status = getErrorStatus(
        error,
        getErrorMessage(error).includes("required") || getErrorMessage(error).includes("Body")
          ? 400
          : 500
      );
      return { error: getErrorMessage(error) };
    }
  })
  .post("/api/templates-lab/import-csv", async ({ headers, request, set }) => {
    const blocked = requireTemplatesLabAccess(headers.authorization, set);
    if (blocked) {
      return blocked;
    }

    try {
      const formData = await request.formData();
      const fileField = formData.get("file");
      let csvText = "";

      if (typeof fileField === "string") {
        csvText = fileField;
      } else if (fileField && typeof (fileField as Blob).text === "function") {
        csvText = await (fileField as Blob).text();
      } else {
        throw new Error("CSV file is required.");
      }

      return await importTemplatesFromCsv(csvText);
    } catch (error) {
      set.status = getErrorStatus(error, 500);
      return { error: getErrorMessage(error) };
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
