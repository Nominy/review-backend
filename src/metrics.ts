import { classifyStablePair, toPromptSample, type EditAtom } from "./edit-attribution";
import type { Annotation, CategoryName, NormalizedState, PromptCategoryEvidence, PromptPacket } from "./types";

export const METRICS_VERSION = "v3";
export const PROMPT_VERSION = "v3";

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

function buildScoreCap(category: CategoryName, atoms: EditAtom[], isMicroEdit: boolean): 1 | 2 | 3 {
  const count = atoms.length;
  const materialOrWorse = atoms.filter((atom) => atom.severity !== "minor").length;
  const severe = atoms.filter((atom) => atom.severity === "severe").length;

  if (!count) return 1;
  if (isMicroEdit && count <= 1) return 1;

  let cap: 1 | 2 | 3 = 1;

  switch (category) {
    case "Word Accuracy":
      if (severe >= 5 || materialOrWorse >= 5 || count >= 5) cap = 3;
      else if (materialOrWorse >= 2 || count >= 2) cap = 2;
      break;
    case "Timestamp Accuracy":
      if (severe >= 3) cap = 3;
      else if (materialOrWorse >= 2) cap = 2;
      break;
    case "Punctuation & Formatting":
      if (count >= 5) cap = 3;
      else if (count >= 2) cap = 2;
      break;
    case "Tags & Emphasis":
      if (count >= 4 || severe >= 4) cap = 3;
      else if (count >= 2) cap = 2;
      break;
    case "Segmentation":
      if (count >= 4 || severe >= 4) cap = 3;
      else if (materialOrWorse >= 2 || count >= 2) cap = 2;
      break;
  }

  if (isMicroEdit && cap === 3) {
    return 2;
  }

  return cap;
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
  const oldAnnotations = Array.isArray(original.annotations) ? original.annotations : [];
  const newAnnotations = Array.isArray(current.annotations) ? current.annotations : [];
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
  if (segmentCountDelta !== 0) {
    const anchor =
      (segmentCountDelta > 0 ? newAnnotations[0] : oldAnnotations[0]) ??
      oldAnnotations[0] ??
      newAnnotations[0];
    if (anchor) {
      const absoluteDelta = Math.abs(segmentCountDelta);
      grouped.Segmentation.push({
        kind: segmentCountDelta > 0 ? "segment_count_increase" : "segment_count_decrease",
        ownerCategory: "Segmentation",
        severity: absoluteDelta >= 4 ? "severe" : absoluteDelta >= 2 ? "material" : "minor",
        annotationId: anchor.id,
        note:
          segmentCountDelta > 0
            ? `QA finished with ${absoluteDelta} more segments.`
            : `QA finished with ${absoluteDelta} fewer segments.`,
        before: segmentCountDelta < 0 ? clipText(anchor.content || "", 220) : undefined,
        after: segmentCountDelta > 0 ? clipText(anchor.content || "", 220) : undefined
      });
    }
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
      addedSegments: Math.max(segmentCountDelta, 0),
      deletedSegments: Math.max(-segmentCountDelta, 0),
      splitEvents: 0,
      combineEvents: 0
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
