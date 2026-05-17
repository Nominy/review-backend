import { describe, expect, test } from "bun:test";
import { validateRewrittenRow } from "./validators";

describe("validateRewrittenRow", () => {
  test("fails empty output and falls back to the original row", () => {
    const result = validateRewrittenRow("hello", "");

    expect(result).toEqual({
      acceptedText: "hello",
      status: "failed",
      warnings: ["empty_output"],
      usedFallback: true
    });
  });

  test("keeps tag drift as a warning instead of failing the row", () => {
    const result = validateRewrittenRow("{music} hello", "hello");

    expect(result.status).toBe("rewritten");
    expect(result.usedFallback).toBe(false);
    expect(result.acceptedText).toBe("hello");
    expect(result.warnings).toContain("tag_drift");
  });

  test("allows SKAZ normalization braces without failing the row", () => {
    const result = validateRewrittenRow(
      "i have 123 apples",
      "I have 123 {SKAZ: one two three} apples."
    );

    expect(result.status).toBe("rewritten");
    expect(result.usedFallback).toBe(false);
    expect(result.acceptedText).toBe("I have 123 {SKAZ: one two three} apples.");
    expect(result.warnings).toContain("tag_drift");
  });

  test("warns when the model substitutes transcript words", () => {
    const result = validateRewrittenRow("m.", "uh-huh.");

    expect(result.status).toBe("rewritten");
    expect(result.usedFallback).toBe(false);
    expect(result.acceptedText).toBe("uh-huh.");
    expect(result.warnings).toContain("word_drift");
  });

  test("warns on large non-numeric rewrites", () => {
    const result = validateRewrittenRow("this is a fairly long source row for validation", "completely different text");

    expect(result.status).toBe("rewritten");
    expect(result.usedFallback).toBe(false);
    expect(result.acceptedText).toBe("completely different text");
    expect(result.warnings).toContain("word_drift");
  });

  test("allows numeral changes", () => {
    const result = validateRewrittenRow("i have 2 cats", "I have 3 cats.");

    expect(result.status).toBe("rewritten");
    expect(result.usedFallback).toBe(false);
    expect(result.acceptedText).toBe("I have 3 cats.");
    expect(result.warnings).toContain("length_delta");
  });

  test("allows small punctuation-only cleanup", () => {
    const result = validateRewrittenRow("well yes probably", "Well yes, probably.");

    expect(result).toEqual({
      acceptedText: "Well yes, probably.",
      status: "rewritten",
      warnings: ["length_delta"],
      usedFallback: false
    });
  });

  test("allows adding audio tags without changing transcript words", () => {
    const result = validateRewrittenRow("Hello.", "[laugh] Hello.");

    expect(result.status).toBe("rewritten");
    expect(result.usedFallback).toBe(false);
    expect(result.acceptedText).toBe("[laugh] Hello.");
    expect(result.warnings).toContain("tag_drift");
  });
});
