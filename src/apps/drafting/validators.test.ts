import { describe, expect, test } from "bun:test";
import { validateRewrittenRow } from "./validators";

describe("validateRewrittenRow", () => {
  test("fails empty output and falls back to the original row", () => {
    const result = validateRewrittenRow("привет", "");

    expect(result).toEqual({
      acceptedText: "привет",
      status: "failed",
      warnings: ["empty_output"],
      usedFallback: true
    });
  });

  test("fails when markup tags drift", () => {
    const result = validateRewrittenRow("{music} привет", "привет");

    expect(result).toEqual({
      acceptedText: "{music} привет",
      status: "failed",
      warnings: ["tag_drift"],
      usedFallback: true
    });
  });

  test("keeps large rewrites as warnings instead of failing the row", () => {
    const result = validateRewrittenRow("это довольно длинная исходная строка для проверки", "совсем другой текст без совпадений");

    expect(result.status).toBe("rewritten");
    expect(result.usedFallback).toBe(false);
    expect(result.acceptedText).toBe("совсем другой текст без совпадений");
    expect(result.warnings).toContain("edit_distance_drift");
    expect(result.warnings).toContain("large_edit_distance");
  });

  test("does not fail on numeral changes", () => {
    const result = validateRewrittenRow("у меня 2 кота", "У меня два кота.");

    expect(result.status).toBe("rewritten");
    expect(result.usedFallback).toBe(false);
    expect(result.acceptedText).toBe("У меня два кота.");
    expect(result.warnings).toContain("length_delta");
  });

  test("allows small punctuation-only cleanup", () => {
    const result = validateRewrittenRow("ну да наверное", "Ну да, наверное.");

    expect(result).toEqual({
      acceptedText: "Ну да, наверное.",
      status: "rewritten",
      warnings: ["length_delta"],
      usedFallback: false
    });
  });
});
