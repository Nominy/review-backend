import type { DraftRowStatus, RowValidationResult } from "./types";

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function hasBalancedPairs(text: string, openChar: string, closeChar: string): boolean {
  let depth = 0;
  for (const char of text) {
    if (char === openChar) {
      depth += 1;
    } else if (char === closeChar) {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
}

function extractTagTokens(text: string): string[] {
  return text.match(/\{[^{}]*\}|\[[^[\]]*\]|<[^<>]*>/g) ?? [];
}

function tokenizeWords(text: string): string[] {
  return (text.toLocaleLowerCase().match(/[\p{L}\p{N}-]+/gu) ?? []).filter(Boolean);
}

function levenshteinDistance(left: string, right: string): number {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0));

  for (let row = 0; row < rows; row += 1) {
    matrix[row][0] = row;
  }
  for (let col = 0; col < cols; col += 1) {
    matrix[0][col] = col;
  }

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      matrix[row][col] = Math.min(
        matrix[row - 1][col] + 1,
        matrix[row][col - 1] + 1,
        matrix[row - 1][col - 1] + cost
      );
    }
  }

  return matrix[left.length][right.length];
}

function fail(originalText: string, warnings: string[]): RowValidationResult {
  return {
    acceptedText: originalText,
    status: "failed",
    warnings,
    usedFallback: true
  };
}

export function validateRewrittenRow(originalText: string, rewrittenText: string): RowValidationResult {
  const warnings: string[] = [];
  const original = originalText ?? "";
  const rewritten = rewrittenText ?? "";
  const trimmed = rewritten.trim();

  if (!trimmed) {
    return fail(original, ["empty_output"]);
  }

  if (trimmed.includes("\n")) {
    return fail(original, ["newline_drift"]);
  }

  if (
    !hasBalancedPairs(trimmed, "[", "]") ||
    !hasBalancedPairs(trimmed, "{", "}") ||
    !hasBalancedPairs(trimmed, "(", ")")
  ) {
    return fail(original, ["bracket_imbalance"]);
  }

  const originalQuotes = countOccurrences(original, "\"");
  const rewrittenQuotes = countOccurrences(trimmed, "\"");
  if (rewrittenQuotes % 2 !== 0 || (originalQuotes % 2 === 0 && rewrittenQuotes % 2 !== 0)) {
    return fail(original, ["quote_imbalance"]);
  }

  if (JSON.stringify(extractTagTokens(original)) !== JSON.stringify(extractTagTokens(trimmed))) {
    warnings.push("tag_drift");
  }

  const maxLength = Math.max(original.length, trimmed.length, 1);
  const distance = levenshteinDistance(original, trimmed);
  const distanceRatio = distance / maxLength;
  const originalTokens = new Set(tokenizeWords(original));
  const rewrittenTokens = new Set(tokenizeWords(trimmed));
  const sharedTokenCount = Array.from(originalTokens).filter((token) => rewrittenTokens.has(token)).length;
  const overlapRatio =
    originalTokens.size === 0 && rewrittenTokens.size === 0 ? 1 : sharedTokenCount / Math.max(originalTokens.size, 1);

  let status: DraftRowStatus = "rewritten";
  if (trimmed === original) {
    status = "unchanged";
  }

  if (
    (trimmed.length > original.length * 3 + 40 || trimmed.length < Math.max(1, original.length * 0.2)) &&
    original.length > 20 &&
    status === "rewritten"
  ) {
    warnings.push("length_drift");
  }

  if ((distanceRatio > 0.85 || overlapRatio < 0.35) && original.length > 20 && status === "rewritten") {
    warnings.push("edit_distance_drift");
  }

  if (distanceRatio > 0.6 && status === "rewritten") {
    warnings.push("large_edit_distance");
  }

  if (trimmed.length !== original.length && status === "rewritten") {
    warnings.push("length_delta");
  }

  return {
    acceptedText: trimmed,
    status,
    warnings,
    usedFallback: false
  };
}
