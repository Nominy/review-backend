import { config } from "../../config";
import { assertOpenRouterModelExists, assertOpenRouterModelSupportsAudio } from "../../shared/openrouter-client";
import {
  loadAudioCueTagSystem,
  selectAudioTracksForRow,
  sliceAudioTrackForRow,
  type SliceAudioArgs
} from "./audio-cues";
import { rewriteRowWithModel } from "./openrouter";
import { buildSystemPrompt } from "./prompt";
import { getProjectPresetOrThrow } from "./project-presets";
import type {
  AudioCueAudioTrackInput,
  AudioCueClipInput,
  DraftRowResult,
  DraftSummary,
  GenerateDraftRequest,
  GenerateDraftResponse,
  RowRewriteContext
} from "./types";
import { validateRewrittenRow } from "./validators";

type GenerateDraftDeps = {
  rewriteRow?: (context: RowRewriteContext) => Promise<string>;
  audioTracks?: AudioCueAudioTrackInput[];
  sliceAudio?: (args: SliceAudioArgs) => Promise<AudioCueClipInput>;
  validateAudioModel?: (model: string) => Promise<void>;
  loadTagSystem?: () => Promise<string>;
  model?: string;
  validateModel?: (model: string) => Promise<void>;
  testMode?: boolean;
  apiKey?: string;
  maxAttemptsPerRow?: number;
  onRowComplete?: (args: {
    row: DraftRowResult;
    completedRows: number;
    totalRows: number;
    summary: DraftSummary;
  }) => void | Promise<void>;
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

function summarizeCompletedDraftRows(draftRows: Array<DraftRowResult | undefined>): DraftSummary {
  return summarizeDraftRows(draftRows.filter((row): row is DraftRowResult => Boolean(row)));
}

async function rewriteRowWithRetry(
  rewriteRow: (context: RowRewriteContext) => Promise<string>,
  context: RowRewriteContext,
  maxAttempts: number
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await rewriteRow(context);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) {
        throw error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function audioWarning(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `audio_input_error:${message}`;
}

export async function generateDraft(
  request: GenerateDraftRequest,
  deps: GenerateDraftDeps = {}
): Promise<GenerateDraftResponse> {
  const preset = getProjectPresetOrThrow(request.projectPreset);
  const requestedModel = typeof request.model === "string" ? request.model.trim() : "";
  const model = deps.model || requestedModel || config.openRouterModel;
  const testMode = deps.testMode ?? config.openRouterTestMode;
  const systemPrompt = buildSystemPrompt(preset);
  const requestedApiKey = typeof request.openRouterApiKey === "string" ? request.openRouterApiKey.trim() : "";
  const apiKey = deps.apiKey ?? requestedApiKey;

  if (!deps.rewriteRow && !testMode && !apiKey) {
    throw new Error("openRouterApiKey is required.");
  }

  const audioTracks = deps.audioTracks ?? [];
  const shouldUseAudio = audioTracks.length > 0;

  if (!testMode) {
    if (shouldUseAudio) {
      await (deps.validateAudioModel ?? assertOpenRouterModelSupportsAudio)(model);
    } else if (!deps.rewriteRow) {
      await (deps.validateModel ?? assertOpenRouterModelExists)(model);
    }
  }

  const tagSystem = shouldUseAudio ? await (deps.loadTagSystem ?? loadAudioCueTagSystem)() : undefined;
  const sliceAudio = deps.sliceAudio ?? sliceAudioTrackForRow;

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
  const maxAttemptsPerRow = Math.max(1, deps.maxAttemptsPerRow ?? 2);

  const draftRows: Array<DraftRowResult | undefined> = new Array(request.rows.length);
  let completedRowCount = 0;

  await Promise.all(request.rows.map(async (currentRow, index) => {
    const audioWarnings: string[] = [];
    let audioClips: AudioCueClipInput[] | undefined;

    if (shouldUseAudio) {
      try {
        if (currentRow.startSeconds === null || currentRow.endSeconds === null) {
          throw new Error("missing_row_timing");
        }
        const selectedTracks = selectAudioTracksForRow(audioTracks, currentRow);
        if (!selectedTracks.length) {
          throw new Error(`missing_speaker_audio:${currentRow.speakerKey}`);
        }
        audioClips = await Promise.all(
          selectedTracks.map(async (track) => {
            const clip = await sliceAudio({
              track,
              row: currentRow
            });
            return {
              ...clip,
              trackId: track.trackId,
              speakerKey: track.speakerKey,
              trackLabel: track.trackLabel
            };
          })
        );
      } catch (error) {
        audioWarnings.push(audioWarning(error));
      }
    }

    const context: RowRewriteContext = {
      currentRow,
      ...(audioClips?.length ? { audioClips, tagSystem } : {})
    };
    const originalRow = context.currentRow;

    let candidate = originalRow.text;
    try {
      candidate = await rewriteRowWithRetry(rewriteRow, context, maxAttemptsPerRow);
    } catch (error) {
      const rowResult: DraftRowResult = {
        rowId: originalRow.rowId,
        rewrittenText: originalRow.text,
        status: "failed",
        warnings: ["rewrite_error", error instanceof Error ? error.message : String(error), ...audioWarnings]
      };
      draftRows[index] = rowResult;
      completedRowCount += 1;
      if (deps.onRowComplete) {
        await deps.onRowComplete({
          row: rowResult,
          completedRows: completedRowCount,
          totalRows: request.rows.length,
          summary: summarizeCompletedDraftRows(draftRows)
        });
      }
      return;
    }

    const validation = validateRewrittenRow(originalRow.text, candidate);
    const rowResult: DraftRowResult = {
      rowId: originalRow.rowId,
      rewrittenText: validation.acceptedText,
      status: validation.status,
      warnings: [...validation.warnings, ...audioWarnings]
    };
    draftRows[index] = rowResult;
    completedRowCount += 1;
    if (deps.onRowComplete) {
      await deps.onRowComplete({
        row: rowResult,
        completedRows: completedRowCount,
        totalRows: request.rows.length,
        summary: summarizeCompletedDraftRows(draftRows)
      });
    }
  }));

  const completedDraftRows = draftRows.filter((row): row is DraftRowResult => Boolean(row));

  return {
    draftRows: completedDraftRows,
    summary: summarizeDraftRows(completedDraftRows),
    generationMeta: {
      model: testMode ? `${model}:test-mode` : model,
      rulePackVersion: preset.version,
      generatedAt: new Date().toISOString()
    }
  };
}
