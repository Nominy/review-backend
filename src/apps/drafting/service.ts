import { config } from "../../config";
import { assertOpenRouterModelExists, assertOpenRouterModelSupportsAudio } from "../../shared/openrouter-client";
import {
  loadAudioCueTagSystem,
  selectAudioTracksForRow,
  sliceAudioTrackForRow,
  sliceAudioTracksForRows,
  type SliceAudioArgs,
  type SliceAudioBatchArgs,
  type SliceAudioBatchResult,
  type SliceAudioBatchTask
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
  OpenRouterServiceTier,
  RowRewriteContext
} from "./types";
import { validateRewrittenRow } from "./validators";

type GenerateDraftDeps = {
  rewriteRow?: (context: RowRewriteContext) => Promise<string>;
  audioTracks?: AudioCueAudioTrackInput[];
  sliceAudio?: (args: SliceAudioArgs) => Promise<AudioCueClipInput>;
  sliceAudioBatch?: (args: SliceAudioBatchArgs) => Promise<SliceAudioBatchResult>;
  validateAudioModel?: (model: string) => Promise<void>;
  loadTagSystem?: () => Promise<string>;
  model?: string;
  validateModel?: (model: string) => Promise<void>;
  testMode?: boolean;
  apiKey?: string;
  maxAttemptsPerRow?: number;
  rowConcurrency?: number;
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

function appendMapValue<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const current = map.get(key) || [];
  current.push(value);
  map.set(key, current);
}

function appendMapValues<K, V>(map: Map<K, V[]>, key: K, values: V[] | undefined): void {
  if (!values?.length) {
    return;
  }

  for (const value of values) {
    appendMapValue(map, key, value);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateAudioTiming(row: GenerateDraftRequest["rows"][number]): void {
  if (row.startSeconds === null || row.endSeconds === null || row.endSeconds <= row.startSeconds) {
    throw new Error("missing_row_timing");
  }
}

function normalizeServiceTier(value: GenerateDraftRequest["serviceTier"]): OpenRouterServiceTier {
  return value === "default" || value === "priority" || value === "flex" ? value : "flex";
}

function uniqueSelectedAudioTracks(
  audioTracks: AudioCueAudioTrackInput[],
  row: GenerateDraftRequest["rows"][number]
): AudioCueAudioTrackInput[] {
  const selectedTracks = selectAudioTracksForRow(audioTracks, row);
  const seenTrackIds = new Set<string>();

  return selectedTracks.filter((track) => {
    const trackId = track.trackId.trim();
    if (!trackId) {
      return true;
    }
    if (seenTrackIds.has(trackId)) {
      return false;
    }
    seenTrackIds.add(trackId);
    return true;
  });
}

function normalizeConcurrency(value: number | undefined, defaultConcurrency: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return Math.max(1, defaultConcurrency);
  }
  return Math.max(1, Math.floor(value));
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(items.length, concurrency);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        await worker(items[index]!, index);
      }
    })
  );
}

async function prepareBatchedAudioInputs(args: {
  rows: GenerateDraftRequest["rows"];
  audioTracks: AudioCueAudioTrackInput[];
  sliceAudioBatch: (args: SliceAudioBatchArgs) => Promise<SliceAudioBatchResult>;
}): Promise<SliceAudioBatchResult> {
  const tasks: SliceAudioBatchTask[] = [];
  const clipsByRowId = new Map<string, AudioCueClipInput[]>();
  const errorsByRowId = new Map<string, string[]>();

  for (const row of args.rows) {
    try {
      validateAudioTiming(row);
      const selectedTracks = uniqueSelectedAudioTracks(args.audioTracks, row);
      if (!selectedTracks.length) {
        throw new Error(`missing_speaker_audio:${row.speakerKey}`);
      }

      for (const track of selectedTracks) {
        tasks.push({ track, row });
      }
    } catch (error) {
      appendMapValue(errorsByRowId, row.rowId, errorMessage(error));
    }
  }

  if (!tasks.length) {
    return { clipsByRowId, errorsByRowId };
  }

  try {
    const batchResult = await args.sliceAudioBatch({ tasks });
    for (const [rowId, clips] of batchResult.clipsByRowId) {
      appendMapValues(clipsByRowId, rowId, clips);
    }
    for (const [rowId, errors] of batchResult.errorsByRowId) {
      appendMapValues(errorsByRowId, rowId, errors);
    }
  } catch (error) {
    const message = errorMessage(error);
    for (const task of tasks) {
      appendMapValue(errorsByRowId, task.row.rowId, message);
    }
  }

  return { clipsByRowId, errorsByRowId };
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
  const serviceTier = normalizeServiceTier(request.serviceTier);

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
  const useBatchedAudioSlicing = shouldUseAudio && !deps.sliceAudio;
  const batchedAudio = useBatchedAudioSlicing
    ? await prepareBatchedAudioInputs({
        rows: request.rows,
        audioTracks,
        sliceAudioBatch: deps.sliceAudioBatch ?? sliceAudioTracksForRows
      })
    : undefined;

  const rewriteRow =
    deps.rewriteRow ||
    ((context: RowRewriteContext) =>
      rewriteRowWithModel(context, {
        apiKey,
        model,
        preset,
        serviceTier,
        systemPrompt,
        testMode
      }));
  const maxAttemptsPerRow = Math.max(1, deps.maxAttemptsPerRow ?? 2);
  const envRowConcurrency = process.env.DRAFT_ROW_CONCURRENCY ? Number(process.env.DRAFT_ROW_CONCURRENCY) : undefined;
  const rowConcurrency = normalizeConcurrency(deps.rowConcurrency ?? envRowConcurrency, request.rows.length);

  const draftRows: Array<DraftRowResult | undefined> = new Array(request.rows.length);
  let completedRowCount = 0;

  await runWithConcurrency(request.rows, rowConcurrency, async (currentRow, index) => {
    const audioWarnings: string[] = [];
    let audioClips: AudioCueClipInput[] | undefined;

    if (shouldUseAudio) {
      try {
        if (batchedAudio) {
          audioWarnings.push(...(batchedAudio.errorsByRowId.get(currentRow.rowId) || []).map(audioWarning));
          audioClips = batchedAudio.clipsByRowId.get(currentRow.rowId);
        } else {
          validateAudioTiming(currentRow);
          const selectedTracks = uniqueSelectedAudioTracks(audioTracks, currentRow);
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
        }
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
  });

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
