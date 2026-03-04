import type {
  Annotation,
  NormalizedState,
  PromptPacket,
  PromptSegmentSample,
  PromptTextDiff,
  PromptTimingDiff
} from "./types";

export const METRICS_VERSION = "v4";
export const PROMPT_VERSION = "v6";

type LinkSummary = {
  oldToNew: Map<string, string[]>;
  newToOld: Map<string, string[]>;
  stablePairs: Array<{ oldId: string; newId: string }>;
};

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

function overlapMs(a: Annotation, b: Annotation): number {
  const start = Math.max(a.startTimeInSeconds, b.startTimeInSeconds);
  const end = Math.min(a.endTimeInSeconds, b.endTimeInSeconds);
  return Math.max(0, (end - start) * 1000);
}

function durationMs(annotation: Annotation): number {
  return Math.max(0, (annotation.endTimeInSeconds - annotation.startTimeInSeconds) * 1000);
}

function buildLinks(oldAnnotations: Annotation[], newAnnotations: Annotation[]): LinkSummary {
  const oldToNew = new Map<string, string[]>();
  const newToOld = new Map<string, string[]>();
  const oldStrongLinks = new Map<string, Array<{ id: string; overlap: number }>>();
  const newStrongLinks = new Map<string, Array<{ id: string; overlap: number }>>();

  for (const oldSeg of oldAnnotations) {
    oldToNew.set(oldSeg.id, []);
    oldStrongLinks.set(oldSeg.id, []);
  }
  for (const newSeg of newAnnotations) {
    newToOld.set(newSeg.id, []);
    newStrongLinks.set(newSeg.id, []);
  }

  for (const oldSeg of oldAnnotations) {
    for (const newSeg of newAnnotations) {
      const overlap = overlapMs(oldSeg, newSeg);
      const minDuration = Math.min(durationMs(oldSeg), durationMs(newSeg));
      const strongEnough = overlap >= 120 && overlap >= minDuration * 0.25;
      if (!strongEnough) continue;
      oldToNew.get(oldSeg.id)?.push(newSeg.id);
      newToOld.get(newSeg.id)?.push(oldSeg.id);
      oldStrongLinks.get(oldSeg.id)?.push({ id: newSeg.id, overlap });
      newStrongLinks.get(newSeg.id)?.push({ id: oldSeg.id, overlap });
    }
  }

  const bestOldToNew = new Map<string, string>();
  for (const [oldId, links] of oldStrongLinks.entries()) {
    const best = [...links].sort((a, b) => b.overlap - a.overlap)[0];
    if (best) {
      bestOldToNew.set(oldId, best.id);
    }
  }

  const bestNewToOld = new Map<string, string>();
  for (const [newId, links] of newStrongLinks.entries()) {
    const best = [...links].sort((a, b) => b.overlap - a.overlap)[0];
    if (best) {
      bestNewToOld.set(newId, best.id);
    }
  }

  const stablePairs: Array<{ oldId: string; newId: string }> = [];
  for (const [oldId, newId] of bestOldToNew.entries()) {
    const oldLinks = oldToNew.get(oldId) || [];
    const newLinks = newToOld.get(newId) || [];

    // Only treat a pair as stable when the overlap graph is strictly one-to-one.
    // Split/merge structures should stay in segmentationDiffs instead of leaking
    // into textDiffs and timingDiffs as if they were simple replacements.
    if (oldLinks.length === 1 && newLinks.length === 1 && bestNewToOld.get(newId) === oldId) {
      stablePairs.push({ oldId, newId });
    }
  }

  return { oldToNew, newToOld, stablePairs };
}

function toSegmentSample(annotation: Annotation): PromptSegmentSample {
  return {
    id: annotation.id,
    text: clipText(annotation.content || "", 220),
    startTimeInSeconds: round(annotation.startTimeInSeconds, 3),
    endTimeInSeconds: round(annotation.endTimeInSeconds, 3)
  };
}

