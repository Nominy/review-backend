import { config } from "../../config";
import { rewriteRowWithModel } from "./openrouter";
import { buildSystemPrompt } from "./prompt";
import { getProjectPresetOrThrow } from "./project-presets";
import type {
  DraftRowResult,
  DraftSummary,
  GenerateDraftRequest,
  GenerateDraftResponse,
  RowRewriteContext,
  DraftingTranscriptRowInput
} from "./types";
import { validateRewrittenRow } from "./validators";

type GenerateDraftDeps = {
  rewriteRow?: (context: RowRewriteContext) => Promise<string>;
  model?: string;
  testMode?: boolean;
  apiKey?: string;
};

function summarizeDraftRows(draftRows: DraftRowResult[]): DraftSummary {
  const anomalyCounts: Record<string, number> = {};
  let rewrittenRows = 0;
  let unchangedRows = 0;
  let failedRows = 0;

  for (const row of draftRows) {
    if (row.status === "rewritten") {
      rewrittenRows += 1;
    } else if (row.status === "unchanged") {
      unchangedRows += 1;
    } else {
      failedRows += 1;
    }

    for (const warning of row.warnings) {
      anomalyCounts[warning] = (anomalyCounts[warning] || 0) + 1;
    }
  }

  return {
    totalRows: draftRows.length,
    rewrittenRows,
    unchangedRows,
    failedRows,
    anomalyCounts
  };
}

function buildRewriteContext(
  rows: DraftingTranscriptRowInput[],
  index: number,
  acceptedRows: DraftRowResult[]
): RowRewriteContext {
  return {
    previousOriginalRows: rows.slice(Math.max(0, index - 2), index),
    previousRewrittenRows: acceptedRows.slice(Math.max(0, acceptedRows.length - 2)),
    currentRow: rows[index],
    nextOriginalRows: rows.slice(index + 1, index + 3)
  };
}

export async function generateDraft(
  request: GenerateDraftRequest,
  deps: GenerateDraftDeps = {}
): Promise<GenerateDraftResponse> {
  const preset = getProjectPresetOrThrow(request.projectPreset);
  const model = deps.model || config.openRouterModel;
  const testMode = deps.testMode ?? config.openRouterTestMode;
  const systemPrompt = buildSystemPrompt(preset);
  const apiKey = deps.apiKey ?? config.openRouterApiKey;

  const rewriteRow =
    deps.rewriteRow ||
    ((context: RowRewriteContext) =>
      rewriteRowWithModel(context, {
        apiKey,
        model,
        preset,
        systemPrompt,
        testMode
      }));

  const draftRows: DraftRowResult[] = [];
  for (let index = 0; index < request.rows.length; index += 1) {
    const context = buildRewriteContext(request.rows, index, draftRows);
    const originalRow = context.currentRow;

    let candidate = originalRow.text;
    try {
      candidate = await rewriteRow(context);
    } catch (error) {
      draftRows.push({
        rowId: originalRow.rowId,
        rewrittenText: originalRow.text,
        status: "failed",
        warnings: ["rewrite_error", error instanceof Error ? error.message : String(error)]
      });
      continue;
    }

    const validation = validateRewrittenRow(originalRow.text, candidate);
    draftRows.push({
      rowId: originalRow.rowId,
      rewrittenText: validation.acceptedText,
      status: validation.status,
      warnings: validation.warnings
    });
  }

  return {
    draftRows,
    summary: summarizeDraftRows(draftRows),
    generationMeta: {
      model: testMode ? `${model}:test-mode` : model,
      rulePackVersion: preset.version,
      generatedAt: new Date().toISOString()
    }
  };
}
