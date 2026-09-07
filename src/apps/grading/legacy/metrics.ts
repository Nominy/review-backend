import { reviewEvidenceAnnotations } from '../../../guidelines';
import { buildScoreCap } from '../policy';
import { classifyStablePair, toPromptSample, type EditAtom } from "./edit-attribution";
import type { Annotation, CategoryName, NormalizedState, PromptCategoryEvidence, PromptPacket } from "./types";

export const METRICS_VERSION = "v4";
export const PROMPT_VERSION = "v4-ru-guidelines";

type LinkSummary = {
  oldToNew: Map<string, string[]>;
  newToOld: Map<string, string[]>;
  stablePairs: Array<{ oldId: string; newId: string }>;
};

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function clipText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
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
      // Restored grader: coincident speech on another track is not a matching segment.
      if (oldSeg.processedRecordingId !== newSeg.processedRecordingId) continue;
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
    if (best) bestOldToNew.set(oldId, best.id);
  }

  const bestNewToOld = new Map<string, string>();
  for (const [newId, links] of newStrongLinks.entries()) {
    const best = [...links].sort((a, b) => b.overlap - a.overlap)[0];
    if (best) bestNewToOld.set(newId, best.id);
  }

  const stablePairs: Array<{ oldId: string; newId: string }> = [];
  for (const [oldId, newId] of bestOldToNew.entries()) {
    if (bestNewToOld.get(newId) !== oldId) continue;
    // Split/combine components belong to Segmentation, not lexical or timing grades.
    if (oldToNew.get(oldId)?.length !== 1 || newToOld.get(newId)?.length !== 1) continue;
    stablePairs.push({ oldId, newId });
  }

  return { oldToNew, newToOld, stablePairs };
}

function emptyCategoryEvidence(): PromptCategoryEvidence {
  return {
    count: 0,
    dominantKinds: [],
    samples: []
  };
}

function summarizeCategory(atoms: EditAtom[]): PromptCategoryEvidence {
  if (!atoms.length) {
    return emptyCategoryEvidence();
  }

  const kindCounts = new Map<string, number>();
  for (const atom of atoms) {
    kindCounts.set(atom.kind, (kindCounts.get(atom.kind) || 0) + 1);
  }

  const dominantKinds = [...kindCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([kind]) => kind);

  return {
    count: atoms.length,
    dominantKinds,
    samples: atoms.slice(0, 3).map(toPromptSample)
  };
}

