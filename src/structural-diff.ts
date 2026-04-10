import { diffWords } from "./text-diff";
import type { Annotation, PromptPacket } from "./types";

type StructuralDiffPromptPacket = NonNullable<PromptPacket["structuralDiff"]>;

type DiffSegment = {
  annotationId: string;
  processedRecordingId: string;
  text: string;
  startTimeInSeconds: number;
  endTimeInSeconds: number;
};

type SegmentShift = {
  edge: "start" | "end";
  deltaMs: number;
};

type StructuralChange =
  | {
      type: "timestamp-shift";
      base: DiffSegment;
      current: DiffSegment;
      shifts: SegmentShift[];
    }
  | {
      type: "split";
      base: DiffSegment;
      parts: DiffSegment[];
    }
  | {
      type: "merge";
      bases: DiffSegment[];
      current: DiffSegment;
    }
  | {
      type: "deleted";
      base: DiffSegment;
    }
  | {
      type: "added";
      current: DiffSegment;
    };

type DiffResult = {
  baseSegmentCount: number;
  currentSegmentCount: number;
  changes: StructuralChange[];
  unchangedCount: number;
  matchedCount: number;
  exactMatchCount: number;
  oneToOneShiftAveragesMs: number[];
};

const DIFF_TOLERANCE_SECONDS = 0.02;
const DIFF_TOLERANCE_MS = DIFF_TOLERANCE_SECONDS * 1000;

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function clipText(text: string, maxLen: number): string {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= maxLen) {
    return value;
  }
  return `${value.slice(0, maxLen)}...`;
}

function sortSegments<T extends DiffSegment>(segments: T[]): T[] {
  return [...segments].sort(
    (left, right) =>
      left.startTimeInSeconds - right.startTimeInSeconds ||
      left.endTimeInSeconds - right.endTimeInSeconds,
  );
}

function normalizeSegment(annotation: Annotation): DiffSegment {
  return {
    annotationId: String(annotation.id || ""),
    processedRecordingId: String(annotation.processedRecordingId || ""),
    text: String(annotation.content || ""),
    startTimeInSeconds: round(
      Math.min(annotation.startTimeInSeconds, annotation.endTimeInSeconds),
    ),
    endTimeInSeconds: round(
      Math.max(annotation.startTimeInSeconds, annotation.endTimeInSeconds),
    ),
  };
}

function normalizeSegments(annotations: Annotation[]): DiffSegment[] {
  return sortSegments(annotations.map(normalizeSegment));
}

function getOverlapDuration(left: DiffSegment, right: DiffSegment): number {
  if (left.processedRecordingId !== right.processedRecordingId) {
    return 0;
  }
  return Math.max(
    0,
    Math.min(left.endTimeInSeconds, right.endTimeInSeconds) -
      Math.max(left.startTimeInSeconds, right.startTimeInSeconds),
  );
}

function overlaps(left: DiffSegment, right: DiffSegment): boolean {
  return getOverlapDuration(left, right) > DIFF_TOLERANCE_SECONDS;
}

function createShift(edge: "start" | "end", deltaSeconds: number): SegmentShift | null {
  const deltaMs = Math.round(deltaSeconds * 1000);
  if (Math.abs(deltaMs) <= DIFF_TOLERANCE_MS) {
    return null;
  }

  return {
    edge,
    deltaMs,
  };
}

function getAnchor(change: StructuralChange): number {
  if (change.type === "added") {
    return change.current.startTimeInSeconds;
  }

  if (change.type === "merge") {
    return change.bases[0]?.startTimeInSeconds ?? change.current.startTimeInSeconds;
  }

  return change.base.startTimeInSeconds;
}

function tokenize(text: string): string[] {
  return String(text || "").trim().split(/\s+/).filter(Boolean);
}

function toChangedTokenSamples(
  beforeText: string,
  afterText: string,
  maxItems: number,
): Array<{ value: string; status: string }> {
  const diff = diffWords(beforeText, afterText);
  const samples: Array<{ value: string; status: string }> = [];

  for (const edit of diff.edits) {
    if (edit.op === "equal") {
      continue;
    }

    const status = edit.op === "insert" ? "added" : "removed";
    for (const token of tokenize(edit.text)) {
      samples.push({
        value: clipText(token, 80),
        status,
      });
      if (samples.length >= maxItems) {
        return samples;
      }
    }
  }

  return samples;
}

