import { describe, expect, test } from "bun:test";
import { extractChanges } from "./change-extractor";
import { runDeterministicRules } from "./deterministic-rules";
import { computeReviewMetrics } from "./metrics";
import { buildStructuralDiffPromptPacket } from "./structural-diff";
import type { Annotation, NormalizedState } from "./types";

function annotation(
  id: string,
  startTimeInSeconds: number,
  endTimeInSeconds: number,
  content: string,
): Annotation {
  return {
    id,
    reviewActionId: "review-action",
    type: "transcription",
    content,
    processedRecordingId: "recording-1",
    startTimeInSeconds,
    endTimeInSeconds,
    metadata: null,
  };
}

function state(actionId: string, annotations: Annotation[]): NormalizedState {
  return {
    actionId,
    actionLevel: 2,
    actionDecision: "in-progress",
    annotations,
    recordings: [],
    lintErrors: [],
    capturedAt: "2026-04-08T00:00:00.000Z",
  };
}

describe("buildStructuralDiffPromptPacket", () => {
  test("reports local timestamp shifts without Babel diff input", () => {
    const packet = buildStructuralDiffPromptPacket(
      [annotation("a", 0, 1, "alpha beta")],
      [annotation("a2", 0.08, 1.12, "alpha beta")],
    );

    expect(packet.segmentation.samples).toHaveLength(0);
    expect(packet.timestamp.samples).toEqual([
      {
        refText: "alpha beta",
        hypText: "alpha beta",
        startShiftMs: 80,
        endShiftMs: 120,
        avgShiftMs: 100,
        quality: "low",
      },
    ]);
  });

  test("reports splits from local annotation timing", () => {
    const packet = buildStructuralDiffPromptPacket(
      [annotation("a", 0, 4, "one two three four")],
      [
        annotation("a1", 0, 1.95, "one two"),
        annotation("a2", 2.05, 4, "three four"),
      ],
    );

    expect(packet.segmentation.overview.splitCount).toBe(1);
    expect(packet.segmentation.samples[0]).toMatchObject({
      relationship: "split",
      structuralSeverity: "high",
      referenceSegmentCount: 1,
      hypothesisSegmentCount: 2,
    });
  });

  test("reports merge, deletion, and addition together", () => {
    const packet = buildStructuralDiffPromptPacket(
      [
        annotation("a", 0, 1, "hello"),
        annotation("b", 1.1, 2, "world"),
        annotation("c", 3, 4, "remove me"),
      ],
      [
        annotation("ab", 0, 2, "hello world"),
        annotation("d", 4.5, 5, "new segment"),
      ],
    );

    expect(packet.segmentation.overview.mergeCount).toBe(1);
    expect(packet.segmentation.overview.deletedCount).toBe(1);
    expect(packet.segmentation.overview.addedCount).toBe(1);
    expect(packet.segmentation.samples.map((sample) => sample.relationship)).toEqual([
      "merged",
      "deleted",
      "added",
    ]);
  });
});

describe("computeReviewMetrics structural diff integration", () => {
  test("feeds structural timestamp evidence into changes and deterministic rules", () => {
    const original = state("original", [annotation("a", 0, 1, "alpha beta")]);
    const current = state("current", [annotation("b", 0.08, 1.12, "alpha beta")]);

    const computed = computeReviewMetrics(original, current, "review-action");

    expect(computed.promptPacket.overview.hasStructuralDiff).toBe(true);
    expect(computed.promptPacket.structuralDiff?.timestamp.samples).toHaveLength(1);
    expect(extractChanges(computed.promptPacket).map((change) => change.type)).toContain("TIMESTAMP");
    expect(runDeterministicRules(computed.promptPacket)).toEqual([
      "timestamp_accuracy.nizkiy_precision",
      "timestamp_accuracy.nizkiy_recall",
    ]);
  });
});
