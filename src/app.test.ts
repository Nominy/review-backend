import { afterEach, describe, expect, it } from "bun:test";
import { createApp } from "./app";
import { BACKEND_VERSION } from "./version";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createApp", () => {
  it("serves the health route with backend metadata", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            total_credits: 10,
            total_usage: 2,
            remaining_credits: 8
          }
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      )) as unknown as typeof fetch;

    const response = await createApp().handle(new Request("http://localhost/health"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.service).toBe("babel-review-backend");
    expect(payload.backendVersion).toEqual(BACKEND_VERSION);
  });

  it("keeps the review API mounted under the existing namespace", async () => {
    const response = await createApp().handle(
      new Request("http://localhost/api/review/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toContain("reviewActionId");
  });

  it("mounts the drafting API under /api/draft", async () => {
    const response = await createApp().handle(
      new Request("http://localhost/api/draft/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toContain("projectPreset");
  });
});
