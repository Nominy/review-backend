import { afterEach, describe, expect, it } from "bun:test";
import { requestOpenRouterChat } from "./openrouter-client";

const originalFetch = globalThis.fetch;
const originalChatTimeout = process.env.OPENROUTER_CHAT_TIMEOUT_MS;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalChatTimeout === undefined) {
    delete process.env.OPENROUTER_CHAT_TIMEOUT_MS;
  } else {
    process.env.OPENROUTER_CHAT_TIMEOUT_MS = originalChatTimeout;
  }
});

describe("requestOpenRouterChat", () => {
  it("sends a requested flex service tier", async () => {
    let postedBody: any = null;

    globalThis.fetch = ((_: string | URL | globalThis.Request, init?: RequestInit) => {
      postedBody = JSON.parse(String(init?.body || "{}"));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "content"
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }) as unknown as typeof fetch;

    await requestOpenRouterChat({
      apiKey: "test-key",
      model: "openai/test-model",
      messages: [{ role: "user", content: "hello" }],
      serviceTier: "flex",
      title: "test"
    });

    expect(postedBody.service_tier).toBe("flex");
  });

  it("assembles assistant content from an SSE streaming response", async () => {
    const sseBody = [
      ": OPENROUTER PROCESSING",
      "",
      'data: {"choices":[{"delta":{"content":"Hello, "}}]}',
      'data: {"choices":[{"delta":{"content":"world."},"finish_reason":"stop"}]}',
      "data: [DONE]",
      ""
    ].join("\n");

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(sseBody, { status: 200, headers: { "Content-Type": "text/event-stream" } })
      )) as unknown as typeof fetch;

    const content = await requestOpenRouterChat({
      apiKey: "test-key",
      model: "openai/test-model",
      messages: [{ role: "user", content: "hello" }],
      title: "test"
    });

    expect(content).toBe("Hello, world.");
  });

  it("surfaces mid-stream SSE error payloads", async () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"partial"}}]}',
      'data: {"error":{"code":502,"message":"Provider exploded"}}',
      ""
    ].join("\n");

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(sseBody, { status: 200, headers: { "Content-Type": "text/event-stream" } })
      )) as unknown as typeof fetch;

    await expect(
      requestOpenRouterChat({
        apiKey: "test-key",
        model: "openai/test-model",
        messages: [{ role: "user", content: "hello" }],
        title: "test"
      })
    ).rejects.toThrow(/Provider exploded/);
  });

  it("retries empty 200 bodies before failing", async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(new Response("", { status: 200 }));
    }) as unknown as typeof fetch;

    await expect(
      requestOpenRouterChat({
        apiKey: "test-key",
        model: "openai/test-model",
        messages: [{ role: "user", content: "hello" }],
        title: "test"
      })
    ).rejects.toThrow(/non-JSON payload/);
    expect(calls).toBe(3);
  });

  it("omits service_tier when client selects default capacity", async () => {
    let postedBody: any = null;

    globalThis.fetch = ((_: string | URL | globalThis.Request, init?: RequestInit) => {
      postedBody = JSON.parse(String(init?.body || "{}"));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "content"
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }) as unknown as typeof fetch;

    await requestOpenRouterChat({
      apiKey: "test-key",
      model: "openai/test-model",
      messages: [{ role: "user", content: "hello" }],
      serviceTier: "default",
      title: "test"
    });

    expect("service_tier" in postedBody).toBe(false);
  });

  it("aborts chat requests that exceed the configured timeout", async () => {
    process.env.OPENROUTER_CHAT_TIMEOUT_MS = "5";

    globalThis.fetch = ((_: string | URL | globalThis.Request, init?: RequestInit) => {
      if (!init?.signal) {
        return Promise.reject(new Error("missing abort signal"));
      }

      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    await expect(
      requestOpenRouterChat({
        apiKey: "test-key",
        model: "openai/test-model",
        messages: [{ role: "user", content: "hello" }],
        title: "test"
      })
    ).rejects.toThrow("OpenRouter request timed out after 5ms");
  });

  it("treats an empty assistant message as an upstream model error", async () => {
    globalThis.fetch = ((_: string | URL | globalThis.Request, init?: RequestInit) => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                native_finish_reason: "MAX_TOKENS",
                message: {
                  content: ""
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }) as unknown as typeof fetch;

    await expect(
      requestOpenRouterChat({
        apiKey: "test-key",
        model: "openai/test-model",
        messages: [{ role: "user", content: "hello" }],
        title: "test"
      })
    ).rejects.toThrow("OpenRouter returned empty assistant content");
  });

  it("surfaces top-level OpenRouter error payloads even when HTTP status is ok", async () => {
    globalThis.fetch = ((_: string | URL | globalThis.Request, init?: RequestInit) => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              message: "The operation was aborted",
              code: 504
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }) as unknown as typeof fetch;

    await expect(
      requestOpenRouterChat({
        apiKey: "test-key",
        model: "google/gemini-3.5-flash",
        messages: [{ role: "user", content: "hello" }],
        title: "test"
      })
    ).rejects.toThrow("OpenRouter error 504: The operation was aborted");
  });

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

  it("treats openai/gpt-5.4-nano like other routing-sensitive models", async () => {
    let callCount = 0;
    const model = "openai/gpt-5.4-nano";

    globalThis.fetch = ((_: string | URL | globalThis.Request, init?: RequestInit) => {
      callCount += 1;
      const payload = JSON.parse(String(init?.body || "{}")) as {
        model?: string;
        reasoning?: { effort: string };
      };

      if (callCount === 1) {
        expect(payload.model).toBe(model);
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

      expect(payload.model).toBe(model);
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
      model,
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.2,
      reasoningEffort: "low",
      title: "test"
    });

    expect(content).toBe("fallback-content");
    expect(callCount).toBe(2);
  });

  it("falls back to dropping provider routing when 404 provider-routing persists", async () => {
    let callCount = 0;
    const model = "openai/gpt-5.4-nano";

    globalThis.fetch = ((_: string | URL | globalThis.Request, init?: RequestInit) => {
      callCount += 1;
      const payload = JSON.parse(String(init?.body || "{}")) as {
        model?: string;
        provider?: { sort?: string };
        reasoning?: { effort: string };
      };

      if (callCount === 1) {
        expect(payload.model).toBe(model);
        expect(payload.provider).toBeDefined();
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

      if (callCount === 2) {
        expect(payload.model).toBe(model);
        expect(payload.provider).toBeDefined();
        expect(payload.reasoning).toBeUndefined();
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

      expect(payload.model).toBe(model);
      expect(payload.provider).toBeUndefined();
      expect(payload.reasoning).toBeTruthy();
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "providerless-content"
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
      model,
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.2,
      reasoningEffort: "low",
      title: "test"
    });

    expect(content).toBe("providerless-content");
    expect(callCount).toBe(3);
  });
});
