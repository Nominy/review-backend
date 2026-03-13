import DiffMatchPatch from "diff-match-patch";
import type { Annotation } from "./types";

const dmp = new DiffMatchPatch();

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type WordEdit = {
  /** "equal" | "insert" | "delete" */
  op: "equal" | "insert" | "delete";
  text: string;
};

export type InlineDiff = {
  /** compact representation: "word [-old+new] word" */
  inline: string;
  /** structured edits for programmatic use */
  edits: WordEdit[];
  /** number of non-equal edits */
  editCount: number;
  /** localized before/after snippets for each edit cluster */
  snippets: Array<{
    before: string;
    after: string;
    inline: string;
    editCount: number;
  }>;
};

export type AlignedPair = {
  before: Annotation | null;
  after: Annotation | null;
  /** "matched" | "deleted" | "inserted" */
  op: "matched" | "deleted" | "inserted";
};

/* ------------------------------------------------------------------ */
/*  Word-level diff (powered by diff-match-patch)                     */
/* ------------------------------------------------------------------ */

/**
 * Returns a semantic word-level diff between two strings.
 *
 * Uses diff-match-patch with `diff_cleanupSemantic` so trivial
 * character edits are merged into meaningful word-level changes.
 *
 * The `inline` field is a compact human-readable representation:
 *   "unchanged text [-removed+added] unchanged text"
 *
 * Context words around each edit are limited to `contextWords` on each side.
 */
export function diffWords(
  before: string,
  after: string,
  contextWords = 4
): InlineDiff {
  const rawBefore = normalize(before);
  const rawAfter = normalize(after);

  if (rawBefore === rawAfter) {
    return { inline: "(no change)", edits: [], editCount: 0, snippets: [] };
  }

  // Run char-level diff, then clean up to word boundaries
  const diffs = dmp.diff_main(rawBefore, rawAfter);
  dmp.diff_cleanupSemantic(diffs);

  // Convert to structured edits
  const edits: WordEdit[] = diffs.map(([op, text]) => ({
    op: op === 0 ? "equal" : op === -1 ? "delete" : "insert",
    text
  }));

  const editCount = edits.filter((e) => e.op !== "equal").length;

  const snippets = buildSnippets(edits, contextWords);
  const inline = snippets.length > 0
    ? snippets.map((snippet) => snippet.inline).join(" | ")
    : "(no change)";

  return { inline, edits, editCount, snippets };
}

