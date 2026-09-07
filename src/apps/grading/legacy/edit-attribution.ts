import { TIMING_THRESHOLDS } from '../policy';
import type { Annotation, CategoryName, EditSeverity, PromptSample } from "./types";

export type EditAtom = {
  kind: string;
  ownerCategory: CategoryName;
  severity: EditSeverity;
  annotationId: string;
  linkedAnnotationId?: string;
  note: string;
  before?: string;
  after?: string;
};

const INTERJECTION_TOKENS = new Set([
  "а",
  "ага",
  "ах",
  "да",
  "ну",
  "ой",
  "ох",
  "угу",
  "ух",
  "хм",
  "э",
  "эм",
  "ээ",
  "эээ",
  "мм",
  "ммм",
  "мгм"
]);

function clipText(text: string, maxLen = 220): string {
  const value = (text || "").trim();
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}...`;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripServiceTags(text: string): string {
  return normalizeWhitespace(
    text
      .replace(/\[[^\]]+\]/g, " ")
      .replace(/\{[^}]+\}/g, " ")
      .replace(/<\/?[^>]+>/g, " ")
      .replace(/\*/g, "")
  );
}

function lexicalCore(text: string): string {
  return normalizeWhitespace(
    stripServiceTags(text)
      .toLowerCase()
      .replace(/[.,!?;:"'`~@#$%^&_=+\\/|()\[\]{}<>*-]+/g, " ")
  );
}

function tokenize(text: string): string[] {
  return lexicalCore(text).split(" ").filter(Boolean);
}

function normalizeNumberAwareCore(text: string): string {
  // Compare the explicitly preserved spoken form, including compound numbers.
  // Collapsing all numbers to <num> would hide a real correction from five to six.
  return lexicalCore(text.replace(/(?:[+−-]?\d[\d.,:/%°A-Za-zА-Яа-яЁё–—-]*(?:\s+\d[\d.,:/%-]*)*(?:\s*%)?)\s*\{СКАЗ:\s*([^}]+)\}/giu, '$1'));
}

function countTokenDelta(beforeTokens: string[], afterTokens: string[]): number {
  const counts = new Map<string, number>();
  for (const token of beforeTokens) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  for (const token of afterTokens) {
    counts.set(token, (counts.get(token) || 0) - 1);
  }

  let delta = 0;
  for (const value of counts.values()) {
    delta += Math.abs(value);
  }
  return delta;
}

function isInterjectionOnly(beforeTokens: string[], afterTokens: string[]): boolean {
  const filteredBefore = beforeTokens.filter((token) => !INTERJECTION_TOKENS.has(token));
  const filteredAfter = afterTokens.filter((token) => !INTERJECTION_TOKENS.has(token));
  return filteredBefore.join(" ") === filteredAfter.join(" ");
}

function severityFromDelta(delta: number): EditSeverity {
  if (delta >= 5) return "severe";
  if (delta >= 2) return "material";
  return "minor";
}

function severityFromBoundaryShift(shiftMs: number): EditSeverity {
  if (shiftMs >= TIMING_THRESHOLDS.severeMs) return "severe";
  if (shiftMs >= TIMING_THRESHOLDS.materialMs) return "material";
  return "minor";
}

export function classifyStablePair(before: Annotation, after: Annotation): EditAtom | null {
  const rawBefore = normalizeWhitespace(before.content || "");
  const rawAfter = normalizeWhitespace(after.content || "");
  const tagStrippedBefore = stripServiceTags(before.content || "");
  const tagStrippedAfter = stripServiceTags(after.content || "");
  const lexicalBefore = lexicalCore(before.content || "");
  const lexicalAfter = lexicalCore(after.content || "");
  const numberAwareBefore = normalizeNumberAwareCore(before.content || "");
  const numberAwareAfter = normalizeNumberAwareCore(after.content || "");
  const beforeTokens = tokenize(before.content || "");
  const afterTokens = tokenize(after.content || "");
  const tokenDelta = countTokenDelta(beforeTokens, afterTokens);
  const hasTagChange = rawBefore !== rawAfter && (tagStrippedBefore !== rawBefore || tagStrippedAfter !== rawAfter);

  if (rawBefore === rawAfter) {
    const startShiftMs = Math.abs((after.startTimeInSeconds - before.startTimeInSeconds) * 1000);
    const endShiftMs = Math.abs((after.endTimeInSeconds - before.endTimeInSeconds) * 1000);
    const boundaryShiftMs = Math.max(startShiftMs, endShiftMs);
    if (boundaryShiftMs <= TIMING_THRESHOLDS.toleranceMs) {
      return null;
    }

    return {
      kind: "timestamp_boundary_adjustment",
      ownerCategory: "Timestamp Accuracy",
      severity: severityFromBoundaryShift(boundaryShiftMs),
      annotationId: before.id,
      linkedAnnotationId: after.id,
      note: `Граница устойчиво сопоставленного сегмента 1:1 сдвинута на ${Math.round(boundaryShiftMs)} мс.`,
      before: clipText(rawBefore),
      after: clipText(rawAfter)
    };
  }

  if (hasTagChange && tagStrippedBefore === tagStrippedAfter) {
    return {
      kind: "tag_only",
      ownerCategory: "Tags & Emphasis",
      severity: "minor",
      annotationId: before.id,
      linkedAnnotationId: after.id,
      note: "Разметка изменена без изменения произнесённых слов.",
      before: clipText(rawBefore),
      after: clipText(rawAfter)
    };
  }

  if (hasTagChange && numberAwareBefore === numberAwareAfter) {
    return {
      kind: "number_rendering_tag",
      ownerCategory: "Tags & Emphasis",
      severity: "minor",
      annotationId: before.id,
      linkedAnnotationId: after.id,
      note: "Числовая запись изменена вместе со служебной разметкой.",
      before: clipText(rawBefore),
      after: clipText(rawAfter)
    };
  }

  if (lexicalBefore === lexicalAfter) {
    return {
      kind: "punctuation_only",
      ownerCategory: "Punctuation & Formatting",
      severity: "minor",
      annotationId: before.id,
      linkedAnnotationId: after.id,
      note: "Пунктуация изменена без изменения слов.",
      before: clipText(rawBefore),
      after: clipText(rawAfter)
    };
  }

  const interjectionOnly = isInterjectionOnly(beforeTokens, afterTokens);
  const kind = interjectionOnly ? "interjection_insert_or_delete" : "lexical_change";
  const severity = interjectionOnly ? "minor" : severityFromDelta(tokenDelta);

  return {
    kind,
    ownerCategory: "Word Accuracy",
    severity,
    annotationId: before.id,
    linkedAnnotationId: after.id,
    note: interjectionOnly
      ? "Изменено междометие или филлер; зависимая пунктуация относится к той же правке."
      : "Изменены слова.",
    before: clipText(rawBefore),
    after: clipText(rawAfter)
  };
}

export function toPromptSample(atom: EditAtom): PromptSample {
  return {
    kind: atom.kind,
    severity: atom.severity,
    annotationId: atom.annotationId,
    linkedAnnotationId: atom.linkedAnnotationId,
    note: atom.note,
    before: atom.before,
    after: atom.after
  };
}
