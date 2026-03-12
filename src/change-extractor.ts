import type { CategoryName, Change, ChangeType, PromptPacket } from "./types";

/**
 * Transforms a PromptPacket into a flat, numbered Change[] list.
 *
 * Each change is a discrete, human-readable line the LLM classifies
 * one-by-one. Change types determine which template catalog sections
 * are included in the scoped prompt.
 *
 * Change type → relevant categories mapping:
 *   TEXT         → Word Accuracy, Punctuation & Formatting, Tags & Emphasis
 *   TIMESTAMP    → Timestamp Accuracy
 *   SEGMENTATION → Segmentation
 *   WORD_DIFF    → Word Accuracy
 *   TAG          → Tags & Emphasis
 */

export const CHANGE_TYPE_CATEGORIES: Record<ChangeType, CategoryName[]> = {
  TEXT: ["Word Accuracy", "Punctuation & Formatting", "Tags & Emphasis"],
  TIMESTAMP: ["Timestamp Accuracy"],
  SEGMENTATION: ["Segmentation"],
  WORD_DIFF: ["Word Accuracy"],
  TAG: ["Tags & Emphasis"],
};

function escapeQuotes(text: string): string {
  return text.replace(/"/g, '\\"');
}

function formatTextChange(before: string, after: string): string {
  return `"${escapeQuotes(before)}" → "${escapeQuotes(after)}"`;
}

function extractTextChanges(packet: PromptPacket): Change[] {
  const changes: Change[] = [];
  const pairs = packet.localTextEvidence.changedPairs;

  for (const pair of pairs) {
    // Detect if this pair also involves tag changes
    const hasTagDelta = pair.beforeTagCount !== pair.afterTagCount;

    changes.push({
      index: 0, // placeholder, renumbered later
      type: "TEXT",
      categories: CHANGE_TYPE_CATEGORIES.TEXT,
      description: formatTextChange(pair.before, pair.after),
    });

    // If tag counts changed, emit a separate TAG change for the same pair
    if (hasTagDelta) {
      const direction = pair.afterTagCount > pair.beforeTagCount ? "added" : "removed";
      const delta = Math.abs(pair.afterTagCount - pair.beforeTagCount);
      changes.push({
        index: 0,
        type: "TAG",
        categories: CHANGE_TYPE_CATEGORIES.TAG,
        description: `${delta} tag(s) ${direction}: ${formatTextChange(pair.before, pair.after)}`,
      });
    }
  }

  return changes;
}

function extractTimestampChanges(packet: PromptPacket): Change[] {
  const changes: Change[] = [];
  const ts = packet.babelDiff?.timestamp;
  if (!ts) return changes;

  // Only include non-high-quality samples (the ones with actual timing issues)
  for (const sample of ts.samples) {
    if (sample.quality === "high") continue;

    const shifts: string[] = [];
    if (sample.startShiftMs !== 0) shifts.push(`start ${sample.startShiftMs > 0 ? "+" : ""}${sample.startShiftMs}ms`);
    if (sample.endShiftMs !== 0) shifts.push(`end ${sample.endShiftMs > 0 ? "+" : ""}${sample.endShiftMs}ms`);
    const shiftDesc = shifts.length > 0 ? shifts.join(", ") : `avg ${sample.avgShiftMs}ms`;

    changes.push({
      index: 0,
      type: "TIMESTAMP",
      categories: CHANGE_TYPE_CATEGORIES.TIMESTAMP,
      description: `Timing shift (${shiftDesc}) [${sample.quality}]: "${escapeQuotes(sample.refText)}"`,
    });
  }

  return changes;
}

function extractSegmentationChanges(packet: PromptPacket): Change[] {
  const changes: Change[] = [];
  const seg = packet.babelDiff?.segmentation;
  if (!seg) return changes;

  for (const sample of seg.samples) {
    // Build a concise description from the structural mapping
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

    changes.push({
      index: 0,
      type: "SEGMENTATION",
      categories: CHANGE_TYPE_CATEGORIES.SEGMENTATION,
      description: `${relationship} [${severity}] ref=${refCount}→hyp=${hypCount}${tokenSuffix}: ${refText} → ${hypText}`,
    });
  }

  return changes;
}

function extractWordDiffChanges(packet: PromptPacket): Change[] {
  const changes: Change[] = [];
  const wa = packet.babelDiff?.wordAccuracy;
  if (!wa) return changes;

  for (const sample of wa.wordDiffSamples) {
    // Summarize the token-level edits
    const edits: string[] = [];
    for (const token of sample.changedTokens) {
      if (token.status === "equal") continue;
      edits.push(`${token.status}: "${escapeQuotes(token.value)}"`);
    }

    if (edits.length === 0) continue;

    const editSummary = edits.slice(0, 6).join("; ");
    const overflow = edits.length > 6 ? ` (+${edits.length - 6} more)` : "";

    changes.push({
      index: 0,
      type: "WORD_DIFF",
      categories: CHANGE_TYPE_CATEGORIES.WORD_DIFF,
      description: `Word diff: ${editSummary}${overflow}`,
    });
  }

  return changes;
}

/**
 * Main entry point: extracts all changes from a PromptPacket and
 * returns a numbered Change[] list ready for the prompt.
 */
export function extractChanges(packet: PromptPacket): Change[] {
  const all: Change[] = [
    ...extractTextChanges(packet),
    ...extractTimestampChanges(packet),
    ...extractSegmentationChanges(packet),
    ...extractWordDiffChanges(packet),
  ];

  // Number sequentially starting from 1
  for (let i = 0; i < all.length; i++) {
    all[i].index = i + 1;
  }

  return all;
}

/**
 * Returns the set of categories that appear in the given changes.
 * Used to scope the template catalog to only relevant sections.
 */
export function getRelevantCategories(changes: Change[]): Set<CategoryName> {
  const categories = new Set<CategoryName>();
  for (const change of changes) {
    for (const cat of change.categories) {
      categories.add(cat);
    }
  }
  return categories;
}
