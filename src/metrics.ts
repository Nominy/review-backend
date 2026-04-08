import type {
  Annotation,
  BabelDiffPayload,
  NormalizedState,
  PromptPacket,
  PromptSegmentSample,
  PromptTextDiff
} from "./types";
import { buildStructuralDiffPromptPacket } from "./structural-diff";
import { alignSegments, diffWords } from "./text-diff";

export const METRICS_VERSION = "v8";
export const PROMPT_VERSION = "v15";

function normalizeWhitespace(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function countWords(text: string): number {
  return normalizeWhitespace(text).split(/\s+/).filter(Boolean).length;
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function overlapMs(left: Annotation, right: Annotation): number {
  const start = Math.max(left.startTimeInSeconds, right.startTimeInSeconds);
  const end = Math.min(left.endTimeInSeconds, right.endTimeInSeconds);
  return Math.max(0, (end - start) * 1000);
}

function stripTags(text: string): string {
  return String(text || "").replace(/<[^>]+>|\[[^\]]+\]|\{[^}]+\}/g, " ");
}

function tokenize(text: string): string[] {
  return normalizeWhitespace(text)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function tokenOverlapRatio(before: string, after: string): number {
  const left = new Set(tokenize(before));
  const right = new Set(tokenize(after));
  if (!left.size || !right.size) {
    return 0;
  }
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) {
      shared += 1;
    }
  }
  return shared / Math.min(left.size, right.size);
}

function isUsefulLocalChangedPair(input: {
  before: Annotation;
  after: Annotation;
  beforeText: string;
  afterText: string;
}): boolean {
  const beforeWordCount = countWords(stripTags(input.beforeText));
  const afterWordCount = countWords(stripTags(input.afterText));
  const shorter = Math.max(1, Math.min(beforeWordCount, afterWordCount));
  const longer = Math.max(beforeWordCount, afterWordCount);
  const wordRatio = longer / shorter;
  const overlap = overlapMs(input.before, input.after);
  const sharedTokenRatio = tokenOverlapRatio(input.beforeText, input.afterText);

  if (overlap < 120) {
    return false;
  }

  if (sharedTokenRatio < 0.3) {
    return false;
  }

  if (wordRatio > 3) {
    return false;
  }

  return true;
}

function toSegmentSample(annotation: Annotation): PromptSegmentSample {
  return {
    id: annotation.id,
    text: annotation.content || "",
    startTimeInSeconds: round(annotation.startTimeInSeconds, 3),
    endTimeInSeconds: round(annotation.endTimeInSeconds, 3)
  };
}

function buildLocalChangedPairs(
  original: Annotation[],
  current: Annotation[]
): {
  changedPairs: PromptTextDiff[];
  localTextChangeCount: number;
  deletedSegments: Annotation[];
  insertedSegments: Annotation[];
} {
  const aligned = alignSegments(original, current);
  const changedPairs: PromptTextDiff[] = [];
  let localTextChangeCount = 0;
  const deletedSegments: Annotation[] = [];
  const insertedSegments: Annotation[] = [];

  for (const pair of aligned) {
    if (pair.op === "deleted") {
      deletedSegments.push(pair.before!);
      localTextChangeCount += 1;
      continue;
    }
    if (pair.op === "inserted") {
      insertedSegments.push(pair.after!);
      localTextChangeCount += 1;
      continue;
    }

    // matched pair — keep only actual text diffs and let the diff output
    // carry any inline tag edits naturally inside the text evidence.
    const beforeText = normalizeWhitespace(pair.before!.content || "");
    const afterText = normalizeWhitespace(pair.after!.content || "");
    const textChanged = beforeText !== afterText;

    if (!textChanged) {
      continue;
    }

    if (!isUsefulLocalChangedPair({
      before: pair.before!,
      after: pair.after!,
      beforeText,
      afterText
    })) {
      continue;
    }

    if (textChanged) localTextChangeCount += 1;

    // Split a long segment-level edit into localized snippet groups so the
    // prompt only carries the words around each actual change.
    const wordDiff = textChanged ? diffWords(beforeText, afterText) : null;
    const snippets = wordDiff?.snippets?.length
      ? wordDiff.snippets
      : [{
          before: beforeText,
          after: afterText,
          inline: wordDiff?.inline || "",
          editCount: wordDiff?.editCount || 0
        }];

    for (const snippet of snippets) {
      changedPairs.push({
        before: snippet.before,
        after: snippet.after,
        ...(snippet.inline ? { inlineDiff: snippet.inline } : {}),
        ...(snippet.editCount ? { editCount: snippet.editCount } : {})
      });
    }
  }

  return {
    changedPairs: changedPairs.slice(0, 24),
    localTextChangeCount,
    deletedSegments: deletedSegments.slice(0, 12),
    insertedSegments: insertedSegments.slice(0, 12)
  };
}

