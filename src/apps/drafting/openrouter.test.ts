import { describe, expect, it } from "bun:test";
import { parseResponseText } from "./openrouter";

describe("parseResponseText", () => {
  it("parses valid JSON responses", () => {
    expect(parseResponseText("{\"rewrittenText\":\"Привет.\"}")).toBe("Привет.");
  });

  it("recovers rewrittenText when direct-speech quotes break JSON escaping", () => {
    const malformed = "{\"rewrittenText\":\"Он сказал: \"да\", и ушёл.\"}";
    expect(parseResponseText(malformed)).toBe("Он сказал: \"да\", и ушёл.");
  });

  it("accepts fenced json payloads", () => {
    const fenced = "```json\n{\"rewrittenText\":\"Ну, ладно.\"}\n```";
    expect(parseResponseText(fenced)).toBe("Ну, ладно.");
  });
});
