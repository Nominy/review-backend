import { fileURLToPath } from "node:url";
import type { AnyElysia, InferContext } from "elysia";
import {
  buildPreparedPayload,
  createInteractiveReviewSession,
  clearInteractiveReviewSessionCardTemplateMatch,
  decideInteractiveTemplateSuggestion,
  finalizeInteractiveReviewSession,
  generateFeedback,
  generateInteractiveTemplateSuggestions,
  getInteractiveReviewSession,
  submitTranscriptReviewActionAnalytics,
  updateInteractiveReviewSessionCardTemplateMatch,
  updateInteractiveReviewSessionComments
} from "../../service";
import { searchTemplates } from "../../template-search";
import { getReviewHistoryDetail, listReviewHistory } from "../../history";
import { config } from "../../config";
import {
  createTemplateForLab,
  importTemplatesFromCsv,
  listTemplatesLabData,
  saveTemplatesLabDraft,
  updateTemplateForLab
} from "../../template-admin";
import type { AnalyticsEventType, BabelDiffPayload, NormalizedState } from "../../types";
import {
  type RouteSet,
  getErrorMessage,
  getErrorStatus,
  isNonEmptyStringArray,
  isObject
} from "../../shared/http";

type PrepareBody = {
  reviewActionId: string;
  original: NormalizedState;
  current: NormalizedState;
  babelDiff?: BabelDiffPayload | null;
};

type SubmitTranscriptReviewActionBody = PrepareBody & {
  inputBoxes?: Record<string, unknown>;
  aiReview?: unknown;
  metadata?: Record<string, unknown>;
};

type ReviewSessionCommentsBody = {
  cardComments?: Record<string, unknown>;
  sessionComment?: string;
};

type ReviewSessionTemplateMatchBody = {
  templateId: string;
};

type TemplateSuggestionDecisionBody = {
  decision: "approved" | "rejected";
};

