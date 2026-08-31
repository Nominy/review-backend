import { afterEach, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { registerLocalEngineRoutes } from "./local-engine-routes";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("local engine proxy", () => {
  it("preserves Retry-After from an upstream 429 response", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Too many in-flight requests." }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "5"
        }
      })) as unknown as typeof fetch;

    const app = new Elysia();
    registerLocalEngineRoutes(app);
    const response = await app.handle(
      new Request("http://localhost/api/local-engine/health", {
        headers: { Origin: "https://dashboard.babel.audio" }
      })
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("retry-after")).toBe("5");
  });

  it("does not synthesize Retry-After when the upstream response omits it", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Engine error." }), {
        status: 503,
        headers: { "Content-Type": "application/json" }
      })) as unknown as typeof fetch;

    const app = new Elysia();
    registerLocalEngineRoutes(app);
    const response = await app.handle(
      new Request("http://localhost/api/local-engine/health", {
        headers: { Origin: "https://dashboard.babel.audio" }
      })
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.has("retry-after")).toBe(false);
  });
});
