import { describe, expect, test } from "bun:test";
import { validateRewrittenRow } from "./validators";

describe("validateRewrittenRow", () => {
  test("rejects empty output and falls back to the original row", () => {
    const result = validateRewrittenRow("privet", "   ");
    expect(result.status).toBe("failed");
    expect(result.acceptedText).toBe("privet");
    expect(result.warnings).toEqual(["empty_output"]);
  });

  test("rejects tag drift", () => {
    const result = validateRewrittenRow("privet {ШУМ: смех}", "Privet.");
    expect(result.status).toBe("failed");
    expect(result.warnings).toEqual(["tag_drift"]);
  });

  test("rejects suspiciously large rewrites", () => {
    const result = validateRewrittenRow(
      "ну то есть мы как могли сглаживали ситуацию и просто пытались ее выровнять",
      "Совершенно другой текст, который не похож на исходную строку и радикально переписывает ее целиком."
    );
    expect(result.status).toBe("failed");
    expect(result.warnings).toContain("edit_distance_drift");
  });

  test("accepts small formatting rewrites", () => {
    const result = validateRewrittenRow(
      "ну то есть мы как могли сглаживали ситуацию",
      "Ну, то есть, мы, как могли, сглаживали ситуацию."
    );
    expect(result.status).toBe("rewritten");
    expect(result.acceptedText).toBe("Ну, то есть, мы, как могли, сглаживали ситуацию.");
  });
});
