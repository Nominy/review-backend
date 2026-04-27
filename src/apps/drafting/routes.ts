import type { Elysia } from "elysia";
import { config } from "../../config";
import { isObject } from "../../shared/http";
import { assertOpenRouterModelExists } from "../../shared/openrouter-client";
import { generateDraft } from "./service";
import type { DraftingTranscriptRowInput, GenerateDraftRequest } from "./types";

type AnyElysia = Elysia<any, any, any, any, any, any, any>;
const encoder = new TextEncoder();

function toSseChunk(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

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

  if (typeof body.openRouterApiKey !== "string" || !body.openRouterApiKey.trim()) {
    throw new Error("openRouterApiKey is required.");
  }

  if ("model" in body && body.model !== undefined && body.model !== null && typeof body.model !== "string") {
    throw new Error("model must be a string when provided.");
  }
}

function resolveDraftingModel(body: GenerateDraftRequest): string {
  return typeof body.model === "string" && body.model.trim() ? body.model.trim() : config.openRouterModel;
}

function getErrorStatus(message: string): number {
  return message.includes("required") ||
    message.includes("must") ||
    message.includes("Body") ||
    message.includes("does not exist")
    ? 400
    : 500;
}

export function registerDraftingRoutes(app: AnyElysia): AnyElysia {
  app.post("/api/draft/generate", async ({ body, set }) => {
    try {
      assertGenerateDraftBody(body);
      await assertOpenRouterModelExists(resolveDraftingModel(body));
      return await generateDraft(body, { validateModel: async () => {} });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set.status = getErrorStatus(message);
      return { error: message };
    }
  });

  app.post("/api/draft/generate/stream", async ({ body, set }) => {
    try {
      assertGenerateDraftBody(body);
      await assertOpenRouterModelExists(resolveDraftingModel(body));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set.status = getErrorStatus(message);
      return { error: message };
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(
          toSseChunk("started", {
            jobId: body.jobId,
            totalRows: body.rows.length
          })
        );

        try {
          const response = await generateDraft(body, {
            validateModel: async () => {},
            onRowComplete: async ({ row, completedRows, totalRows, summary }) => {
              controller.enqueue(
                toSseChunk("row", {
                  row,
                  completedRows,
                  totalRows,
                  summary
                })
              );
            }
          });

          controller.enqueue(toSseChunk("done", response));
        } catch (error) {
          controller.enqueue(
            toSseChunk("error", {
              error: error instanceof Error ? error.message : String(error)
            })
          );
        } finally {
          controller.close();
        }
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive"
      }
    });
  });

  return app;
}
