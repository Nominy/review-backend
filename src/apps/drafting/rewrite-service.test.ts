import { describe, expect, test } from "bun:test";
import { generateDraft } from "./service";
import type { GenerateDraftRequest, RowRewriteContext } from "./types";

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
});
