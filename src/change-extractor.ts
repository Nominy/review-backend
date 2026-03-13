import type { CategoryName, Change, ChangeType, PromptPacket } from "./types";

/**
 * Transforms a PromptPacket into a flat, numbered Change[] list.
 *
 * Each change is a discrete, human-readable line the LLM classifies
 * one-by-one. Change types determine which template catalog sections
 * are included in the scoped prompt.
 *
 * Change type -> relevant categories mapping:
 *   TEXT         -> Word Accuracy, Punctuation & Formatting, Tags & Emphasis
 *   TIMESTAMP    -> Timestamp Accuracy
 *   SEGMENTATION -> Segmentation
 *   WORD_DIFF    -> Word Accuracy
 *   TAG          -> Tags & Emphasis
 */

export const CHANGE_TYPE_CATEGORIES: Record<ChangeType, CategoryName[]> = {
  TEXT: ["Word Accuracy", "Punctuation & Formatting", "Tags & Emphasis"],
  TIMESTAMP: ["Timestamp Accuracy"],
  SEGMENTATION: ["Segmentation"],
  WORD_DIFF: ["Word Accuracy"],
  TAG: ["Tags & Emphasis"]
};

function escapeQuotes(text: string): string {
  return text.replace(/"/g, '\\"');
}

function normalizeInlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function trimEvidenceText(text: string): string | undefined {
  const normalized = text.trim();
  return normalized ? normalized : undefined;
}

function formatTextChange(before: string, after: string, inlineDiff?: string): string {
  // Prefer focused inline diff when available
  if (inlineDiff) {
    return inlineDiff;
  }
  return `"${escapeQuotes(before)}" -> "${escapeQuotes(after)}"`;
}

function summarizeTextPair(before: string, after: string): string {
  const beforeNormalized = normalizeInlineText(before);
  const afterNormalized = normalizeInlineText(after);

  if (!beforeNormalized && afterNormalized) {
    return `Text added: ${afterNormalized}`;
  }
  if (beforeNormalized && !afterNormalized) {
    return `Text removed: ${beforeNormalized}`;
  }
  if (!beforeNormalized && !afterNormalized) {
    return "Text changed";
  }
  if (beforeNormalized === afterNormalized) {
    return `Formatting changed: ${afterNormalized}`;
  }
  return `Text updated: ${afterNormalized}`;
}

function summarizeTagDelta(beforeCount: number, afterCount: number): string {
  const delta = Math.abs(afterCount - beforeCount);
  const label = delta === 1 ? "tag" : "tags";
  const direction = afterCount > beforeCount ? "added" : "removed";
  return `${delta} ${label} ${direction}`;
}

function summarizeTimestampShift(sample: {
  startShiftMs: number;
  endShiftMs: number;
  avgShiftMs: number;
  quality: string;
}): string {
  const shifts: string[] = [];
  if (sample.startShiftMs !== 0) {
    shifts.push(`start ${sample.startShiftMs > 0 ? "+" : ""}${sample.startShiftMs}ms`);
  }
  if (sample.endShiftMs !== 0) {
    shifts.push(`end ${sample.endShiftMs > 0 ? "+" : ""}${sample.endShiftMs}ms`);
  }
  const shiftSummary = shifts.length > 0 ? shifts.join(", ") : `avg ${sample.avgShiftMs}ms`;
  return `Timing shift (${shiftSummary}, ${sample.quality} confidence)`;
}

function summarizeSegmentationChange(sample: {
  relationship: string;
  structuralSeverity: string;
  referenceSegmentCount: number;
  hypothesisSegmentCount: number;
}): string {
  return `${sample.relationship} (${sample.referenceSegmentCount} ref, ${sample.hypothesisSegmentCount} hyp, ${sample.structuralSeverity})`;
}

function summarizeWordDiff(changedTokens: Array<{ value: string; status: string }>): string {
  const edits = changedTokens.filter((token) => token.status !== "equal");
  if (!edits.length) {
    return "Word difference detected";
  }

  const uniqueStatuses = [...new Set(edits.map((token) => token.status))].join(", ");
  return `Word difference detected (${edits.length} edit${edits.length === 1 ? "" : "s"}: ${uniqueStatuses})`;
}

function extractTextChanges(packet: PromptPacket): Change[] {
  const changes: Change[] = [];
  const pairs = packet.localTextEvidence.changedPairs;

  for (const pair of pairs) {
    const hasTagDelta = pair.beforeTagCount !== pair.afterTagCount;
    const description = formatTextChange(pair.before, pair.after, pair.inlineDiff);

    changes.push({
      index: 0,
      type: "TEXT",
      categories: CHANGE_TYPE_CATEGORIES.TEXT,
      summary: summarizeTextPair(pair.before, pair.after),
      evidence: description,
      description
    });

    if (hasTagDelta) {
      const tagDesc = `${summarizeTagDelta(pair.beforeTagCount, pair.afterTagCount)}: ${description}`;
      changes.push({
        index: 0,
        type: "TAG",
        categories: CHANGE_TYPE_CATEGORIES.TAG,
        summary: summarizeTagDelta(pair.beforeTagCount, pair.afterTagCount),
        evidence: tagDesc,
        description: tagDesc
      });
    }
  }

  return changes;
}

function extractTimestampChanges(packet: PromptPacket): Change[] {
  const changes: Change[] = [];
  const ts = packet.babelDiff?.timestamp;
  if (!ts) return changes;

  for (const sample of ts.samples) {
    if (sample.quality === "high") continue;

    const shifts: string[] = [];
    if (sample.startShiftMs !== 0) shifts.push(`start ${sample.startShiftMs > 0 ? "+" : ""}${sample.startShiftMs}ms`);
    if (sample.endShiftMs !== 0) shifts.push(`end ${sample.endShiftMs > 0 ? "+" : ""}${sample.endShiftMs}ms`);
    const shiftDesc = shifts.length > 0 ? shifts.join(", ") : `avg ${sample.avgShiftMs}ms`;
    const desc = `Timing shift (${shiftDesc}) [${sample.quality}]: "${escapeQuotes(sample.refText)}"`;

    changes.push({
      index: 0,
      type: "TIMESTAMP",
      categories: CHANGE_TYPE_CATEGORIES.TIMESTAMP,
      summary: summarizeTimestampShift(sample),
      evidence: desc,
      description: desc
    });
  }

  return changes;
}

function extractSegmentationChanges(packet: PromptPacket): Change[] {
  const changes: Change[] = [];
  const seg = packet.babelDiff?.segmentation;
  if (!seg) return changes;

  for (const sample of seg.samples) {
    const refCount = sample.referenceSegmentCount;
    const hypCount = sample.hypothesisSegmentCount;
    const relationship = sample.relationship;
    const severity = sample.structuralSeverity;

    const refText = sample.referenceText
      ? `"${escapeQuotes(sample.referenceText)}"`
      : "(empty)";
    const hypText = sample.hypothesisText
      ? `"${escapeQuotes(sample.hypothesisText)}"`
      : "(empty)";

    const tokenChanges: string[] = [];
    if (sample.substitutions > 0) tokenChanges.push(`${sample.substitutions} sub`);
    if (sample.insertions > 0) tokenChanges.push(`${sample.insertions} ins`);
    if (sample.deletions > 0) tokenChanges.push(`${sample.deletions} del`);
    const tokenSuffix = tokenChanges.length > 0 ? ` (${tokenChanges.join(", ")})` : "";
    const desc = `${relationship} [${severity}] ref=${refCount}->hyp=${hypCount}${tokenSuffix}: ${refText} -> ${hypText}`;

    changes.push({
      index: 0,
      type: "SEGMENTATION",
      categories: CHANGE_TYPE_CATEGORIES.SEGMENTATION,
      summary: summarizeSegmentationChange(sample),
      evidence: desc,
      description: desc
    });
  }

  return changes;
}

function extractWordDiffChanges(packet: PromptPacket): Change[] {
  const changes: Change[] = [];
  const wa = packet.babelDiff?.wordAccuracy;
  if (!wa) return changes;

  for (const sample of wa.wordDiffSamples) {
    const edits: string[] = [];
    for (const token of sample.changedTokens) {
      if (token.status === "equal") continue;
      edits.push(`${token.status}: "${escapeQuotes(token.value)}"`);
    }

    if (edits.length === 0) continue;

    const editSummary = edits.slice(0, 6).join("; ");
    const overflow = edits.length > 6 ? ` (+${edits.length - 6} more)` : "";
    const desc = `Word diff: ${editSummary}${overflow}`;

    changes.push({
      index: 0,
      type: "WORD_DIFF",
      categories: CHANGE_TYPE_CATEGORIES.WORD_DIFF,
      summary: summarizeWordDiff(sample.changedTokens),
      evidence: desc,
      description: desc
    });
  }

  return changes;
}

export function extractChanges(packet: PromptPacket): Change[] {
  const all: Change[] = [
    ...extractTextChanges(packet),
    ...extractTimestampChanges(packet),
    ...extractSegmentationChanges(packet),
    ...extractWordDiffChanges(packet)
  ];

  for (let i = 0; i < all.length; i++) {
    all[i].index = i + 1;
  }

  return all;
}

export function getRelevantCategories(changes: Change[]): Set<CategoryName> {
  const categories = new Set<CategoryName>();
  for (const change of changes) {
    for (const cat of change.categories) {
      categories.add(cat);
    }
  }
  return categories;
}