type FinalizeReviewSessionBody = {
  mode?: "skip" | "apply";
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

const TEMPLATES_LAB_INDEX_PATH = fileURLToPath(new URL("../../templates-lab/index.html", import.meta.url));
const TEMPLATES_LAB_STYLES_PATH = fileURLToPath(new URL("../../templates-lab/styles.css", import.meta.url));
const TEMPLATES_LAB_APP_PATH = fileURLToPath(new URL("../../templates-lab/app.js", import.meta.url));

function assertPrepareBody(body: unknown): asserts body is PrepareBody {
  if (!isObject(body)) throw new Error("Body must be an object.");
  if (typeof body.reviewActionId !== "string" || !body.reviewActionId.trim()) {
    throw new Error("reviewActionId is required.");
  }
  if (!isObject(body.original) || !isObject(body.current)) {
    throw new Error("original and current are required.");
  }
  if (body.babelDiff !== undefined && body.babelDiff !== null && !isObject(body.babelDiff)) {
    throw new Error("babelDiff must be an object when provided.");
  }
}

function assertSubmitTranscriptReviewActionBody(
  body: unknown
): asserts body is SubmitTranscriptReviewActionBody {
  assertPrepareBody(body);
  const candidate = body as SubmitTranscriptReviewActionBody;
  if (candidate.inputBoxes !== undefined && !isObject(candidate.inputBoxes)) {
    throw new Error("inputBoxes must be an object when provided.");
  }
  if (candidate.metadata !== undefined && !isObject(candidate.metadata)) {
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

function assertReviewSessionCommentsBody(body: unknown): asserts body is ReviewSessionCommentsBody {
  if (!isObject(body)) {
    throw new Error("Body must be an object.");
  }
  if (body.cardComments !== undefined && !isObject(body.cardComments)) {
    throw new Error("cardComments must be an object when provided.");
  }
  if (body.sessionComment !== undefined && typeof body.sessionComment !== "string") {
    throw new Error("sessionComment must be a string when provided.");
  }
}

function assertReviewSessionTemplateMatchBody(
  body: unknown
): asserts body is ReviewSessionTemplateMatchBody {
  if (!isObject(body)) {
    throw new Error("Body must be an object.");
  }
  if (typeof body.templateId !== "string" || !body.templateId.trim()) {
    throw new Error("templateId must be a non-empty string.");
  }
}

function assertTemplateSuggestionDecisionBody(
  body: unknown
): asserts body is TemplateSuggestionDecisionBody {
  if (!isObject(body) || (body.decision !== "approved" && body.decision !== "rejected")) {
    throw new Error("decision must be either approved or rejected.");
  }
}

function assertFinalizeReviewSessionBody(
  body: unknown
): asserts body is FinalizeReviewSessionBody {
  if (!isObject(body)) {
    throw new Error("Body must be an object.");
  }
  if (body.mode !== undefined && body.mode !== "skip" && body.mode !== "apply") {
    throw new Error("mode must be skip or apply when provided.");
  }
}

function requireTemplatesLabAccess(
  authorization: string | undefined,
  set: RouteSet
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

    if (username === config.templatesLabUsername && password === config.templatesLabPassword) {
      return null;
    }
  } catch {
    // fall through
  }

  set.status = 401;
  set.headers = { ...(set.headers || {}), "WWW-Authenticate": 'Basic realm="Templates Lab"' };
  return { error: "Unauthorized" };
}

function requireHistoryAccess(
  authorization: string | undefined,
  set: RouteSet
): { error: string } | null {
  if (!config.templatesLabEnabled) {
    set.status = 404;
    return { error: "History API is disabled." };
  }

  return requireTemplatesLabAccess(authorization, set);
}

async function submitTranscriptReviewAction({ body, set }: InferContext<AnyElysia>) {
  try {
    assertSubmitTranscriptReviewActionBody(body);
    return await submitTranscriptReviewActionAnalytics({
      reviewActionId: body.reviewActionId,
      original: body.original,
      current: body.current,
      babelDiff: body.babelDiff ?? null,
      inputBoxes: body.inputBoxes,
      aiReview: body.aiReview,
      metadata: body.metadata
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    set.status = msg.includes("required") || msg.includes("Body") ? 400 : 500;
    return { error: msg };
  }
}

export function registerReviewRoutes(app: AnyElysia): AnyElysia {
  app
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
          current: body.current,
          babelDiff: body.babelDiff ?? null
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        set.status = msg.includes("required") || msg.includes("Body") ? 400 : 500;
        return { error: msg };
      }
    })
    .post("/api/review/generate", async ({ body, set }) => {
      try {
        assertPrepareBody(body);
        return await generateFeedback({
          reviewActionId: body.reviewActionId,
          original: body.original,
          current: body.current,
          babelDiff: body.babelDiff ?? null
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        set.status = msg.includes("required") || msg.includes("Body") ? 400 : 500;
        return { error: msg };
      }
    })
    .post("/api/review/sessions", async ({ body, set }) => {
      try {
        assertPrepareBody(body);
        return await createInteractiveReviewSession({
          reviewActionId: body.reviewActionId,
          original: body.original,
          current: body.current,
          babelDiff: body.babelDiff ?? null
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        set.status = msg.includes("required") || msg.includes("Body") ? 400 : 500;
        return { error: msg };
      }
    })
    .get("/api/review/sessions/:sessionId", async ({ params, set }) => {
      try {
        return await getInteractiveReviewSession(params.sessionId);
      } catch (error) {
        const message = getErrorMessage(error);
        set.status = message.includes("not found") ? 404 : 500;
        return { error: message };
      }
    })
    .get("/api/review/templates/search", ({ query, set }) => {
      try {
        return searchTemplates(
          typeof query.q === "string" ? query.q : "",
          Number(query.limit)
        );
      } catch (error) {
        const message = getErrorMessage(error);
        set.status = getErrorStatus(error, 500);
        return { error: message };
      }
    })
    .post("/api/review/sessions/:sessionId/comments", async ({ params, body, set }) => {
      try {
        assertReviewSessionCommentsBody(body);
        return await updateInteractiveReviewSessionComments({
          sessionId: params.sessionId,
          cardComments: body.cardComments,
          sessionComment: body.sessionComment
        });
      } catch (error) {
        const message = getErrorMessage(error);
        set.status = message.includes("not found")
          ? 404
          : getErrorStatus(error, message.includes("Body") ? 400 : 500);
        return { error: message };
      }
    })
    .post("/api/review/sessions/:sessionId/cards/:cardId/template-match", async ({ params, body, set }) => {
      try {
        assertReviewSessionTemplateMatchBody(body);
        return await updateInteractiveReviewSessionCardTemplateMatch({
          sessionId: params.sessionId,
          cardId: params.cardId,
          templateId: body.templateId.trim()
        });
      } catch (error) {
        const message = getErrorMessage(error);
        set.status = message.includes("not found")
          ? 404
          : getErrorStatus(error, message.includes("Body") ? 400 : 500);
        return { error: message };
      }
    })
    .post("/api/review/sessions/:sessionId/cards/:cardId/template-clear", async ({ params, set }) => {
      try {
        return await clearInteractiveReviewSessionCardTemplateMatch({
          sessionId: params.sessionId,
          cardId: params.cardId
        });
      } catch (error) {
        const message = getErrorMessage(error);
        set.status = message.includes("not found") ? 404 : getErrorStatus(error, 500);
        return { error: message };
      }
    })
    .post("/api/review/sessions/:sessionId/template-suggestions", async ({ params, set }) => {
      try {
        return await generateInteractiveTemplateSuggestions({
          sessionId: params.sessionId
        });
      } catch (error) {
        const message = getErrorMessage(error);
        set.status = message.includes("not found") ? 404 : getErrorStatus(error, 500);
        return { error: message };
      }
    })
    .post(
      "/api/review/sessions/:sessionId/template-suggestions/:proposalId/decision",
      async ({ params, body, set }) => {
        try {
          assertTemplateSuggestionDecisionBody(body);
          return await decideInteractiveTemplateSuggestion({
            sessionId: params.sessionId,
            proposalId: params.proposalId,
            decision: body.decision
          });
        } catch (error) {
          const message = getErrorMessage(error);
          set.status = message.includes("not found") ? 404 : getErrorStatus(error, 500);
          return { error: message };
        }
      }
    )
    .post("/api/review/sessions/:sessionId/finalize", async ({ params, body, set }) => {
      try {
        assertFinalizeReviewSessionBody(body);
        return await finalizeInteractiveReviewSession({
          sessionId: params.sessionId,
          mode: body.mode === "skip" ? "skip" : "apply"
        });
      } catch (error) {
        const message = getErrorMessage(error);
        set.status = message.includes("not found") ? 404 : getErrorStatus(error, 500);
        return { error: message };
      }
    })
    .get("/api/review-history", async ({ headers, query, set }) => {
      const blocked = requireHistoryAccess(headers.authorization, set);
      if (blocked) {
        return blocked;
      }

      try {
        const supportedEventTypes = new Set<AnalyticsEventType>([
          "review_generate",
          "submit_transcript_review_action",
          "review_session_created",
          "review_session_opened",
          "review_card_commented",
          "template_suggestions_generated",
          "template_suggestion_approved",
          "template_suggestion_rejected",
          "interactive_session_skipped",
          "interactive_review_applied"
        ]);
        const eventType =
          typeof query.eventType === "string" && supportedEventTypes.has(query.eventType as AnalyticsEventType)
            ? (query.eventType as AnalyticsEventType)
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
    .get("/api/templates-lab/templates", async ({ headers, set }) => {
      const blocked = requireTemplatesLabAccess(headers.authorization, set);
      if (blocked) {
        return blocked;
      }

      try {
        return await listTemplatesLabData();
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
          categories: body.categories as Parameters<typeof saveTemplatesLabDraft>[0]["categories"]
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
    .post("/api/trpc/transcriptions.submitTranscriptReviewAction", submitTranscriptReviewAction)
    .post("/api/analytics/submit-transcript-review-action", submitTranscriptReviewAction);

  return app;
}
