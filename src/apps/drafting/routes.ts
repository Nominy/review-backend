import type { Elysia } from "elysia";
import { isObject } from "../../shared/http";
import { generateDraft } from "./service";
import type { DraftingTranscriptRowInput, GenerateDraftRequest } from "./types";

type AnyElysia = Elysia<any, any, any, any, any, any, any>;

function isRow(value: unknown): value is DraftingTranscriptRowInput {
  return (
    isObject(value) &&
    typeof value.rowId === "string" &&
    typeof value.speakerKey === "string" &&
    typeof value.text === "string" &&
    Number.isInteger(value.index)
  );
}

function assertGenerateDraftBody(body: unknown): asserts body is GenerateDraftRequest {
  if (!isObject(body)) {
    throw new Error("Body must be an object.");
  }

  if (body.projectPreset !== "ru-gold-2sp-v1") {
    throw new Error("projectPreset must be ru-gold-2sp-v1.");
  }

  if (typeof body.jobId !== "string" || !body.jobId.trim()) {
    throw new Error("jobId is required.");
  }

  if (!Array.isArray(body.rows) || !body.rows.every(isRow)) {
    throw new Error("rows must be a valid transcript row array.");
  }
}

export function registerDraftingRoutes(app: AnyElysia): AnyElysia {
  app.post("/api/draft/generate", async ({ body, set }) => {
    try {
      assertGenerateDraftBody(body);
      return await generateDraft(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set.status = message.includes("required") || message.includes("must") || message.includes("Body") ? 400 : 500;
      return { error: message };
    }
  });

  return app;
}