function summarizeWordDiff(beforeText: string, afterText: string): {
  substitutions: number;
  insertions: number;
  deletions: number;
  changedTokens: Array<{ value: string; status: string }>;
} {
  const diff = diffWords(beforeText, afterText);
  let substitutions = 0;
  let insertions = 0;
  let deletions = 0;

  for (let index = 0; index < diff.edits.length; index += 1) {
    const current = diff.edits[index];
    const next = diff.edits[index + 1];
    if (
      current?.op === "delete" &&
      next?.op === "insert"
    ) {
      const deletedCount = tokenize(current.text).length;
      const insertedCount = tokenize(next.text).length;
      substitutions += Math.min(deletedCount, insertedCount);
      deletions += Math.max(0, deletedCount - insertedCount);
      insertions += Math.max(0, insertedCount - deletedCount);
      index += 1;
      continue;
    }

    if (current?.op === "insert") {
      insertions += tokenize(current.text).length;
    } else if (current?.op === "delete") {
      deletions += tokenize(current.text).length;
    }
  }

  return {
    substitutions,
    insertions,
    deletions,
    changedTokens: toChangedTokenSamples(beforeText, afterText, 16),
  };
}

function joinTexts(segments: DiffSegment[]): string {
  return segments
    .map((segment) => String(segment.text || "").trim())
    .filter(Boolean)
    .join(" ");
}

function toMappingSegments(
  segments: DiffSegment[],
): Array<{
  annotationId: string;
  text: string;
  startTimeInSeconds: number | null;
  endTimeInSeconds: number | null;
  wordRange: [number, number] | null;
}> {
  return segments.map((segment) => ({
    annotationId: segment.annotationId,
    text: clipText(segment.text, 220),
    startTimeInSeconds: round(segment.startTimeInSeconds, 3),
    endTimeInSeconds: round(segment.endTimeInSeconds, 3),
    wordRange: null,
  }));
}

function classifyTimestampQuality(avgShiftMs: number): string {
  if (avgShiftMs <= DIFF_TOLERANCE_MS) {
    return "high";
  }
  if (avgShiftMs <= 50) {
    return "medium";
  }
  if (avgShiftMs <= 100) {
    return "low";
  }
  return "poor";
}

function isExactSegmentMatch(base: DiffSegment, current: DiffSegment): boolean {
  return (
    base.processedRecordingId === current.processedRecordingId &&
    base.text === current.text &&
    Math.abs(base.startTimeInSeconds - current.startTimeInSeconds) <= DIFF_TOLERANCE_SECONDS &&
    Math.abs(base.endTimeInSeconds - current.endTimeInSeconds) <= DIFF_TOLERANCE_SECONDS
  );
}

function buildTimestampOverview(result: DiffResult): StructuralDiffPromptPacket["timestamp"]["overview"] {
  const matched = result.oneToOneShiftAveragesMs.length;
  const exactMatchCount = result.exactMatchCount;
  const avgShiftMs = matched
    ? round(
        result.oneToOneShiftAveragesMs.reduce((sum, value) => sum + value, 0) / matched,
        1,
      )
    : null;

  const within = (thresholdMs: number): number | null => {
    if (!matched) {
      return null;
    }
    const count = result.oneToOneShiftAveragesMs.filter((value) => value <= thresholdMs).length;
    return round((count / matched) * 100, 1);
  };

  const precisionBase = result.currentSegmentCount;
  const recallBase = result.baseSegmentCount;
  const precision = precisionBase ? exactMatchCount / precisionBase : 1;
  const recall = recallBase ? exactMatchCount / recallBase : 1;
  const f1 =
    precision + recall > 0
      ? round((2 * precision * recall) / (precision + recall), 4)
      : null;

  return {
    precision: round(precision, 4),
    recall: round(recall, 4),
    f1,
    totalSegments: result.baseSegmentCount,
    matchedSegments: result.matchedCount,
    unmatchedSegments: result.baseSegmentCount - result.matchedCount,
    avgShiftMs,
    within50ms: within(50),
    within100ms: within(100),
    within200ms: within(200),
  };
}