export function computeReviewMetrics(
  original: NormalizedState,
  current: NormalizedState,
  actionId: string,
  babelDiff?: BabelDiffPayload | null
): {
  stats: Record<string, unknown>;
  featurePacket: Record<string, unknown>;
  promptPacket: PromptPacket;
  metricsVersion: string;
} {
  const oldAnnotations = Array.isArray(original.annotations) ? original.annotations : [];
  const newAnnotations = Array.isArray(current.annotations) ? current.annotations : [];
  const structuralDiffPacket = buildStructuralDiffPromptPacket(oldAnnotations, newAnnotations);

  const oldText = oldAnnotations.map((annotation) => annotation.content || "").join(" ");
  const newText = newAnnotations.map((annotation) => annotation.content || "").join(" ");
  const originalWords = countWords(oldText);
  const currentWords = countWords(newText);

  const {
    changedPairs,
    localTextChangeCount,
    deletedSegments,
    insertedSegments
  } = buildLocalChangedPairs(oldAnnotations, newAnnotations);
  const originalOnlySamples = deletedSegments.map(toSegmentSample);
  const currentOnlySamples = insertedSegments.map(toSegmentSample);

  const promptPacket: PromptPacket = {
    session: {
      actionId,
      metricsVersion: METRICS_VERSION,
      promptVersion: PROMPT_VERSION
    },
    overview: {
      originalSegments: oldAnnotations.length,
      currentSegments: newAnnotations.length,
      originalWords,
      currentWords,
      segmentCountDelta: newAnnotations.length - oldAnnotations.length,
      localTextChangeCount,
      hasStructuralDiff: true
    },
    localTextEvidence: {
      changedPairs,
      originalOnlySamples,
      currentOnlySamples
    },
    structuralDiff: structuralDiffPacket
  };

  const featurePacket = {
    session: promptPacket.session,
    overview: promptPacket.overview,
    localTextEvidence: {
      changedPairs: promptPacket.localTextEvidence.changedPairs,
      originalOnlySamples: promptPacket.localTextEvidence.originalOnlySamples,
      currentOnlySamples: promptPacket.localTextEvidence.currentOnlySamples
    },
    structuralDiff: structuralDiffPacket
  };

  const stats = {
    original: {
      annotations: oldAnnotations.length,
      words: originalWords,
      lintErrors: Array.isArray(original.lintErrors) ? original.lintErrors.length : 0
    },
    current: {
      annotations: newAnnotations.length,
      words: currentWords,
      lintErrors: Array.isArray(current.lintErrors) ? current.lintErrors.length : 0
    },
    changes: {
      localTextChangeCount,
      segmentCountDelta: newAnnotations.length - oldAnnotations.length,
      previewBefore: oldText,
      previewAfter: newText,
      structuralDiffUsed: true,
      babelDiffCaptured: !!babelDiff
    }
  };

  return {
    stats,
    featurePacket,
    promptPacket,
    metricsVersion: METRICS_VERSION
  };
}
