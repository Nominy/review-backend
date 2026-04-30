import { afterEach, describe, expect, it } from "bun:test";
import { requestOpenRouterChat } from "./openrouter-client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("requestOpenRouterChat", () => {
  it("retries without reasoning when routing rejects reasoning parameters", async () => {
    let callCount = 0;

    globalThis.fetch = ((_: string | URL | globalThis.Request, init?: RequestInit) => {
      callCount += 1;
      const payload = JSON.parse(String(init?.body || "{}")) as {
        model?: string;
        reasoning?: { effort: string };
      };

      if (callCount === 1) {
        expect(payload.reasoning).toBeTruthy();

        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                message:
                  "No endpoints found that can handle the requested parameters. To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection",
                code: 404
              }
            }),
            { status: 404, headers: { "Content-Type": "application/json" } }
          )
        );
      }

      expect(payload.reasoning).toBeUndefined();
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "fallback-content"
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }) as unknown as typeof fetch;

    const content = await requestOpenRouterChat({
      apiKey: "test-key",
      model: "openai/test-model",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.2,
      reasoningEffort: "low",
      title: "test"
    });

    expect(content).toBe("fallback-content");
    expect(callCount).toBe(2);
  });

  it("throws when non-routing 404 happens", async () => {
    globalThis.fetch = ((_: string | URL | globalThis.Request, init?: RequestInit) => {
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: { message: "model does not exist", code: 404 } }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        )
      );
    }) as unknown as typeof fetch;

    await expect(
      requestOpenRouterChat({
        apiKey: "test-key",
        model: "openai/test-model",
        messages: [{ role: "user", content: "hello" }],
        temperature: 0.2,
        reasoningEffort: "low",
        title: "test"
      })
    ).rejects.toThrow("OpenRouter HTTP 404");
  });
});
