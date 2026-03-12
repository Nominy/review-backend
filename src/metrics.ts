import type {
  Annotation,
  BabelDiffPayload,
  NormalizedState,
  PromptPacket,
  PromptSegmentSample,
  PromptTextDiff
} from "./types";
import { buildBabelDiffPromptPacket } from "./babel-diff";

export const METRICS_VERSION = "v5";
export const PROMPT_VERSION = "v8";

function normalizeWhitespace(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function countWords(text: string): number {
  return normalizeWhitespace(text).split(/\s+/).filter(Boolean).length;
}

function clipText(text: string, maxLen: number): string {
  const value = normalizeWhitespace(text);
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}...`;
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function toSegmentSample(annotation: Annotation): PromptSegmentSample {
  return {
    id: annotation.id,
    text: clipText(annotation.content || "", 220),
    startTimeInSeconds: round(annotation.startTimeInSeconds, 3),
    endTimeInSeconds: round(annotation.endTimeInSeconds, 3)
  };
}

function extractTagTokens(text: string): string[] {
  const value = String(text || "");
  const matches = value.match(/<[^>]+>|\[[^\]]+\]|\{[^}]+\}/g);
  return matches ? matches.map((item) => normalizeWhitespace(item)).filter(Boolean) : [];
}

function pairAnnotationsByIndex(
  original: Annotation[],
  current: Annotation[]
): Array<{ before: Annotation; after: Annotation }> {
  const count = Math.min(original.length, current.length);
  const pairs: Array<{ before: Annotation; after: Annotation }> = [];
  for (let index = 0; index < count; index += 1) {
    const before = original[index];
    const after = current[index];
    if (!before || !after) continue;
    pairs.push({ before, after });
  }
  return pairs;
}

function buildLocalChangedPairs(
  original: Annotation[],
  current: Annotation[]
): {
  changedPairs: PromptTextDiff[];
  localTextChangeCount: number;
  localTagChangeCount: number;
} {
  const pairs = pairAnnotationsByIndex(original, current);
  const changedPairs: PromptTextDiff[] = [];
  let localTextChangeCount = 0;
  let localTagChangeCount = 0;

  for (const pair of pairs) {
    const beforeText = normalizeWhitespace(pair.before.content || "");
    const afterText = normalizeWhitespace(pair.after.content || "");
    const beforeTags = extractTagTokens(pair.before.content || "");
    const afterTags = extractTagTokens(pair.after.content || "");
    const textChanged = beforeText !== afterText;
    const tagsChanged = beforeTags.join(" | ") !== afterTags.join(" | ");

    if (!textChanged && !tagsChanged) {
      continue;
    }

    if (textChanged) localTextChangeCount += 1;
    if (tagsChanged) localTagChangeCount += 1;

    changedPairs.push({
      before: clipText(beforeText, 220),
      after: clipText(afterText, 220),
      beforeTagCount: beforeTags.length,
      afterTagCount: afterTags.length
    });
  }

  return {
    changedPairs: changedPairs.slice(0, 24),
    localTextChangeCount,
    localTagChangeCount
  };
}

function buildTagSamples(annotations: Annotation[]): {
  tagSamples: PromptSegmentSample[];
  tagSegmentCount: number;
} {
  const withTags = annotations.filter((annotation) => extractTagTokens(annotation.content || "").length > 0);
  return {
    tagSamples: withTags.slice(0, 12).map(toSegmentSample),
    tagSegmentCount: withTags.length
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
  const babelDiffPacket = buildBabelDiffPromptPacket(babelDiff);

  const oldText = oldAnnotations.map((annotation) => annotation.content || "").join(" ");
  const newText = newAnnotations.map((annotation) => annotation.content || "").join(" ");
  const originalWords = countWords(oldText);
  const currentWords = countWords(newText);

  const {
    changedPairs,
    localTextChangeCount,
    localTagChangeCount
  } = buildLocalChangedPairs(oldAnnotations, newAnnotations);
  const originalTags = buildTagSamples(oldAnnotations);
  const currentTags = buildTagSamples(newAnnotations);
  const originalOnlySamples = oldAnnotations.slice(newAnnotations.length, newAnnotations.length + 12).map(toSegmentSample);
  const currentOnlySamples = newAnnotations.slice(oldAnnotations.length, oldAnnotations.length + 12).map(toSegmentSample);

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
      localTagChangeCount,
      hasBabelDiff: !!babelDiffPacket
    },
    localTextEvidence: {
      changedPairs,
      originalTagSamples: originalTags.tagSamples,
      currentTagSamples: currentTags.tagSamples,
      originalOnlySamples,
      currentOnlySamples,
      originalTagSegmentCount: originalTags.tagSegmentCount,
      currentTagSegmentCount: currentTags.tagSegmentCount
    },
    ...(babelDiffPacket ? { babelDiff: babelDiffPacket } : {})
  };

  const featurePacket = {
    session: promptPacket.session,
    overview: promptPacket.overview,
    localTextEvidence: {
      changedPairs: promptPacket.localTextEvidence.changedPairs,
      originalTagSamples: promptPacket.localTextEvidence.originalTagSamples,
      currentTagSamples: promptPacket.localTextEvidence.currentTagSamples,
      originalOnlySamples: promptPacket.localTextEvidence.originalOnlySamples,
      currentOnlySamples: promptPacket.localTextEvidence.currentOnlySamples,
      originalTagSegmentCount: promptPacket.localTextEvidence.originalTagSegmentCount,
      currentTagSegmentCount: promptPacket.localTextEvidence.currentTagSegmentCount
    },
    ...(babelDiffPacket ? { babelDiff: babelDiffPacket } : {})
  };

  const stats = {
    original: {
      annotations: oldAnnotations.length,
      words: originalWords,
      lintErrors: Array.isArray(original.lintErrors) ? original.lintErrors.length : 0,
      tagSegments: originalTags.tagSegmentCount
    },
    current: {
      annotations: newAnnotations.length,
      words: currentWords,
      lintErrors: Array.isArray(current.lintErrors) ? current.lintErrors.length : 0,
      tagSegments: currentTags.tagSegmentCount
    },
    changes: {
      localTextChangeCount,
      localTagChangeCount,
      segmentCountDelta: newAnnotations.length - oldAnnotations.length,
      previewBefore: clipText(oldText, 240),
      previewAfter: clipText(newText, 240),
      babelDiffUsed: !!babelDiffPacket
    }
  };

  return {
    stats,
    featurePacket,
    promptPacket,
    metricsVersion: METRICS_VERSION
  };
}