function buildDiffResult(baseSnapshot: DiffSegment[], currentSnapshot: DiffSegment[]): DiffResult {
  const base = sortSegments(baseSnapshot);
  const current = sortSegments(currentSnapshot);
  const baseUsed = new Set<number>();
  const currentUsed = new Set<number>();
  const changes: StructuralChange[] = [];
  const oneToOneShiftAveragesMs: number[] = [];
  let unchangedCount = 0;
  let matchedCount = 0;
  let exactMatchCount = 0;

  // Reserve exact 1:1 matches before structural inference. Without this,
  // unchanged long segments that contain short overlapping interjections can
  // be misclassified as merges purely due to overlap.
  for (let baseIndex = 0; baseIndex < base.length; baseIndex += 1) {
    const baseSegment = base[baseIndex];
    const exactCurrentIndex = current.findIndex(
      (currentSegment, currentIndex) =>
        !currentUsed.has(currentIndex) && isExactSegmentMatch(baseSegment, currentSegment),
    );

    if (exactCurrentIndex === -1) {
      continue;
    }

    baseUsed.add(baseIndex);
    currentUsed.add(exactCurrentIndex);
    unchangedCount += 1;
    matchedCount += 1;
    exactMatchCount += 1;
    oneToOneShiftAveragesMs.push(0);
  }

  for (let currentIndex = 0; currentIndex < current.length; currentIndex += 1) {
    if (currentUsed.has(currentIndex)) {
      continue;
    }

    const currentSegment = current[currentIndex];
    const overlappingBaseIndexes = base
      .map((segment, index) => ({ segment, index }))
      .filter(({ segment, index }) => !baseUsed.has(index) && overlaps(segment, currentSegment))
      .map(({ index }) => index);

    if (overlappingBaseIndexes.length < 2) {
      continue;
    }

    const bases = overlappingBaseIndexes.map((index) => base[index]);
    const spansAllBases = bases.every(
      (segment) =>
        segment.startTimeInSeconds < currentSegment.endTimeInSeconds - DIFF_TOLERANCE_SECONDS &&
        segment.endTimeInSeconds > currentSegment.startTimeInSeconds + DIFF_TOLERANCE_SECONDS,
    );
    const coversMergedExtent =
      currentSegment.startTimeInSeconds <= bases[0]!.startTimeInSeconds + DIFF_TOLERANCE_SECONDS &&
      currentSegment.endTimeInSeconds >=
        bases[bases.length - 1]!.endTimeInSeconds - DIFF_TOLERANCE_SECONDS;

    if (!spansAllBases || !coversMergedExtent) {
      continue;
    }

    currentUsed.add(currentIndex);
    for (const baseIndex of overlappingBaseIndexes) {
      baseUsed.add(baseIndex);
    }

    changes.push({
      type: "merge",
      bases,
      current: currentSegment,
    });
  }

  for (let baseIndex = 0; baseIndex < base.length; baseIndex += 1) {
    const baseSegment = base[baseIndex];
    const overlappingCurrentIndexes = current
      .map((segment, index) => ({ segment, index }))
      .filter(({ segment, index }) => !currentUsed.has(index) && overlaps(baseSegment, segment))
      .map(({ index }) => index);

    if (overlappingCurrentIndexes.length < 2) {
      continue;
    }

    const parts = overlappingCurrentIndexes.map((index) => current[index]);
    const overlapCoverage = parts.reduce(
      (total, segment) => total + getOverlapDuration(baseSegment, segment),
      0,
    );
    const baseDuration = baseSegment.endTimeInSeconds - baseSegment.startTimeInSeconds;
    const sitsWithinBaseBounds = parts.every(
      (segment) =>
        segment.startTimeInSeconds < baseSegment.endTimeInSeconds - DIFF_TOLERANCE_SECONDS &&
        segment.endTimeInSeconds > baseSegment.startTimeInSeconds + DIFF_TOLERANCE_SECONDS,
    );

    if (!sitsWithinBaseBounds || overlapCoverage < baseDuration * 0.5) {
      continue;
    }

    baseUsed.add(baseIndex);
    for (const currentIndex of overlappingCurrentIndexes) {
      currentUsed.add(currentIndex);
    }

    changes.push({
      type: "split",
      base: baseSegment,
      parts,
    });
  }

  for (let baseIndex = 0; baseIndex < base.length; baseIndex += 1) {
    if (baseUsed.has(baseIndex)) {
      continue;
    }

    const baseSegment = base[baseIndex];
    const matchingCurrent = current
      .map((segment, index) => ({ segment, index }))
      .filter(({ segment, index }) => !currentUsed.has(index) && overlaps(baseSegment, segment))
      .sort((left, right) => {
        const overlapDelta =
          getOverlapDuration(baseSegment, right.segment) -
          getOverlapDuration(baseSegment, left.segment);

        if (overlapDelta !== 0) {
          return overlapDelta;
        }

        const leftDistance =
          Math.abs(left.segment.startTimeInSeconds - baseSegment.startTimeInSeconds) +
          Math.abs(left.segment.endTimeInSeconds - baseSegment.endTimeInSeconds);
        const rightDistance =
          Math.abs(right.segment.startTimeInSeconds - baseSegment.startTimeInSeconds) +
          Math.abs(right.segment.endTimeInSeconds - baseSegment.endTimeInSeconds);

        return leftDistance - rightDistance;
      })
      .at(0);

    if (!matchingCurrent) {
      continue;
    }

    baseUsed.add(baseIndex);
    currentUsed.add(matchingCurrent.index);
    matchedCount += 1;

    const shifts = [
      createShift(
        "start",
        matchingCurrent.segment.startTimeInSeconds - baseSegment.startTimeInSeconds,
      ),
      createShift(
        "end",
        matchingCurrent.segment.endTimeInSeconds - baseSegment.endTimeInSeconds,
      ),
    ].filter((shift): shift is SegmentShift => shift !== null);

    const averageShiftMs = round(
      (Math.abs(
        Math.round(
          (matchingCurrent.segment.startTimeInSeconds - baseSegment.startTimeInSeconds) * 1000,
        ),
      ) +
        Math.abs(
          Math.round(
            (matchingCurrent.segment.endTimeInSeconds - baseSegment.endTimeInSeconds) * 1000,
          ),
        )) /
        2,
      1,
    );
    oneToOneShiftAveragesMs.push(averageShiftMs);

    if (shifts.length === 0) {
      unchangedCount += 1;
      exactMatchCount += 1;
      continue;
    }

    changes.push({
      type: "timestamp-shift",
      base: baseSegment,
      current: matchingCurrent.segment,
      shifts,
    });
  }

  for (let baseIndex = 0; baseIndex < base.length; baseIndex += 1) {
    if (baseUsed.has(baseIndex)) {
      continue;
    }

    changes.push({
      type: "deleted",
      base: base[baseIndex],
    });
  }

  for (let currentIndex = 0; currentIndex < current.length; currentIndex += 1) {
    if (currentUsed.has(currentIndex)) {
      continue;
    }

    changes.push({
      type: "added",
      current: current[currentIndex],
    });
  }

  return {
    baseSegmentCount: base.length,
    currentSegmentCount: current.length,
    changes: changes.sort((left, right) => getAnchor(left) - getAnchor(right)),
    unchangedCount,
    matchedCount,
    exactMatchCount,
    oneToOneShiftAveragesMs,
  };
}