function normalize(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

/**
 * Builds a compact inline diff string with limited context around edits.
 *
 * Example output: "...unchanged [-removed+added] unchanged..."
 */
function buildSnippets(
  edits: WordEdit[],
  contextWords: number
): Array<{
  before: string;
  after: string;
  inline: string;
  editCount: number;
}> {
  const groups = groupEditRanges(edits, contextWords);
  if (groups.length === 0) {
    return [];
  }

  return groups.map((group) => {
    const beforeContext = collectContextTokens(edits, group.start, "before", contextWords);
    const afterContext = collectContextTokens(edits, group.end, "after", contextWords);
    const beforeCore = collectGroupTokens(edits, group.start, group.end, "before");
    const afterCore = collectGroupTokens(edits, group.start, group.end, "after");
    const inline = buildInlineGroup(edits, group.start, group.end, contextWords);

    return {
      before: normalizeSnippetTokens([...beforeContext, ...beforeCore, ...afterContext]),
      after: normalizeSnippetTokens([...beforeContext, ...afterCore, ...afterContext]),
      inline,
      editCount: countEditsInRange(edits, group.start, group.end)
    };
  });
}

function groupEditRanges(
  edits: WordEdit[],
  contextWords: number
): Array<{ start: number; end: number }> {
  const editIndices: number[] = [];
  for (let i = 0; i < edits.length; i++) {
    if (edits[i].op !== "equal") {
      editIndices.push(i);
    }
  }

  if (editIndices.length === 0) {
    return [];
  }

  const groups: Array<{ start: number; end: number }> = [];
  let groupStart = editIndices[0];
  let groupEnd = editIndices[0];

  for (let i = 1; i < editIndices.length; i++) {
    const nextIndex = editIndices[i];
    const bridgeWords = countEqualWordsBetween(edits, groupEnd, nextIndex);
    if (bridgeWords <= contextWords) {
      groupEnd = nextIndex;
      continue;
    }

    groups.push({ start: groupStart, end: groupEnd });
    groupStart = nextIndex;
    groupEnd = nextIndex;
  }

  groups.push({ start: groupStart, end: groupEnd });
  return groups;
}

function countEqualWordsBetween(edits: WordEdit[], left: number, right: number): number {
  let words = 0;
  for (let i = left + 1; i < right; i++) {
    if (edits[i].op !== "equal") {
      continue;
    }
    words += toTokens(edits[i].text).length;
  }
  return words;
}

function countEditsInRange(edits: WordEdit[], start: number, end: number): number {
  let count = 0;
  for (let i = start; i <= end; i++) {
    if (edits[i].op !== "equal") {
      count += 1;
    }
  }
  return count;
}

function buildInlineGroup(
  edits: WordEdit[],
  start: number,
  end: number,
  contextWords: number
): string {
  const beforeContext = normalizeSnippetTokens(
    collectContextTokens(edits, start, "before", contextWords)
  );
  const afterContext = normalizeSnippetTokens(
    collectContextTokens(edits, end, "after", contextWords)
  );
  const editParts: string[] = [];

  for (let i = start; i <= end; i++) {
    const edit = edits[i];
    const text = edit.text.trim();
    if (!text) {
      continue;
    }
    if (edit.op === "equal") {
      editParts.push(text);
    } else if (edit.op === "delete") {
      editParts.push(`[-${text}]`);
    } else {
      editParts.push(`[+${text}]`);
    }
  }

  return [
    beforeContext ? `...${beforeContext} ` : "",
    editParts.join(" "),
    afterContext ? ` ${afterContext}...` : ""
  ].join("").replace(/\s+/g, " ").trim();
}

function collectContextTokens(
  edits: WordEdit[],
  editIdx: number,
  direction: "before" | "after",
  maxWords: number
): string[] {
  const words: string[] = [];

  if (direction === "before") {
    for (let i = editIdx - 1; i >= 0 && words.length < maxWords; i--) {
      if (edits[i].op !== "equal") continue;
      const tokens = toTokens(edits[i].text);
      for (let j = tokens.length - 1; j >= 0 && words.length < maxWords; j--) {
        words.unshift(tokens[j]);
      }
    }
  } else {
    for (let i = editIdx + 1; i < edits.length && words.length < maxWords; i++) {
      if (edits[i].op !== "equal") continue;
      const tokens = toTokens(edits[i].text);
      for (let j = 0; j < tokens.length && words.length < maxWords; j++) {
        words.push(tokens[j]);
      }
    }
  }

  return words;
}

function collectGroupTokens(
  edits: WordEdit[],
  start: number,
  end: number,
  side: "before" | "after"
): string[] {
  const tokens: string[] = [];

  for (let i = start; i <= end; i++) {
    const edit = edits[i];
    if (side === "before" && edit.op === "insert") {
      continue;
    }
    if (side === "after" && edit.op === "delete") {
      continue;
    }
    tokens.push(...toTokens(edit.text));
  }

  return tokens;
}

function normalizeSnippetTokens(tokens: string[]): string {
  return normalize(tokens.join(" "))
    .replace(/\s+([,.;:!?)\]\}»])/g, "$1")
    .replace(/([(\[{«])\s+/g, "$1");
}

function toTokens(text: string): string[] {
  return String(text || "").trim().split(/\s+/).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/*  Segment alignment via LCS on time overlap                         */
/* ------------------------------------------------------------------ */

/**
 * Aligns two annotation arrays using LCS (Longest Common Subsequence)
 * based on time overlap + text similarity.
 *
 * Unlike the naive index-by-index pairing, this correctly handles:
 * - Inserted segments
 * - Deleted segments
 * - Reordered segments (within reasonable time proximity)
 *
 * Returns aligned pairs where each pair is either:
 * - matched: both before and after exist (may have text changes)
 * - deleted: only before exists (segment was removed)
 * - inserted: only after exists (segment was added)
 */
export function alignSegments(
  original: Annotation[],
  current: Annotation[]
): AlignedPair[] {
  const m = original.length;
  const n = current.length;

  if (m === 0 && n === 0) return [];
  if (m === 0) return current.map((a) => ({ before: null, after: a, op: "inserted" as const }));
  if (n === 0) return original.map((a) => ({ before: a, after: null, op: "deleted" as const }));

  // Build LCS table using match score (time overlap + text similarity)
  // dp[i][j] = best alignment score for original[0..i-1] vs current[0..j-1]
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );

  const matchScore: number[][] = Array.from({ length: m }, () =>
    new Array(n).fill(0)
  );

  // Precompute match scores
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      matchScore[i][j] = computeMatchScore(original[i], current[j]);
    }
  }

  // Fill DP table
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const score = matchScore[i - 1][j - 1];
      if (score > 0) {
        dp[i][j] = Math.max(
          dp[i - 1][j],
          dp[i][j - 1],
          dp[i - 1][j - 1] + score
        );
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find optimal alignment
  const pairs: AlignedPair[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (
      i > 0 &&
      j > 0 &&
      matchScore[i - 1][j - 1] > 0 &&
      dp[i][j] === dp[i - 1][j - 1] + matchScore[i - 1][j - 1]
    ) {
      // Match
      pairs.push({
        before: original[i - 1],
        after: current[j - 1],
        op: "matched"
      });
      i--;
      j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j]) {
      // Deletion
      pairs.push({
        before: original[i - 1],
        after: null,
        op: "deleted"
      });
      i--;
    } else {
      // Insertion
      pairs.push({
        before: null,
        after: current[j - 1],
        op: "inserted"
      });
      j--;
    }
  }

  pairs.reverse();
  return pairs;
}

