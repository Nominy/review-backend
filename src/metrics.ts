import type { Annotation, NormalizedState } from "./types";

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function countRegex(text: string, regex: RegExp): number {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function clipText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

function detectLanguageHint(text: string): string {
  if (!text) return "unknown";
  const cyr = (text.match(/[\u0400-\u04FF]/g) || []).length;
  const lat = (text.match(/[A-Za-z]/g) || []).length;
  if (cyr > lat * 2) return "mostly-cyrillic";
  if (lat > cyr * 2) return "mostly-latin";
  return "mixed";
}

function durationMs(annotation: Annotation): number {
  return Math.max(0, (annotation.endTimeInSeconds - annotation.startTimeInSeconds) * 1000);
}

function overlapMs(a: Annotation, b: Annotation): number {
  const start = Math.max(a.startTimeInSeconds, b.startTimeInSeconds);
  const end = Math.min(a.endTimeInSeconds, b.endTimeInSeconds);
  return Math.max(0, (end - start) * 1000);
}

function classifySeverityByRate(rate: number): "low" | "moderate" | "high" {
  if (rate >= 0.35) return "high";
  if (rate >= 0.15) return "moderate";
  return "low";
}

function absMax(values: number[]): number {
  if (!values.length) return 0;
  return Math.max(...values.map((v) => Math.abs(v)));
}

type SegmentationGraphStats = {
  addedSegments: number;
  deletedSegments: number;
  splitEvents: number;
  combineEvents: number;
  oldToNewLinksP95: number;
  newToOldLinksP95: number;
};

function computeSegmentationGraphStats(oldAnnotations: Annotation[], newAnnotations: Annotation[]): SegmentationGraphStats {
  const minOverlapForLinkMs = 120;
  const oldToNewCounts = new Map<string, number>();
  const newToOldCounts = new Map<string, number>();

  for (const oldSeg of oldAnnotations) {
    oldToNewCounts.set(oldSeg.id, 0);
  }
  for (const newSeg of newAnnotations) {
    newToOldCounts.set(newSeg.id, 0);
  }

  for (const oldSeg of oldAnnotations) {
    for (const newSeg of newAnnotations) {
      const ov = overlapMs(oldSeg, newSeg);
      if (ov < minOverlapForLinkMs) continue;
      oldToNewCounts.set(oldSeg.id, (oldToNewCounts.get(oldSeg.id) || 0) + 1);
      newToOldCounts.set(newSeg.id, (newToOldCounts.get(newSeg.id) || 0) + 1);
    }
  }

  const oldLinks = [...oldToNewCounts.values()];
  const newLinks = [...newToOldCounts.values()];

  return {
    addedSegments: newLinks.filter((n) => n === 0).length,
    deletedSegments: oldLinks.filter((n) => n === 0).length,
    splitEvents: oldLinks.filter((n) => n >= 2).length,
    combineEvents: newLinks.filter((n) => n >= 2).length,
    oldToNewLinksP95: round(percentile(oldLinks, 95), 2),
    newToOldLinksP95: round(percentile(newLinks, 95), 2)
  };
}

export function computeReviewMetrics(
  original: NormalizedState,
  current: NormalizedState,
  actionId: string
): { stats: Record<string, unknown>; featurePacket: Record<string, unknown> } {
  const oldAnnotations = Array.isArray(original.annotations) ? original.annotations : [];
  const newAnnotations = Array.isArray(current.annotations) ? current.annotations : [];

  const oldMap = new Map(oldAnnotations.map((x) => [x.id, x]));
  const newMap = new Map(newAnnotations.map((x) => [x.id, x]));
  const matchedIds = [...oldMap.keys()].filter((id) => newMap.has(id));
  const newOnly = [...newMap.keys()].filter((id) => !oldMap.has(id));
  const removed = [...oldMap.keys()].filter((id) => !newMap.has(id));

  const startShiftsAbsMs: number[] = [];
  const endShiftsAbsMs: number[] = [];
  const startShiftSignedMs: number[] = [];
  const endShiftSignedMs: number[] = [];
  const durationDeltaSignedMs: number[] = [];

  let changedSegments = 0;
  let tokenInsertions = 0;
  let tokenDeletions = 0;
  let tokenReplacements = 0;

  const evidence: Array<Record<string, unknown>> = [];
  const changedSegmentsText: Array<Record<string, unknown>> = [];

  for (const id of matchedIds) {
    const before = oldMap.get(id);
    const after = newMap.get(id);
    if (!before || !after) continue;

    const startShiftSigned = (after.startTimeInSeconds - before.startTimeInSeconds) * 1000;
    const endShiftSigned = (after.endTimeInSeconds - before.endTimeInSeconds) * 1000;
    const durDelta = durationMs(after) - durationMs(before);

    startShiftSignedMs.push(startShiftSigned);
    endShiftSignedMs.push(endShiftSigned);
    startShiftsAbsMs.push(Math.abs(startShiftSigned));
    endShiftsAbsMs.push(Math.abs(endShiftSigned));
    durationDeltaSignedMs.push(durDelta);

    const changed = before.content !== after.content;
    if (!changed) continue;

    changedSegments += 1;
    const beforeWords = countWords(before.content || "");
    const afterWords = countWords(after.content || "");
    if (afterWords > beforeWords) tokenInsertions += afterWords - beforeWords;
    if (beforeWords > afterWords) tokenDeletions += beforeWords - afterWords;
    if (beforeWords > 0 && afterWords > 0) tokenReplacements += 1;

    if (evidence.length < 6) {
      evidence.push({
        category_hint: "Word Accuracy",
        annotationId: id,
        time_after: [round(after.startTimeInSeconds, 3), round(after.endTimeInSeconds, 3)],
        before: clipText(before.content || "", 280),
        after: clipText(after.content || "", 280)
      });
    }

    if (changedSegmentsText.length < 10) {
      changedSegmentsText.push({
        annotationId: id,
        time_after: [round(after.startTimeInSeconds, 3), round(after.endTimeInSeconds, 3)],
        before: clipText(before.content || "", 380),
        after: clipText(after.content || "", 380)
      });
    }
  }

  const oldText = oldAnnotations.map((x) => x.content || "").join(" ");
  const newText = newAnnotations.map((x) => x.content || "").join(" ");
  const oldWordCount = countWords(oldText);
  const newWordCount = countWords(newText);

  const newSegmentsText = newOnly
    .slice(0, 8)
    .map((id) => newMap.get(id))
    .filter(Boolean)
    .map((seg) => ({
      annotationId: seg!.id,
      time_after: [round(seg!.startTimeInSeconds, 3), round(seg!.endTimeInSeconds, 3)],
      text: clipText(seg!.content || "", 360)
    }));

  const removedSegmentsText = removed
    .slice(0, 8)
    .map((id) => oldMap.get(id))
    .filter(Boolean)
    .map((seg) => ({
      annotationId: seg!.id,
      time_before: [round(seg!.startTimeInSeconds, 3), round(seg!.endTimeInSeconds, 3)],
      text: clipText(seg!.content || "", 360)
    }));

  const lintAfter = Array.isArray(current.lintErrors) ? current.lintErrors : [];
  const lintSamples = lintAfter.slice(0, 8).map((lint) => {
    const seg = newMap.get(lint.annotationId);
    return {
      annotationId: lint.annotationId || "",
      reason: lint.reason || "",
      severity: lint.severity || "",
      text: clipText(seg ? seg.content || "" : "", 320),
      time_after: seg ? [round(seg.startTimeInSeconds, 3), round(seg.endTimeInSeconds, 3)] : null
    };
  });

  const punctuationSegments = newAnnotations
    .filter((seg) => /[.,!?;:]/.test(seg.content || ""))
    .slice(0, 8)
    .map((seg) => ({
      annotationId: seg.id,
      text: clipText(seg.content || "", 260),
      punctuation_count: countRegex(seg.content || "", /[.,!?;:]/g),
      time_after: [round(seg.startTimeInSeconds, 3), round(seg.endTimeInSeconds, 3)]
    }));

  const tagSegments = newAnnotations
    .filter((seg) => /\[[^\]]+\]|\{[^}]+\}|<[^>]+>|\*\*[^*]+\*\*/.test(seg.content || ""))
    .slice(0, 8)
    .map((seg) => ({
      annotationId: seg.id,
      text: clipText(seg.content || "", 300),
      time_after: [round(seg.startTimeInSeconds, 3), round(seg.endTimeInSeconds, 3)]
    }));

  const oldDur = oldAnnotations.map(durationMs);
  const newDur = newAnnotations.map(durationMs);
  const segmentationGraph = computeSegmentationGraphStats(oldAnnotations, newAnnotations);

  const severeGrowthThresholdMs = 500;
  const severeShrinkThresholdMs = -500;
  const mildDurationDeltaThresholdMs = 120;

  const grewCount = durationDeltaSignedMs.filter((x) => x >= mildDurationDeltaThresholdMs).length;
  const shrankCount = durationDeltaSignedMs.filter((x) => x <= -mildDurationDeltaThresholdMs).length;
  const severeGrewCount = durationDeltaSignedMs.filter((x) => x >= severeGrowthThresholdMs).length;
  const severeShrankCount = durationDeltaSignedMs.filter((x) => x <= severeShrinkThresholdMs).length;

  const matchedCount = matchedIds.length;
  const grewRate = matchedCount ? grewCount / matchedCount : 0;
  const shrankRate = matchedCount ? shrankCount / matchedCount : 0;
  const severeGrewRate = matchedCount ? severeGrewCount / matchedCount : 0;
  const severeShrankRate = matchedCount ? severeShrankCount / matchedCount : 0;

  const timestampPrimaryPattern =
    severeShrankRate > severeGrewRate
      ? "speech_cut_risk"
      : severeGrewRate > severeShrankRate
        ? "silence_included_risk"
        : shrankRate > grewRate
          ? "speech_cut_risk_mild"
          : grewRate > shrankRate
            ? "silence_included_risk_mild"
            : "balanced_or_minor";

  const wordChangeMagnitude = tokenInsertions + tokenDeletions + tokenReplacements;
  const wordChangeRate = matchedCount ? wordChangeMagnitude / Math.max(1, matchedCount) : 0;

  const punctuationBefore = countRegex(oldText, /[.,!?;:]/g);
  const punctuationAfter = countRegex(newText, /[.,!?;:]/g);

  const punctuationSpacingBefore = {
    spaces_before_comma: countRegex(oldText, /\s+,/g),
    spaces_before_dot: countRegex(oldText, /\s+\./g),
    spaces_before_colon: countRegex(oldText, /\s+:/g),
    spaces_before_semicolon: countRegex(oldText, /\s+;/g),
    no_space_after_punct: countRegex(oldText, /[.,!?;:][^\s\d\]\)}>"']/g)
  };

  const punctuationSpacingAfter = {
    spaces_before_comma: countRegex(newText, /\s+,/g),
    spaces_before_dot: countRegex(newText, /\s+\./g),
    spaces_before_colon: countRegex(newText, /\s+:/g),
    spaces_before_semicolon: countRegex(newText, /\s+;/g),
    no_space_after_punct: countRegex(newText, /[.,!?;:][^\s\d\]\)}>"']/g)
  };

  const squareBefore = countRegex(oldText, /\[[^\]]+\]/g);
  const squareAfter = countRegex(newText, /\[[^\]]+\]/g);
  const curlyBefore = countRegex(oldText, /\{[^}]+\}/g);
  const curlyAfter = countRegex(newText, /\{[^}]+\}/g);
  const angleBefore = countRegex(oldText, /<[^>]+>/g);
  const angleAfter = countRegex(newText, /<[^>]+>/g);
  const emphasisBefore = countRegex(oldText, /\*\*[^*]+\*\*/g);
  const emphasisAfter = countRegex(newText, /\*\*[^*]+\*\*/g);
  const breathingTagBefore = countRegex(oldText, /\[(?:дыхание|вдох|выдох|вздох|резкий-вздох)\]/gi);
  const breathingTagAfter = countRegex(newText, /\[(?:дыхание|вдох|выдох|вздох|резкий-вздох)\]/gi);

  const segmentationDelta = newAnnotations.length - oldAnnotations.length;
  const segmentationDirection =
    segmentationDelta > 0 ? "more_segments_after_l2" : segmentationDelta < 0 ? "fewer_segments_after_l2" : "same_count";

  const segmentationDominantPattern = (() => {
    const events = [
      { key: "added", value: segmentationGraph.addedSegments },
      { key: "deleted", value: segmentationGraph.deletedSegments },
      { key: "split", value: segmentationGraph.splitEvents },
      { key: "combined", value: segmentationGraph.combineEvents }
    ].sort((a, b) => b.value - a.value);
    if (!events[0] || events[0].value === 0) return "minor_or_none";
    return events[0].key;
  })();

  const featurePacket = {
    session: { actionId },
    deltas: {
      segment_count_delta: segmentationDelta,
      changed_segment_ratio: matchedCount ? round(changedSegments / matchedCount, 4) : 0,
      new_segments: newOnly.length,
      removed_segments: removed.length,
      avg_segment_duration_delta_ms: round(average(newDur) - average(oldDur), 2),
      timestamp_shift_start_ms: {
        mean: round(average(startShiftsAbsMs), 2),
        p95: round(percentile(startShiftsAbsMs, 95), 2),
        max: round(Math.max(0, ...startShiftsAbsMs), 2),
        signed_mean: round(average(startShiftSignedMs), 2)
      },
      timestamp_shift_end_ms: {
        mean: round(average(endShiftsAbsMs), 2),
        p95: round(percentile(endShiftsAbsMs, 95), 2),
        max: round(Math.max(0, ...endShiftsAbsMs), 2),
        signed_mean: round(average(endShiftSignedMs), 2)
      },
      token_insertions: tokenInsertions,
      token_deletions: tokenDeletions,
      token_replacements: tokenReplacements,
      punctuation_delta: {
        before: punctuationBefore,
        after: punctuationAfter
      },
      punctuation_spacing_delta: {
        before: punctuationSpacingBefore,
        after: punctuationSpacingAfter
      },
      tag_delta: {
        square_before: squareBefore,
        square_after: squareAfter,
        curly_before: curlyBefore,
        curly_after: curlyAfter,
        angle_before: angleBefore,
        angle_after: angleAfter,
        emphasis_before: emphasisBefore,
        emphasis_after: emphasisAfter,
        breathing_before: breathingTagBefore,
        breathing_after: breathingTagAfter
      }
    },
    diagnostics: {
      word_accuracy: {
        changed_segments: changedSegments,
        matched_segments: matchedCount,
        word_change_magnitude: wordChangeMagnitude,
        word_change_rate_per_segment: round(wordChangeRate, 3),
        severity: classifySeverityByRate(matchedCount ? changedSegments / Math.max(1, matchedCount) : 0)
      },
      timestamp_behavior: {
        grew_count: grewCount,
        shrank_count: shrankCount,
        severe_grew_count: severeGrewCount,
        severe_shrank_count: severeShrankCount,
        grew_rate: round(grewRate, 3),
        shrank_rate: round(shrankRate, 3),
        severe_grew_rate: round(severeGrewRate, 3),
        severe_shrank_rate: round(severeShrankRate, 3),
        mean_duration_delta_ms: round(average(durationDeltaSignedMs), 2),
        median_duration_delta_ms: round(percentile(durationDeltaSignedMs, 50), 2),
        p95_abs_duration_delta_ms: round(percentile(durationDeltaSignedMs.map((x) => Math.abs(x)), 95), 2),
        max_abs_duration_delta_ms: round(absMax(durationDeltaSignedMs), 2),
        primary_pattern: timestampPrimaryPattern,
        advice_hint:
          timestampPrimaryPattern === "silence_included_risk" || timestampPrimaryPattern === "silence_included_risk_mild"
            ? "focus_trim_silence"
            : timestampPrimaryPattern === "speech_cut_risk" || timestampPrimaryPattern === "speech_cut_risk_mild"
              ? "focus_do_not_cut_speech"
              : "focus_minor_tweaks_only"
      },
      punctuation_formatting: {
        punctuation_before: punctuationBefore,
        punctuation_after: punctuationAfter,
        punctuation_spacing_issue_before:
          punctuationSpacingBefore.spaces_before_comma +
          punctuationSpacingBefore.spaces_before_dot +
          punctuationSpacingBefore.spaces_before_colon +
          punctuationSpacingBefore.spaces_before_semicolon +
          punctuationSpacingBefore.no_space_after_punct,
        punctuation_spacing_issue_after:
          punctuationSpacingAfter.spaces_before_comma +
          punctuationSpacingAfter.spaces_before_dot +
          punctuationSpacingAfter.spaces_before_colon +
          punctuationSpacingAfter.spaces_before_semicolon +
          punctuationSpacingAfter.no_space_after_punct
      },
      tags_and_emphasis: {
        square_delta: squareAfter - squareBefore,
        curly_delta: curlyAfter - curlyBefore,
        angle_delta: angleAfter - angleBefore,
        emphasis_delta: emphasisAfter - emphasisBefore,
        breathing_delta: breathingTagAfter - breathingTagBefore
      },
      segmentation: {
        segment_count_before: oldAnnotations.length,
        segment_count_after: newAnnotations.length,
        segment_count_delta: segmentationDelta,
        segment_count_direction: segmentationDirection,
        added_segments: segmentationGraph.addedSegments,
        deleted_segments: segmentationGraph.deletedSegments,
        split_events: segmentationGraph.splitEvents,
        combine_events: segmentationGraph.combineEvents,
        dominant_pattern: segmentationDominantPattern,
        old_to_new_links_p95: segmentationGraph.oldToNewLinksP95,
        new_to_old_links_p95: segmentationGraph.newToOldLinksP95
      },
      reviewer_playbook_hints: {
        timestamp_tooling:
          severeGrewCount + severeShrankCount >= 2
            ? [
                "recommend_max_zoom",
                "recommend_hotkeys_q_w_e_r_segment_click",
                "recommend_playback_0_75_for_hard_segments"
              ]
            : ["recommend_playback_0_75_for_hard_segments"],
        segmentation_rule_hint: "split_only_when_pause_at_least_1s_do_not_cut_speech_to_force_split",
        breathing_rule_hint: "avoid_tagging_natural_breathing_only_semantic_breaths"
      }
    },
    lint: {
      errors_before: Array.isArray(original.lintErrors) ? original.lintErrors.length : 0,
      errors_after: Array.isArray(current.lintErrors) ? current.lintErrors.length : 0
    },
    text_evidence: {
      language_hint: detectLanguageHint(newText),
      transcript_before_excerpt: clipText(oldText, 1600),
      transcript_after_excerpt: clipText(newText, 1600),
      changed_segments: changedSegmentsText,
      new_segments: newSegmentsText,
      removed_segments: removedSegmentsText,
      lint_samples: lintSamples,
      punctuation_samples: punctuationSegments,
      tag_samples: tagSegments
    },
    evidence
  };

  const stats = {
    original: {
      annotations: oldAnnotations.length,
      words: oldWordCount,
      lintErrors: featurePacket.lint.errors_before
    },
    current: {
      annotations: newAnnotations.length,
      words: newWordCount,
      lintErrors: featurePacket.lint.errors_after
    },
    changes: {
      matched: matchedCount,
      changedSegments,
      newSegments: newOnly.length,
      removedSegments: removed.length,
      startShiftMeanMs: featurePacket.deltas.timestamp_shift_start_ms.mean,
      endShiftMeanMs: featurePacket.deltas.timestamp_shift_end_ms.mean,
      timestampPrimaryPattern,
      segmentationDominantPattern
    }
  };

  return { stats, featurePacket };
}
