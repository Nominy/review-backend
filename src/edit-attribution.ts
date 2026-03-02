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

const NUMBER_WORDS = new Set([
  "ноль",
  "один",
  "одна",
  "одно",
  "два",
  "две",
  "три",
  "четыре",
  "пять",
  "шесть",
  "семь",
  "восемь",
  "девять",
  "десять",
  "одиннадцать",
  "двенадцать",
  "тринадцать",
  "четырнадцать",
  "пятнадцать",
  "шестнадцать",
  "семнадцать",
  "восемнадцать",
  "девятнадцать",
  "двадцать",
  "тридцать",
  "сорок",
  "пятьдесят",
  "шестьдесят",
  "семьдесят",
  "восемьдесят",
  "девяносто",
  "сто",
  "двести",
  "триста",
  "четыреста",
  "пятьсот",
  "шестьсот",
  "семьсот",
  "восемьсот",
  "девятьсот",
  "тысяча"
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
      .replace(/\*\*/g, " ")
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

function punctuationCore(text: string): string {
  const matches = text.match(/[.,!?;:]+/g);
  return matches ? matches.join(" ") : "";
}

function normalizeNumberAwareCore(text: string): string {
  const tokens = tokenize(text);
  return tokens
    .map((token) => {
      if (/^\d+$/.test(token)) return "<num>";
      if (NUMBER_WORDS.has(token)) return "<num>";
      return token;
    })
    .join(" ");
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
  if (shiftMs >= 500) return "severe";
  if (shiftMs >= 250) return "material";
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
  const hasTagChange = rawBefore !== rawAfter && tagStrippedBefore !== rawBefore || tagStrippedAfter !== rawAfter;

  if (rawBefore === rawAfter) {
    const startShiftMs = Math.abs((after.startTimeInSeconds - before.startTimeInSeconds) * 1000);
    const endShiftMs = Math.abs((after.endTimeInSeconds - before.endTimeInSeconds) * 1000);
    const boundaryShiftMs = Math.max(startShiftMs, endShiftMs);
    if (boundaryShiftMs < 250) {
      return null;
    }

    return {
      kind: "timestamp_boundary_adjustment",
      ownerCategory: "Timestamp Accuracy",
      severity: severityFromBoundaryShift(boundaryShiftMs),
      annotationId: before.id,
      linkedAnnotationId: after.id,
      note: `Stable 1:1 segment boundary moved by ${Math.round(boundaryShiftMs)}ms.`,
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
      note: "Markup changed while spoken text stayed the same.",
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
      note: "Numeric rendering changed together with service markup.",
      before: clipText(rawBefore),
      after: clipText(rawAfter)
    };
  }

  if (lexicalBefore === lexicalAfter && punctuationCore(before.content || "") !== punctuationCore(after.content || "")) {
    return {
      kind: "punctuation_only",
      ownerCategory: "Punctuation & Formatting",
      severity: "minor",
      annotationId: before.id,
      linkedAnnotationId: after.id,
      note: "Punctuation changed while lexical content stayed the same.",
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
      ? "Interjection or filler changed; punctuation fallout should stay under word accuracy."
      : "Lexical content changed.",
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
