import type { BabelDiffPayload, PromptPacket } from "./types";

type BabelDiffPromptPacket = NonNullable<PromptPacket["babelDiff"]>;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toNumberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clipText(text: string, maxLen: number): string {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= maxLen) {
    return value;
  }
  return `${value.slice(0, maxLen)}...`;
}

function getFirstDiffJson(payload: unknown): Record<string, unknown> | null {
  if (!Array.isArray(payload)) {
    return null;
  }
  const first = payload[0];
  if (
    first &&
    typeof first === "object" &&
    "result" in first &&
    isObject(first.result) &&
    "data" in first.result &&
    isObject(first.result.data) &&
    "json" in first.result.data &&
    isObject(first.result.data.json)
  ) {
    return first.result.data.json;
  }
  return null;
}

function toChangedTokenSamples(wordDiffs: unknown, maxItems: number): Array<{ value: string; status: string }> {
  if (!Array.isArray(wordDiffs)) {
    return [];
  }
  const samples: Array<{ value: string; status: string }> = [];
  for (const item of wordDiffs) {
    if (!isObject(item)) continue;
    const status = toStringValue(item.status);
    const value = clipText(toStringValue(item.value), 80);
    if (!status || !value || status === "unchanged") continue;
    samples.push({ value, status });
    if (samples.length >= maxItems) {
      break;
    }
  }
  return samples;
}

export function buildBabelDiffPromptPacket(
  input: BabelDiffPayload | null | undefined
): BabelDiffPromptPacket | undefined {
  if (!input || !isObject(input)) {
    return undefined;
  }

  const diffJson = getFirstDiffJson(input.diffPayload);
  if (!diffJson) {
    return undefined;
  }

  const segmentMappings = Array.isArray(diffJson.segmentMappings) ? diffJson.segmentMappings : [];
  const timestampMetrics = isObject(diffJson.timestampMetrics) ? diffJson.timestampMetrics : {};
  const timeline = isObject(timestampMetrics.timeline) ? timestampMetrics.timeline : {};
  const segments = isObject(timestampMetrics.segments) ? timestampMetrics.segments : {};
  const speakerDiffs = Array.isArray(diffJson.speakerDiffs) ? diffJson.speakerDiffs : [];

  let unchangedCount = 0;
  let modifiedCount = 0;
  let splitCount = 0;
  let mergeCount = 0;
  let addedCount = 0;
  let deletedCount = 0;

  const segmentationSamples: BabelDiffPromptPacket["segmentation"]["samples"] = [];
  for (const item of segmentMappings) {
    if (!isObject(item)) {
      continue;
    }
    const relationship = toStringValue(item.relationship);
    if (relationship === "unchanged") unchangedCount += 1;
    else if (relationship === "modified") modifiedCount += 1;
    else if (relationship === "split") splitCount += 1;
    else if (relationship === "merge") mergeCount += 1;
    else if (relationship === "added") addedCount += 1;
    else if (relationship === "deleted") deletedCount += 1;

    if (segmentationSamples.length >= 12 || !relationship || relationship === "unchanged") {
      continue;
    }

    const segmentsA = Array.isArray(item.segmentsA) ? item.segmentsA : [];
    const segmentsB = Array.isArray(item.segmentsB) ? item.segmentsB : [];
    segmentationSamples.push({
      relationship,
      referenceText: clipText(toStringValue(item.referenceText), 220),
      hypothesisText: clipText(toStringValue(item.hypothesisText), 220),
      referenceSegmentCount: segmentsA.length,
      hypothesisSegmentCount: segmentsB.length,
      substitutions: Number(item.substitutions) || 0,
      insertions: Number(item.insertions) || 0,
      deletions: Number(item.deletions) || 0
    });
  }

  const detailRows = Array.isArray(segments.details) ? segments.details : [];
  const timingSamples = detailRows
    .filter((item) => isObject(item))
    .map((item) => ({
      refText: clipText(toStringValue(item.refText), 220),
      startShiftMs: Number(item.startShiftMs) || 0,
      endShiftMs: Number(item.endShiftMs) || 0,
      avgShiftMs: Number(item.avgShiftMs) || 0,
      quality: toStringValue(item.quality) || "unknown"
    }))
    .sort((left, right) => Math.abs(right.avgShiftMs) - Math.abs(left.avgShiftMs))
    .slice(0, 12);

  const speakerBreakdown = speakerDiffs
    .filter((item) => isObject(item))
    .map((item) => ({
      processedRecordingId: toStringValue(item.processedRecordingId),
      wordErrorRate: toNumberOrNull(item.wordErrorRate),
      totalReferenceWords: toNumberOrNull(item.totalReferenceWords),
      totalHypothesisWords: toNumberOrNull(item.totalHypothesisWords),
      insertions: toNumberOrNull(item.insertions),
      deletions: toNumberOrNull(item.deletions),
      substitutions: toNumberOrNull(item.substitutions)
    }))
    .sort((left, right) => (right.wordErrorRate || 0) - (left.wordErrorRate || 0))
    .slice(0, 6);

  const wordDiffSamples = speakerDiffs
    .filter((item) => isObject(item))
    .map((item) => ({
      processedRecordingId: toStringValue(item.processedRecordingId),
      referenceText: clipText(toStringValue(item.combinedReferenceText), 220),
      hypothesisText: clipText(toStringValue(item.combinedHypothesisText), 220),
      changedTokens: toChangedTokenSamples(item.wordDiffs, 10)
    }))
    .filter((item) => item.changedTokens.length > 0)
    .slice(0, 6);

  return {
    referenceReviewActionId:
      toStringValue(diffJson.referenceReviewActionId) ||
      toStringValue(input.referenceReviewActionId),
    currentReviewActionId:
      toStringValue(diffJson.currentReviewActionId) ||
      toStringValue(input.currentReviewActionId),
    segmentation: {
      overview: {
        mappingCount: segmentMappings.length,
        unchangedCount,
        modifiedCount,
        splitCount,
        mergeCount,
        addedCount,
        deletedCount
      },
      samples: segmentationSamples
    },
    timestamp: {
      overview: {
        precision: toNumberOrNull(timeline.precision),
        recall: toNumberOrNull(timeline.recall),
        f1: toNumberOrNull(timeline.f1),
        totalSegments: toNumberOrNull(segments.totalSegments),
        matchedSegments: toNumberOrNull(segments.matchedSegments),
        unmatchedSegments: toNumberOrNull(segments.unmatchedSegments),
        avgShiftMs: toNumberOrNull(segments.avgShiftMs),
        within50ms: toNumberOrNull(segments.within50ms),
        within100ms: toNumberOrNull(segments.within100ms),
        within200ms: toNumberOrNull(segments.within200ms)
      },
      samples: timingSamples
    },
    wordAccuracy: {
      overview: {
        overallWordErrorRate: toNumberOrNull(diffJson.overallWordErrorRate),
        totalReferenceWords: toNumberOrNull(diffJson.totalReferenceWords),
        totalHypothesisWords: toNumberOrNull(diffJson.totalHypothesisWords),
        totalInsertions: toNumberOrNull(diffJson.totalInsertions),
        totalDeletions: toNumberOrNull(diffJson.totalDeletions),
        totalSubstitutions: toNumberOrNull(diffJson.totalSubstitutions)
      },
      speakerBreakdown,
      wordDiffSamples
    }
  };
}
