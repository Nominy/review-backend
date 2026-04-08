import type { CategoryName, Change, ChangeType, PromptPacket } from "./types";

/**
 * Transforms a PromptPacket into a flat, numbered Change[] list.
 *
 * Each change is a discrete, human-readable line the LLM classifies
 * one-by-one. Change types determine which template catalog sections
 * are included in the scoped prompt.
 *
 * Change type -> relevant categories mapping:
 *   TEXT CHANGE     -> Word Accuracy, Punctuation & Formatting, Tags & Emphasis
 *   TIMESTAMP SHIFT -> Timestamp Accuracy
 *   SEG *           -> Segmentation
 */

export const CHANGE_TYPE_CATEGORIES: Record<ChangeType, CategoryName[]> = {
  "TEXT CHANGE": ["Word Accuracy", "Punctuation & Formatting", "Tags & Emphasis"],
  "TIMESTAMP SHIFT": ["Timestamp Accuracy"],
  "SEG ADDED": ["Segmentation"],
  "SEG DELETED": ["Segmentation"],
  "SEG SPLIT": ["Segmentation"],
  "SEG MERGED": ["Segmentation"]
};

function escapeQuotes(text: string): string {
  return text.replace(/"/g, '\\"');
}

function normalizeInlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatTextChange(before: string, after: string): string {
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

function summarizeTimestampShift(sample: {
  startShiftMs: number;
  endShiftMs: number;
  avgShiftMs: number;
  quality: string;
}): string {
  const shifts: string[] = [];
  if (sample.startShiftMs !== 0) {
    shifts.push(formatTimestampEdgeShift("start", sample.startShiftMs));
  }
  if (sample.endShiftMs !== 0) {
    shifts.push(formatTimestampEdgeShift("end", sample.endShiftMs));
  }
  const shiftSummary = shifts.length > 0 ? shifts.join(", ") : `avg ${sample.avgShiftMs}ms`;
  return `Timing shift (${shiftSummary}, ${sample.quality} confidence)`;
}

function toSegmentationChangeType(relationship: string): ChangeType {
  if (relationship === "added") return "SEG ADDED";
  if (relationship === "deleted") return "SEG DELETED";
  if (relationship === "split") return "SEG SPLIT";
  return "SEG MERGED";
}

function summarizeSegmentationChange(sample: {
  relationship: string;
  structuralSeverity: string;
  referenceSegmentCount: number;
  hypothesisSegmentCount: number;
}): string {
  return `${toSegmentationChangeType(sample.relationship)} (${sample.referenceSegmentCount} ref, ${sample.hypothesisSegmentCount} hyp, ${sample.structuralSeverity})`;
}

function getTimestampShiftDirection(
  edge: "start" | "end",
  deltaMs: number,
): "inward" | "outward" {
  if (edge === "start") {
    return deltaMs > 0 ? "inward" : "outward";
  }
  return deltaMs < 0 ? "inward" : "outward";
}

function getTimestampShiftMeaning(direction: "inward" | "outward"): string {
  return direction === "inward" ? "likely removed silence" : "likely restored cut speech";
}

function formatTimestampEdgeShift(edge: "start" | "end", deltaMs: number): string {
  const direction = getTimestampShiftDirection(edge, deltaMs);
  return `${edge} ${direction} (${deltaMs > 0 ? "+" : ""}${deltaMs}ms, ${getTimestampShiftMeaning(direction)})`;
}

function extractTextChanges(packet: PromptPacket): Change[] {
  const changes: Change[] = [];
  const pairs = packet.localTextEvidence.changedPairs;

  for (const pair of pairs) {
    const description = formatTextChange(pair.before, pair.after);

    changes.push({
      index: 0,
      type: "TEXT CHANGE",
      categories: CHANGE_TYPE_CATEGORIES["TEXT CHANGE"],
      summary: summarizeTextPair(pair.before, pair.after),
      evidence: description,
      evidenceDetail: {
        kind: "text-diff",
        before: pair.before,
        after: pair.after,
        ...(pair.inlineDiff ? { inlineDiff: pair.inlineDiff } : {})
      },
      description
    });
  }

  return changes;
}

function extractTimestampChanges(packet: PromptPacket): Change[] {
  const changes: Change[] = [];
  const ts = packet.structuralDiff?.timestamp;
  if (!ts) return changes;

  for (const sample of ts.samples) {
    if (sample.quality === "high") continue;

    const shifts: string[] = [];
    if (sample.startShiftMs !== 0) shifts.push(formatTimestampEdgeShift("start", sample.startShiftMs));
    if (sample.endShiftMs !== 0) shifts.push(formatTimestampEdgeShift("end", sample.endShiftMs));
    const shiftDesc = shifts.length > 0 ? shifts.join(", ") : `avg ${sample.avgShiftMs}ms`;
    const desc = `Timing shift (${shiftDesc}) [${sample.quality}]: "${escapeQuotes(sample.refText)}"`;

    changes.push({
      index: 0,
      type: "TIMESTAMP SHIFT",
      categories: CHANGE_TYPE_CATEGORIES["TIMESTAMP SHIFT"],
      summary: summarizeTimestampShift(sample),
      evidence: desc,
      evidenceDetail: {
        kind: "raw",
        text: desc
      },
      description: desc
    });
  }

  return changes;
}

function extractSegmentationChanges(packet: PromptPacket): Change[] {
  const changes: Change[] = [];
  const seg = packet.structuralDiff?.segmentation;
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
    const type = toSegmentationChangeType(relationship);
    const desc = `${type} [${severity}] ref=${refCount}->hyp=${hypCount}${tokenSuffix}: ${refText} -> ${hypText}`;

    changes.push({
      index: 0,
      type,
      categories: CHANGE_TYPE_CATEGORIES[type],
      summary: summarizeSegmentationChange(sample),
      evidence: desc,
      evidenceDetail: {
        kind: "text-diff",
        before: sample.referenceText,
        after: sample.hypothesisText
      },
      description: desc
    });
  }

  return changes;
}

export function extractChanges(packet: PromptPacket): Change[] {
  const all: Change[] = [
    ...extractTextChanges(packet),
    ...extractTimestampChanges(packet),
    ...extractSegmentationChanges(packet)
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
