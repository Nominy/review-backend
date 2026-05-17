import { afterEach, describe, expect, test } from "bun:test";
import { assertOpenRouterModelSupportsAudio, requestOpenRouterChat } from "./openrouter-client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenRouter audio support", () => {
  test("accepts models whose OpenRouter catalog input modalities include audio", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "google/gemini-3-flash-preview",
              architecture: { input_modalities: ["text", "audio"] }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )) as unknown as typeof fetch;

    await expect(assertOpenRouterModelSupportsAudio("google/gemini-3-flash-preview")).resolves.toBeUndefined();
  });

  test("rejects models that exist but do not advertise audio input", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "text/model",
              architecture: { input_modalities: ["text"] }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )) as unknown as typeof fetch;

    await expect(assertOpenRouterModelSupportsAudio("text/model")).rejects.toThrow(
      "OpenRouter model does not support audio input: text/model"
    );
  });

  test("sends raw audio parts with snake-case input_audio content", async () => {
    let postedBody: any = null;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "{\"rewrittenText\":\"[смех] Привет\"}" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as unknown as typeof fetch;

    await requestOpenRouterChat({
      apiKey: "sk-or-test",
      model: "google/gemini-3-flash-preview",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Add audio cues." },
            { type: "input_audio", input_audio: { data: "AAAA", format: "wav" } }
          ]
        }
      ],
      title: "Babel Audio Cues"
    });

    const messages = postedBody?.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const audioPart = messages[0].content[1] as Record<string, unknown>;
    expect(audioPart.type).toBe("input_audio");
    expect(audioPart).toHaveProperty("input_audio");
    expect(audioPart).not.toHaveProperty("inputAudio");
  });
});