export function computeReviewMetrics(
  original: NormalizedState,
  current: NormalizedState,
  actionId: string
): {
  stats: Record<string, unknown>;
  featurePacket: Record<string, unknown>;
  promptPacket: PromptPacket;
  metricsVersion: string;
} {
  const oldAnnotations = Array.isArray(original.annotations) ? original.annotations : [];
  const newAnnotations = Array.isArray(current.annotations) ? current.annotations : [];
  const oldMap = new Map(oldAnnotations.map((annotation) => [annotation.id, annotation]));
  const newMap = new Map(newAnnotations.map((annotation) => [annotation.id, annotation]));
  const links = buildLinks(oldAnnotations, newAnnotations);
  const stableOldIds = new Set(links.stablePairs.map((pair) => pair.oldId));
  const stableNewIds = new Set(links.stablePairs.map((pair) => pair.newId));

  const textDiffs: PromptTextDiff[] = [];
  const timingDiffs: PromptTimingDiff[] = [];

  for (const pair of links.stablePairs) {
    const before = oldMap.get(pair.oldId);
    const after = newMap.get(pair.newId);
    if (!before || !after) continue;

    const beforeText = normalizeWhitespace(before.content || "");
    const afterText = normalizeWhitespace(after.content || "");

    if (beforeText !== afterText) {
      textDiffs.push({
        oldId: before.id,
        newId: after.id,
        before: clipText(beforeText, 220),
        after: clipText(afterText, 220),
        oldStartTimeInSeconds: round(before.startTimeInSeconds, 3),
        oldEndTimeInSeconds: round(before.endTimeInSeconds, 3),
        newStartTimeInSeconds: round(after.startTimeInSeconds, 3),
        newEndTimeInSeconds: round(after.endTimeInSeconds, 3)
      });
    }

    const startShiftMs = Math.round((after.startTimeInSeconds - before.startTimeInSeconds) * 1000);
    const endShiftMs = Math.round((after.endTimeInSeconds - before.endTimeInSeconds) * 1000);
    if (Math.abs(startShiftMs) >= 120 || Math.abs(endShiftMs) >= 120) {
      timingDiffs.push({
        oldId: before.id,
        newId: after.id,
        text: clipText(afterText || beforeText, 220),
        startShiftMs,
        endShiftMs
      });
    }
  }

  const unmatchedOriginal = oldAnnotations
    .filter((annotation) => !stableOldIds.has(annotation.id))
    .map(toSegmentSample);
  const unmatchedCurrent = newAnnotations
    .filter((annotation) => !stableNewIds.has(annotation.id))
    .map(toSegmentSample);

  const limitedTextDiffs = textDiffs.slice(0, 24);
  const limitedTimingDiffs = timingDiffs
    .sort(
      (left, right) =>
        Math.max(Math.abs(right.startShiftMs), Math.abs(right.endShiftMs)) -
        Math.max(Math.abs(left.startShiftMs), Math.abs(left.endShiftMs))
    )
    .slice(0, 24);
  const limitedUnmatchedOriginal = unmatchedOriginal.slice(0, 12);
  const limitedUnmatchedCurrent = unmatchedCurrent.slice(0, 12);

  const promptPacket: PromptPacket = {
    session: {
      actionId,
      metricsVersion: METRICS_VERSION,
      promptVersion: PROMPT_VERSION
    },
    overview: {
      originalSegments: oldAnnotations.length,
      currentSegments: newAnnotations.length,
      stablePairs: links.stablePairs.length,
      textDiffCount: textDiffs.length,
      timingDiffCount: timingDiffs.length,
      unmatchedOriginalCount: unmatchedOriginal.length,
      unmatchedCurrentCount: unmatchedCurrent.length
    },
    textDiffs: limitedTextDiffs,
    timingDiffs: limitedTimingDiffs,
    segmentationDiffs: {
      segmentCountDelta: newAnnotations.length - oldAnnotations.length,
      unmatchedOriginal: limitedUnmatchedOriginal,
      unmatchedCurrent: limitedUnmatchedCurrent
    }
  };

  const oldText = oldAnnotations.map((annotation) => annotation.content || "").join(" ");
  const newText = newAnnotations.map((annotation) => annotation.content || "").join(" ");

  const featurePacket = {
    session: promptPacket.session,
    overview: promptPacket.overview,
    samples: {
      textDiffs: limitedTextDiffs,
      timingDiffs: limitedTimingDiffs,
      unmatchedOriginal: limitedUnmatchedOriginal,
      unmatchedCurrent: limitedUnmatchedCurrent
    }
  };

  const stats = {
    original: {
      annotations: oldAnnotations.length,
      words: countWords(oldText),
      lintErrors: Array.isArray(original.lintErrors) ? original.lintErrors.length : 0
    },
    current: {
      annotations: newAnnotations.length,
      words: countWords(newText),
      lintErrors: Array.isArray(current.lintErrors) ? current.lintErrors.length : 0
    },
    changes: {
      stablePairs: links.stablePairs.length,
      textDiffCount: textDiffs.length,
      timingDiffCount: timingDiffs.length,
      unmatchedOriginalCount: unmatchedOriginal.length,
      unmatchedCurrentCount: unmatchedCurrent.length,
      segmentCountDelta: newAnnotations.length - oldAnnotations.length,
      previewBefore: clipText(oldText, 240),
      previewAfter: clipText(newText, 240)
    }
  };

  return {
    stats,
    featurePacket,
    promptPacket,
    metricsVersion: METRICS_VERSION
  };
}
