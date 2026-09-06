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
  OpenRouterReasoningEffort,
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

function appendAudioClipWarnings(audioWarnings: string[], audioClips: AudioCueClipInput[] | undefined): void {
  if (audioClips?.some((clip) => clip.truncatedAtEnd)) {
    audioWarnings.push("audio_truncated_at_end");
  }
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

function normalizeReasoningEffort(value: GenerateDraftRequest["reasoningEffort"]): OpenRouterReasoningEffort | undefined {
  if (value === "default") {
    return undefined;
  }

  return value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
    ? value
    : "low";
}

function normalizeTrackDedupeKey(value: string | undefined): string {
  const text = typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
  if (!text) {
    return "";
  }

  const speakerMatch = text.match(/\b(?:speaker|spk|sp)\s*[-_ ]?\s*(\d+)\b/u);
  if (speakerMatch) {
    return `speaker-${speakerMatch[1]}`;
  }

  return text.replace(/[^\p{L}0-9]+/giu, "-").replace(/^-+|-+$/gu, "");
}

function uniqueSelectedAudioTracks(
  audioTracks: AudioCueAudioTrackInput[],
  row: GenerateDraftRequest["rows"][number]
): AudioCueAudioTrackInput[] {
  const selectedTracks = selectAudioTracksForRow(audioTracks, row);
  const seenTrackKeys = new Set<string>();

  return selectedTracks.filter((track) => {
    const trackKey =
      normalizeTrackDedupeKey(track.speakerKey) ||
      normalizeTrackDedupeKey(track.trackLabel) ||
      normalizeTrackDedupeKey(track.trackId) ||
      track.trackId.trim();
    if (!trackKey) {
      return true;
    }
    if (seenTrackKeys.has(trackKey)) {
      return false;
    }
    seenTrackKeys.add(trackKey);
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

type RowNeighbors = {
  previousRow?: GenerateDraftRequest["rows"][number];
  nextRow?: GenerateDraftRequest["rows"][number];
};

function compareRowsByTime(
  left: GenerateDraftRequest["rows"][number],
  right: GenerateDraftRequest["rows"][number]
): number {
  const leftStart = left.startSeconds;
  const rightStart = right.startSeconds;
  if (leftStart !== null && rightStart !== null && leftStart !== rightStart) {
    return leftStart - rightStart;
  }
  if (leftStart !== null && rightStart === null) {
    return -1;
  }
  if (leftStart === null && rightStart !== null) {
    return 1;
  }
  return left.index - right.index;
}

function buildRowNeighbors(rows: GenerateDraftRequest["rows"]): Map<GenerateDraftRequest["rows"][number], RowNeighbors> {
  const rowsBySpeaker = new Map<string, GenerateDraftRequest["rows"]>();
  for (const row of rows) {
    const speakerRows = rowsBySpeaker.get(row.speakerKey);
    if (speakerRows) {
      speakerRows.push(row);
    } else {
      rowsBySpeaker.set(row.speakerKey, [row]);
    }
  }

  const neighbors = new Map<GenerateDraftRequest["rows"][number], RowNeighbors>();
  for (const speakerRows of rowsBySpeaker.values()) {
    speakerRows.sort(compareRowsByTime);
    for (let index = 0; index < speakerRows.length; index += 1) {
      neighbors.set(speakerRows[index]!, {
        ...(index > 0 ? { previousRow: speakerRows[index - 1] } : {}),
        ...(index + 1 < speakerRows.length ? { nextRow: speakerRows[index + 1] } : {})
      });
    }
  }
  return neighbors;
}

function leadingVisibleContentOffset(text: string): number {
  let offset = 0;
  while (offset < text.length) {
    while (offset < text.length && /\s/u.test(text[offset]!)) {
      offset += 1;
    }
    const opening = text[offset];
    const closing = opening === "[" ? "]" : opening === "<" ? ">" : opening === "{" ? "}" : null;
    if (!closing) {
      break;
    }
    const closingOffset = text.indexOf(closing, offset + 1);
    if (closingOffset < 0) {
      break;
    }
    offset = closingOffset + 1;
  }
  while (offset < text.length && /\s/u.test(text[offset]!)) {
    offset += 1;
  }
  return offset;
}

function trailingVisibleContentEnd(text: string): number {
  let end = text.length;
  while (end > 0) {
    while (end > 0 && /\s/u.test(text[end - 1]!)) {
      end -= 1;
    }
    if (end === 0) {
      break;
    }
    const closing = text[end - 1];
    const opening = closing === "]" ? "[" : closing === ">" ? "<" : closing === "}" ? "{" : null;
    if (!opening) {
      break;
    }
    const openingOffset = text.lastIndexOf(opening, end - 2);
    if (openingOffset < 0) {
      break;
    }
    end = openingOffset;
  }
  return end;
}

function previousRowEndsWithDoubleDash(previousText: string | undefined): boolean {
  if (!previousText) {
    return false;
  }
  const end = trailingVisibleContentEnd(previousText);
  return previousText.slice(0, end).endsWith("--");
}

function stripIllegalEllipses(text: string, allowLeadingContinuation: boolean): string {
  const leadingOffset = leadingVisibleContentOffset(text);
  const head = text.slice(0, leadingOffset);
  let body = text.slice(leadingOffset);
  let leadingPrefix = "";

  const leadingMatch = body.match(/^(?:\.\.\.|…)\s*/u);
  if (leadingMatch) {
    body = body.slice(leadingMatch[0].length);
    if (allowLeadingContinuation) {
      leadingPrefix = "...";
    }
  }

  // Any remaining ellipsis is illegal (mid/end). Prefer cut-off mark.
  body = body.replace(/(?:\.\.\.|…)/gu, "--");
  // Collapse accidental "----" from adjacent replacements.
  body = body.replace(/-{3,}/g, "--");
  // Normalize spaces around mid-row cut markers: "word--word" -> "word-- word"
  body = body.replace(/(\S)--(\S)/g, "$1-- $2");

  return head + leadingPrefix + body;
}

function stabilizeTemporalPunctuation(
  text: string,
  currentRow: GenerateDraftRequest["rows"][number],
  neighbors: RowNeighbors
): { text: string; changed: boolean } {
  let stabilized = text;
  const previousGap =
    neighbors.previousRow?.endSeconds !== null &&
    neighbors.previousRow?.endSeconds !== undefined &&
    currentRow.startSeconds !== null
      ? currentRow.startSeconds - neighbors.previousRow.endSeconds
      : null;
  const allowLeadingContinuation =
    previousGap !== null &&
    previousGap <= 1 &&
    previousRowEndsWithDoubleDash(neighbors.previousRow?.text);
  stabilized = stripIllegalEllipses(stabilized, allowLeadingContinuation);

  const leadingOffset = leadingVisibleContentOffset(stabilized);
  if (previousGap !== null && previousGap > 1 && stabilized.startsWith("...", leadingOffset)) {
    const suffixOffset = leadingOffset + 3 + (stabilized[leadingOffset + 3] === " " ? 1 : 0);
    stabilized = stabilized.slice(0, leadingOffset) + stabilized.slice(suffixOffset);
  }

  const duplicatedTerminalPunctuation = stabilized.match(
    /,([.!?])((?:\s|\[[^[\]\r\n]+\]|<[^<>\r\n]+>|\{[^{}\r\n]+\})*)$/u
  );
  if (duplicatedTerminalPunctuation?.index !== undefined) {
    stabilized =
      stabilized.slice(0, duplicatedTerminalPunctuation.index) +
      duplicatedTerminalPunctuation[1] +
      duplicatedTerminalPunctuation[2];
  }

  const nextGap =
    neighbors.nextRow?.startSeconds !== null &&
    neighbors.nextRow?.startSeconds !== undefined &&
    currentRow.endSeconds !== null
      ? neighbors.nextRow.startSeconds - currentRow.endSeconds
      : null;
  const closesBeforeLongGap = neighbors.nextRow === undefined || (nextGap !== null && nextGap > 1);
  if (closesBeforeLongGap) {
    const terminalComma = stabilized.match(/,((?:\s|\[[^[\]\r\n]+\]|<[^<>\r\n]+>|\{[^{}\r\n]+\})*)$/u);
    if (terminalComma?.index !== undefined) {
      stabilized = stabilized.slice(0, terminalComma.index) + "." + stabilized.slice(terminalComma.index + 1);
    }
  }

  return { text: stabilized, changed: stabilized !== text };
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
  const reasoningEffort = normalizeReasoningEffort(request.reasoningEffort);

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
        reasoningEffort,
        serviceTier,
        systemPrompt,
        testMode
      }));
  const maxAttemptsPerRow = Math.max(1, deps.maxAttemptsPerRow ?? 2);
  const envRowConcurrency = process.env.DRAFT_ROW_CONCURRENCY ? Number(process.env.DRAFT_ROW_CONCURRENCY) : undefined;
  const rowConcurrency = normalizeConcurrency(deps.rowConcurrency ?? envRowConcurrency, request.rows.length);
  const neighborsByRow = buildRowNeighbors(request.rows);

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
          appendAudioClipWarnings(audioWarnings, audioClips);
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
          appendAudioClipWarnings(audioWarnings, audioClips);
        }
      } catch (error) {
        audioWarnings.push(audioWarning(error));
      }
    }

    const neighbors = neighborsByRow.get(currentRow) ?? {};
    const context: RowRewriteContext = {
      currentRow,
      ...neighbors,
      ...(audioClips?.length ? { audioClips, tagSystem } : {})
    };
    const originalRow = context.currentRow;

    let candidate = originalRow.text;
    let rowResult: DraftRowResult | undefined;
    try {
      candidate = await rewriteRowWithRetry(rewriteRow, context, maxAttemptsPerRow);
    } catch (error) {
      const fallback = stabilizeTemporalPunctuation(originalRow.text, originalRow, neighbors);
      rowResult = {
        rowId: originalRow.rowId,
        rewrittenText: fallback.text,
        status: fallback.changed ? "rewritten" : "failed",
        warnings: [
          "rewrite_error",
          error instanceof Error ? error.message : String(error),
          ...(fallback.changed ? ["temporal_punctuation_cleanup"] : []),
          ...audioWarnings
        ]
      };
    }

    if (!rowResult) {
      const stabilized = stabilizeTemporalPunctuation(candidate, originalRow, neighbors);
      const validation = validateRewrittenRow(originalRow.text, stabilized.text);
      rowResult = {
        rowId: originalRow.rowId,
        rewrittenText: validation.acceptedText,
        status: validation.status,
        warnings: [
          ...validation.warnings,
          ...(stabilized.changed ? ["temporal_punctuation_cleanup"] : []),
          ...audioWarnings
        ]
      };
    }
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
