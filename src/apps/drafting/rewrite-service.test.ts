import { describe, expect, test } from "bun:test";
import { generateDraft } from "./service";
import type { GenerateDraftRequest, RowRewriteContext } from "./types";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const baseRequest: GenerateDraftRequest = {
  projectPreset: "ru-gold-2sp-v1",
  jobId: "job-1",
  rows: [
    {
      rowId: "r1",
      speakerKey: "spk-1",
      startSeconds: 1,
      endSeconds: 2,
      text: "privet",
      index: 0
    },
    {
      rowId: "r2",
      speakerKey: "spk-2",
      startSeconds: 2,
      endSeconds: 3,
      text: "da",
      index: 1
    }
  ]
};

describe("generateDraft", () => {
  test("keeps row count and row ids aligned with the input contract", async () => {
    const response = await generateDraft(baseRequest, {
      rewriteRow: async (context: RowRewriteContext) => context.currentRow.text.toUpperCase()
    });

    expect(response.draftRows).toHaveLength(2);
    expect(response.draftRows.map((row) => row.rowId)).toEqual(["r1", "r2"]);
    expect(response.summary.totalRows).toBe(2);
  });

  test("falls back only for the failing row and continues the transcript", async () => {
    const response = await generateDraft(baseRequest, {
      rewriteRow: async (context: RowRewriteContext) =>
        context.currentRow.rowId === "r1" ? "" : `${context.currentRow.text}.`
    });

    expect(response.draftRows[0]).toEqual({
      rowId: "r1",
      rewrittenText: "privet",
      status: "failed",
      warnings: ["empty_output"]
    });
    expect(response.draftRows[1].rowId).toBe("r2");
    expect(response.summary.failedRows).toBe(1);
  });

  test("marks rewrite exceptions as row-local failures", async () => {
    const response = await generateDraft(baseRequest, {
      rewriteRow: async (context: RowRewriteContext) => {
        if (context.currentRow.rowId === "r2") {
          throw new Error("network blip");
        }
        return "Privet.";
      }
    });

    expect(response.draftRows[0].status).toBe("rewritten");
    expect(response.draftRows[1].status).toBe("failed");
    expect(response.draftRows[1].warnings[0]).toBe("rewrite_error");
  });

  test("passes only the current row into the rewrite context", async () => {
    const seenContexts: RowRewriteContext[] = [];

    await generateDraft(baseRequest, {
      rewriteRow: async (context: RowRewriteContext) => {
        seenContexts.push(context);
        return `${context.currentRow.text}.`;
      }
    });

    expect(seenContexts).toHaveLength(2);
    expect(seenContexts[0]).toEqual({
      currentRow: baseRequest.rows[0]
    });
    expect(seenContexts[1]).toEqual({
      currentRow: baseRequest.rows[1]
    });
  });

  test("emits row progress as each row completes", async () => {
    const events: Array<{ rowId: string; completedRows: number; failedRows: number }> = [];

    await generateDraft(baseRequest, {
      rewriteRow: async (context: RowRewriteContext) =>
        context.currentRow.rowId === "r1" ? `${context.currentRow.text}.` : "",
      onRowComplete: async ({ row, completedRows, summary }) => {
        events.push({
          rowId: row.rowId,
          completedRows,
          failedRows: summary.failedRows
        });
      }
    });

    expect(events).toEqual([
      { rowId: "r1", completedRows: 1, failedRows: 0 },
      { rowId: "r2", completedRows: 2, failedRows: 1 }
    ]);
  });

  test("keeps final draft rows in input order even when responses finish out of order", async () => {
    const completionOrder: string[] = [];

    const response = await generateDraft(baseRequest, {
      rewriteRow: async (context: RowRewriteContext) => {
        if (context.currentRow.rowId === "r1") {
          await delay(20);
          return "Privet.";
        }
        await delay(1);
        return "Da.";
      },
      onRowComplete: async ({ row }) => {
        completionOrder.push(row.rowId);
      }
    });

    expect(completionOrder).toEqual(["r2", "r1"]);
    expect(response.draftRows.map((row) => row.rowId)).toEqual(["r1", "r2"]);
    expect(response.draftRows.map((row) => row.rewrittenText)).toEqual(["Privet.", "Da."]);
  });

  test("retries a failed row call once before succeeding", async () => {
    const attempts = new Map<string, number>();

    const response = await generateDraft(baseRequest, {
      rewriteRow: async (context: RowRewriteContext) => {
        const currentAttempts = (attempts.get(context.currentRow.rowId) || 0) + 1;
        attempts.set(context.currentRow.rowId, currentAttempts);

        if (context.currentRow.rowId === "r1" && currentAttempts === 1) {
          throw new Error("temporary upstream failure");
        }

        return `${context.currentRow.text}.`;
      }
    });

    expect(attempts.get("r1")).toBe(2);
    expect(attempts.get("r2")).toBe(1);
    expect(response.draftRows[0]).toEqual({
      rowId: "r1",
      rewrittenText: "privet.",
      status: "rewritten",
      warnings: ["length_delta"]
    });
  });
});
