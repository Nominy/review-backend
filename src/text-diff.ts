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
    return { inline: "(no change)", edits: [], editCount: 0 };
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

  // Build compact inline representation with limited context
  const inline = buildInline(edits, contextWords);

  return { inline, edits, editCount };
}

function normalize(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

/**
 * Builds a compact inline diff string with limited context around edits.
 *
 * Example output: "...unchanged [-removed+added] unchanged..."
 */
function buildInline(edits: WordEdit[], contextWords: number): string {
  if (edits.length === 0) return "(no change)";

  // Find the indices of non-equal edits
  const editIndices: number[] = [];
  for (let i = 0; i < edits.length; i++) {
    if (edits[i].op !== "equal") editIndices.push(i);
  }

  if (editIndices.length === 0) return "(no change)";

  // Group consecutive edit indices into ranges
  const groups: Array<{ start: number; end: number }> = [];
  let groupStart = editIndices[0];
  let groupEnd = editIndices[0];

  for (let i = 1; i < editIndices.length; i++) {
    if (editIndices[i] <= groupEnd + 2) {
      // consecutive or separated by one equal chunk -- keep in same group
      groupEnd = editIndices[i];
    } else {
      groups.push({ start: groupStart, end: groupEnd });
      groupStart = editIndices[i];
      groupEnd = editIndices[i];
    }
  }
  groups.push({ start: groupStart, end: groupEnd });

  // Render each group with context
  const parts: string[] = [];
  for (const group of groups) {
    // Grab context before
    const beforeContext = collectContext(edits, group.start, "before", contextWords);
    // Grab context after
    const afterContext = collectContext(edits, group.end, "after", contextWords);

    // Render the edit region
    const editParts: string[] = [];
    for (let i = group.start; i <= group.end; i++) {
      const edit = edits[i];
      if (edit.op === "equal") {
        editParts.push(edit.text);
      } else if (edit.op === "delete") {
        editParts.push(`[-${edit.text.trim()}]`);
      } else {
        editParts.push(`[+${edit.text.trim()}]`);
      }
    }

    const chunk = [
      beforeContext ? `...${beforeContext} ` : "",
      editParts.join(""),
      afterContext ? ` ${afterContext}...` : ""
    ].join("");

    parts.push(chunk);
  }

  return parts.join(" | ");
}

function collectContext(
  edits: WordEdit[],
  editIdx: number,
  direction: "before" | "after",
  maxWords: number
): string {
  const words: string[] = [];

  if (direction === "before") {
    for (let i = editIdx - 1; i >= 0 && words.length < maxWords; i--) {
      if (edits[i].op !== "equal") continue;
      const tokens = edits[i].text.trim().split(/\s+/).filter(Boolean);
      for (let j = tokens.length - 1; j >= 0 && words.length < maxWords; j--) {
        words.unshift(tokens[j]);
      }
    }
  } else {
    for (let i = editIdx + 1; i < edits.length && words.length < maxWords; i++) {
      if (edits[i].op !== "equal") continue;
      const tokens = edits[i].text.trim().split(/\s+/).filter(Boolean);
      for (let j = 0; j < tokens.length && words.length < maxWords; j++) {
        words.push(tokens[j]);
      }
    }
  }

  return words.join(" ");
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
