import { afterEach, describe, expect, test } from "bun:test";
import { parseResponseText, rewriteRowWithModel } from "./openrouter";
import type { LoadedProjectPreset, RowRewriteContext, RewriteRowDeps } from "./types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const preset: LoadedProjectPreset = {
  id: "ru-gold-2sp-v1",
  version: "test",
  title: "Test",
  sourceGuidePath: "test.csv",
  constraints: [],
  rules: [],
  examples: []
};

const deps: RewriteRowDeps & { apiKey: string } = {
  apiKey: "sk-or-test",
  model: "google/gemini-3-flash-preview",
  preset,
  systemPrompt: "system",
  testMode: false
};

describe("parseResponseText", () => {
  test("returns plain text responses as-is", () => {
    expect(parseResponseText("Привет, как дела?")).toBe("Привет, как дела?");
  });

  test("parses valid JSON responses", () => {
    expect(parseResponseText("{\"rewrittenText\":\"Привет.\"}")).toBe("Привет.");
  });

  test("recovers rewrittenText when direct-speech quotes break JSON escaping", () => {
    const malformed = "{\"rewrittenText\":\"Он сказал: \"да\", и ушёл.\"}";
    expect(parseResponseText(malformed)).toBe("Он сказал: \"да\", и ушёл.");
  });

  test("accepts fenced json payloads", () => {
    const fenced = "```json\n{\"rewrittenText\":\"Ну, ладно.\"}\n```";
    expect(parseResponseText(fenced)).toBe("Ну, ладно.");
  });

  test("falls back to the raw text when malformed JSON cannot be recovered", () => {
    const malformed = "{\"rewrittenText\":\"Незакрытая строка}";
    expect(parseResponseText(malformed)).toBe(malformed);
  });
});

describe("rewriteRowWithModel", () => {
  test("attaches audio clips to the same OpenRouter row rewrite request", async () => {
    let postedBody: any = null;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      postedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "Privet." } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as unknown as typeof fetch;

    const context: RowRewriteContext = {
      currentRow: {
        rowId: "r1",
        speakerKey: "Speaker 1",
        startSeconds: 1,
        endSeconds: 2,
        text: "privet",
        index: 0
      },
      tagSystem: "[smekh]",
      audioClips: [
        {
          trackId: "lane-1",
          speakerKey: "speaker-1",
          trackLabel: "Speaker 1",
          format: "wav",
          base64: "AAAA"
        }
      ]
    };

    await rewriteRowWithModel(context, deps);

    const userContent = postedBody.messages[1].content as Array<Record<string, unknown>>;
    expect(Array.isArray(userContent)).toBe(true);
    expect(userContent.some((part) => part.type === "input_audio")).toBe(true);
    expect(userContent[0].type).toBe("text");
  });

  test("marks the stable system prompt as a Gemini prompt-cache breakpoint", async () => {
    let postedBody: any = null;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      postedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "Privet." } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as unknown as typeof fetch;

    await rewriteRowWithModel(
      {
        currentRow: {
          rowId: "r1",
          speakerKey: "Speaker 1",
          startSeconds: 1,
          endSeconds: 2,
          text: "privet",
          index: 0
        }
      },
      {
        ...deps,
        systemPrompt: "stable drafting rules"
      }
    );

    expect(postedBody.messages[0].content).toEqual([
      {
        type: "text",
        text: "stable drafting rules",
        cache_control: { type: "ephemeral" }
      }
    ]);
    expect(typeof postedBody.messages[1].content).toBe("string");
    expect(JSON.stringify(postedBody.messages[1].content)).not.toContain("cache_control");
  });

  test("does not add Gemini cache-control blocks to other model families", async () => {
    let postedBody: any = null;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      postedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "Privet." } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as unknown as typeof fetch;

    await rewriteRowWithModel(
      {
        currentRow: {
          rowId: "r1",
          speakerKey: "Speaker 1",
          startSeconds: 1,
          endSeconds: 2,
          text: "privet",
          index: 0
        }
      },
      {
        ...deps,
        model: "openai/test-model",
        systemPrompt: "stable drafting rules"
      }
    );

    expect(postedBody.messages[0].content).toBe("stable drafting rules");
    expect(JSON.stringify(postedBody.messages)).not.toContain("cache_control");
  });

  test("keeps dynamic audio row data after the cached Gemini prompt prefix", async () => {
    let postedBody: any = null;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      postedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "Privet." } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as unknown as typeof fetch;

    await rewriteRowWithModel(
      {
        currentRow: {
          rowId: "r1",
          speakerKey: "Speaker 1",
          startSeconds: 1,
          endSeconds: 2,
          text: "privet",
          index: 0
        },
        tagSystem: "[smekh]\n[kashel]",
        audioClips: [
          {
            trackId: "lane-1",
            speakerKey: "speaker-1",
            trackLabel: "Speaker 1",
            format: "wav",
            base64: "AAAA"
          }
        ]
      },
      deps
    );

    const userContent = postedBody.messages[1].content as Array<Record<string, any>>;
    const cachedTextParts = userContent.filter((part) => part.cache_control);

    expect(cachedTextParts).toHaveLength(1);
    expect(cachedTextParts[0]).toMatchObject({
      type: "text",
      cache_control: { type: "ephemeral" }
    });
    expect(cachedTextParts[0].text).toContain("[smekh]");
    expect(cachedTextParts[0].text).not.toContain("privet");
    expect(cachedTextParts[0].text).not.toContain("trackId=lane-1");
    expect(userContent.some((part) => part.type === "input_audio")).toBe(true);
    expect(JSON.stringify(userContent.at(-1))).not.toContain("cache_control");
  });

  test("passes the selected service tier into OpenRouter requests", async () => {
    let postedBody: any = null;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      postedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "Privet." } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as unknown as typeof fetch;

    await rewriteRowWithModel(
      {
        currentRow: {
          rowId: "r1",
          speakerKey: "Speaker 1",
          startSeconds: 1,
          endSeconds: 2,
          text: "privet",
          index: 0
        }
      },
      {
        ...deps,
        serviceTier: "priority"
      }
    );

    expect(postedBody.service_tier).toBe("priority");
  });

  test("passes the selected reasoning effort into OpenRouter requests", async () => {
    let postedBody: any = null;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      postedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "Privet." } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as unknown as typeof fetch;

    await rewriteRowWithModel(
      {
        currentRow: {
          rowId: "r1",
          speakerKey: "Speaker 1",
          startSeconds: 1,
          endSeconds: 2,
          text: "privet",
          index: 0
        }
      },
      {
        ...deps,
        reasoningEffort: "high"
      }
    );

    expect(postedBody.reasoning).toEqual({
      effort: "high",
      exclude: true
    });
  });
});