export function buildStructuralDiffPromptPacket(
  originalAnnotations: Annotation[],
  currentAnnotations: Annotation[],
): StructuralDiffPromptPacket {
  const base = normalizeSegments(originalAnnotations);
  const current = normalizeSegments(currentAnnotations);
  const diffResult = buildDiffResult(base, current);
  const segmentationChanges = diffResult.changes.filter(
    (change) => change.type !== "timestamp-shift",
  );

  const segmentationSamples = segmentationChanges
    .map((change) => {
      if (change.type === "split") {
        const referenceText = joinTexts([change.base]);
        const hypothesisText = joinTexts(change.parts);
        const wordDiff = summarizeWordDiff(referenceText, hypothesisText);
        return {
          relationship: "split",
          structuralSeverity: "high",
          referenceText: clipText(referenceText, 220),
          hypothesisText: clipText(hypothesisText, 220),
          referenceSegmentCount: 1,
          hypothesisSegmentCount: change.parts.length,
          substitutions: wordDiff.substitutions,
          insertions: wordDiff.insertions,
          deletions: wordDiff.deletions,
          changedTokens: wordDiff.changedTokens,
          referenceSegments: toMappingSegments([change.base]),
          hypothesisSegments: toMappingSegments(change.parts),
        };
      }

      if (change.type === "merge") {
        const referenceText = joinTexts(change.bases);
        const hypothesisText = joinTexts([change.current]);
        const wordDiff = summarizeWordDiff(referenceText, hypothesisText);
        return {
          relationship: "merged",
          structuralSeverity: "high",
          referenceText: clipText(referenceText, 220),
          hypothesisText: clipText(hypothesisText, 220),
          referenceSegmentCount: change.bases.length,
          hypothesisSegmentCount: 1,
          substitutions: wordDiff.substitutions,
          insertions: wordDiff.insertions,
          deletions: wordDiff.deletions,
          changedTokens: wordDiff.changedTokens,
          referenceSegments: toMappingSegments(change.bases),
          hypothesisSegments: toMappingSegments([change.current]),
        };
      }

      if (change.type === "deleted") {
        return {
          relationship: "deleted",
          structuralSeverity: "medium",
          referenceText: clipText(change.base.text, 220),
          hypothesisText: "",
          referenceSegmentCount: 1,
          hypothesisSegmentCount: 0,
          substitutions: 0,
          insertions: 0,
          deletions: tokenize(change.base.text).length,
          changedTokens: toChangedTokenSamples(change.base.text, "", 16),
          referenceSegments: toMappingSegments([change.base]),
          hypothesisSegments: [],
        };
      }

      return {
        relationship: "added",
        structuralSeverity: "medium",
        referenceText: "",
        hypothesisText: clipText(change.current.text, 220),
        referenceSegmentCount: 0,
        hypothesisSegmentCount: 1,
        substitutions: 0,
        insertions: tokenize(change.current.text).length,
        deletions: 0,
        changedTokens: toChangedTokenSamples("", change.current.text, 16),
        referenceSegments: [],
        hypothesisSegments: toMappingSegments([change.current]),
      };
    })
    .slice(0, 12);

  const timestampSamples = diffResult.changes
    .filter((change): change is Extract<StructuralChange, { type: "timestamp-shift" }> => change.type === "timestamp-shift")
    .map((change) => {
      const startShiftMs = Math.round(
        (change.current.startTimeInSeconds - change.base.startTimeInSeconds) * 1000,
      );
      const endShiftMs = Math.round(
        (change.current.endTimeInSeconds - change.base.endTimeInSeconds) * 1000,
      );
      const avgShiftMs = round((Math.abs(startShiftMs) + Math.abs(endShiftMs)) / 2, 1);
      return {
        refText: clipText(change.base.text, 220),
        hypText: clipText(change.current.text, 220),
        startShiftMs,
        endShiftMs,
        avgShiftMs,
        quality: classifyTimestampQuality(avgShiftMs),
      };
    })
    .sort((left, right) => right.avgShiftMs - left.avgShiftMs)
    .slice(0, 12);

  return {
    segmentation: {
      overview: {
        mappingCount:
          diffResult.unchangedCount +
          diffResult.changes.filter((change) => change.type === "timestamp-shift").length +
          segmentationChanges.length,
        unchangedCount: diffResult.unchangedCount,
        modifiedCount: 0,
        splitCount: segmentationChanges.filter((change) => change.type === "split").length,
        mergeCount: segmentationChanges.filter((change) => change.type === "merge").length,
        addedCount: segmentationChanges.filter((change) => change.type === "added").length,
        deletedCount: segmentationChanges.filter((change) => change.type === "deleted").length,
      },
      samples: segmentationSamples,
    },
    timestamp: {
      overview: buildTimestampOverview(diffResult),
      samples: timestampSamples,
    },
  };
}