/**
 * Score how well two annotations match (0 = no match).
 * Uses time overlap as primary signal + token overlap as secondary.
 *
 * A score > 0 means these annotations likely refer to the same
 * portion of audio and should be paired for comparison.
 */
function computeMatchScore(a: Annotation, b: Annotation): number {
  const overlapSec = Math.max(
    0,
    Math.min(a.endTimeInSeconds, b.endTimeInSeconds) -
      Math.max(a.startTimeInSeconds, b.startTimeInSeconds)
  );

  const aDuration = Math.max(0.001, a.endTimeInSeconds - a.startTimeInSeconds);
  const bDuration = Math.max(0.001, b.endTimeInSeconds - b.startTimeInSeconds);
  const minDuration = Math.min(aDuration, bDuration);

  // Time overlap ratio: what fraction of the shorter segment overlaps?
  const overlapRatio = overlapSec / minDuration;

  // Require at least 20% time overlap to consider a match
  if (overlapRatio < 0.2) return 0;

  // Token overlap as secondary signal
  const aTokens = tokenize(a.content || "");
  const bTokens = tokenize(b.content || "");
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  let shared = 0;
  for (const t of aSet) {
    if (bSet.has(t)) shared++;
  }
  const tokenRatio = aSet.size + bSet.size > 0
    ? (2 * shared) / (aSet.size + bSet.size)
    : 0;

  // Combined score: weighted sum
  return overlapRatio * 0.6 + tokenRatio * 0.4;
}

function tokenize(text: string): string[] {
  return text.replace(/\s+/g, " ").trim().toLowerCase().split(/\s+/).filter(Boolean);
}
