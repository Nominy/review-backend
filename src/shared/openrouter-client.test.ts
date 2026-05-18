import { afterEach, describe, expect, it } from "bun:test";
import { requestOpenRouterChat } from "./openrouter-client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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