function buildOwnershipSummary(grouped: Record<CategoryName, EditAtom[]>) {
  return {
    wordOwned: grouped["Word Accuracy"].length,
    timestampOwned: grouped["Timestamp Accuracy"].length,
    punctuationOwned: grouped["Punctuation & Formatting"].length,
    tagsOwned: grouped["Tags & Emphasis"].length,
    segmentationOwned: grouped["Segmentation"].length
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
  const oldAnnotations = reviewEvidenceAnnotations(Array.isArray(original.annotations) ? original.annotations : []);
  const newAnnotations = reviewEvidenceAnnotations(Array.isArray(current.annotations) ? current.annotations : []);
  const oldMap = new Map(oldAnnotations.map((annotation) => [annotation.id, annotation]));
  const newMap = new Map(newAnnotations.map((annotation) => [annotation.id, annotation]));
  const links = buildLinks(oldAnnotations, newAnnotations);

  const grouped: Record<CategoryName, EditAtom[]> = {
    "Word Accuracy": [],
    "Timestamp Accuracy": [],
    "Punctuation & Formatting": [],
    "Tags & Emphasis": [],
    Segmentation: []
  };

  const segmentCountDelta = newAnnotations.length - oldAnnotations.length;
  // Count distinct structural events even when a split and combine cancel the net count.
  const visitedOld = new Set<string>();
  const visitedNew = new Set<string>();
  for (const first of oldAnnotations) {
    if (visitedOld.has(first.id)) continue;
    const beforeIds = new Set<string>();
    const afterIds = new Set<string>();
    const pending = [first.id];
    while (pending.length) {
      const id = pending.pop()!;
      if (beforeIds.has(id)) continue;
      beforeIds.add(id); visitedOld.add(id);
      for (const next of links.oldToNew.get(id) ?? []) {
        afterIds.add(next); visitedNew.add(next);
        for (const previous of links.newToOld.get(next) ?? []) if (!beforeIds.has(previous)) pending.push(previous);
      }
    }
    if (beforeIds.size === 1 && afterIds.size === 1) continue;
    const kind = !afterIds.size ? 'segment_deleted' : beforeIds.size === 1 ? 'segment_split' : afterIds.size === 1 ? 'segments_combined' : 'segments_restructured';
    grouped.Segmentation.push({ kind, ownerCategory: 'Segmentation', severity: 'material', annotationId: first.id,
      note: `${beforeIds.size} исходных сегментов преобразованы в ${afterIds.size} проверенных.`,
      before: clipText([...beforeIds].map(id => oldMap.get(id)?.content ?? '').join(' '), 220),
      after: clipText([...afterIds].map(id => newMap.get(id)?.content ?? '').join(' '), 220) });
  }
  for (const segment of newAnnotations) {
    if (visitedNew.has(segment.id)) continue;
    grouped.Segmentation.push({ kind: 'segment_added', ownerCategory: 'Segmentation', severity: 'material', annotationId: segment.id,
      note: 'При проверке добавлен сегмент.', after: clipText(segment.content, 220) });
  }

  let changedSegments = 0;
  for (const pair of links.stablePairs) {
    const before = oldMap.get(pair.oldId);
    const after = newMap.get(pair.newId);
    if (!before || !after) continue;
    if ((before.content || "") !== (after.content || "")) {
      changedSegments += 1;
    }

    const atom = classifyStablePair(before, after);
    if (!atom) continue;
    grouped[atom.ownerCategory].push(atom);
  }

  const stableMatchedSegments = links.stablePairs.length;
  const changedSegmentRatio = stableMatchedSegments ? changedSegments / stableMatchedSegments : 0;
  const ownershipSummary = buildOwnershipSummary(grouped);
  const totalOwnedEdits =
    ownershipSummary.wordOwned +
    ownershipSummary.timestampOwned +
    ownershipSummary.punctuationOwned +
    ownershipSummary.tagsOwned +
    ownershipSummary.segmentationOwned;
  const hasSevereTiming = grouped["Timestamp Accuracy"].some((atom) => atom.severity === "severe");
  const isMicroEdit =
    changedSegmentRatio < 0.1 &&
    Math.abs(segmentCountDelta) <= 1 &&
    totalOwnedEdits <= 2 &&
    !hasSevereTiming;

  const scoreCaps: Record<CategoryName, 1 | 2 | 3> = {
    "Word Accuracy": buildScoreCap("Word Accuracy", grouped["Word Accuracy"], isMicroEdit),
    "Timestamp Accuracy": buildScoreCap("Timestamp Accuracy", grouped["Timestamp Accuracy"], isMicroEdit),
    "Punctuation & Formatting": buildScoreCap("Punctuation & Formatting", grouped["Punctuation & Formatting"], isMicroEdit),
    "Tags & Emphasis": buildScoreCap("Tags & Emphasis", grouped["Tags & Emphasis"], isMicroEdit),
    Segmentation: buildScoreCap("Segmentation", grouped.Segmentation, isMicroEdit)
  };

  const promptPacket: PromptPacket = {
    session: {
      actionId,
      metricsVersion: METRICS_VERSION,
      promptVersion: PROMPT_VERSION
    },
    editFootprint: {
      stableMatchedSegments,
      changedSegments,
      changedSegmentRatio: round(changedSegmentRatio, 4),
      segmentCountDelta,
      isMicroEdit
    },
    ownershipSummary,
    categoryEvidence: {
      wordAccuracy: summarizeCategory(grouped["Word Accuracy"]),
      timestampAccuracy: summarizeCategory(grouped["Timestamp Accuracy"]),
      punctuationFormatting: summarizeCategory(grouped["Punctuation & Formatting"]),
      tagsEmphasis: summarizeCategory(grouped["Tags & Emphasis"]),
      segmentation: summarizeCategory(grouped.Segmentation)
    },
    scoreCaps
  };

  const featurePacket = {
    session: promptPacket.session,
    editFootprint: promptPacket.editFootprint,
    segmentationGraph: {
      addedSegments: grouped.Segmentation.filter(atom => atom.kind === 'segment_added').length,
      deletedSegments: grouped.Segmentation.filter(atom => atom.kind === 'segment_deleted').length,
      splitEvents: grouped.Segmentation.filter(atom => atom.kind === 'segment_split').length,
      combineEvents: grouped.Segmentation.filter(atom => atom.kind === 'segments_combined').length
    },
    ownershipSummary,
    categoryEvidence: promptPacket.categoryEvidence,
    scoreCaps
  };

  const oldText = oldAnnotations.map((annotation) => annotation.content || "").join(" ");
  const newText = newAnnotations.map((annotation) => annotation.content || "").join(" ");

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
      stableMatchedSegments,
      changedSegments,
      changedSegmentRatio: round(changedSegmentRatio, 4),
      segmentCountDelta,
      isMicroEdit,
      ownershipSummary,
      scoreCaps,
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
