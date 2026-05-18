import { afterEach, describe, expect, it } from "bun:test";
import { createApp } from "./app";
import { clearDraftSessionsForTest } from "./apps/drafting/session-store";
import { BACKEND_VERSION } from "./version";

const originalFetch = globalThis.fetch;
const originalDraftStreamKeepaliveMs = process.env.DRAFT_STREAM_KEEPALIVE_MS;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDraftStreamKeepaliveMs === undefined) {
    delete process.env.DRAFT_STREAM_KEEPALIVE_MS;
  } else {
    process.env.DRAFT_STREAM_KEEPALIVE_MS = originalDraftStreamKeepaliveMs;
  }
  clearDraftSessionsForTest();
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

  it("parses optional audio cue multipart payload on the default drafting stream route", async () => {
    const form = new FormData();
    form.set(
      "payload",
      JSON.stringify({
        projectPreset: "ru-gold-2sp-v1",
        jobId: "job-1",
        rows: "bad",
        openRouterApiKey: "sk-or-test"
      })
    );
    form.set("audioTrack:audio-1", new File([new Uint8Array([1, 2, 3])], "audio.wav", { type: "audio/wav" }));

    const response = await createApp().handle(
      new Request("http://localhost/api/draft/generate/stream", {
        method: "POST",
        body: form
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toContain("rows must be a valid transcript row array");
  });

  it("does not expose audio cues as a separate drafting endpoint", async () => {
    const response = await createApp().handle(
      new Request("http://localhost/api/draft/audio-cues/stream", {
        method: "POST",
        body: new FormData()
      })
    );

    expect(response.status).toBe(404);
  });

  it("reconciles an in-flight draft session through the plain generate route without a second model call", async () => {
    let chatCalls = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/api/v1/models")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "google/gemini-3-flash-preview",
                architecture: { input_modalities: ["text", "audio"] }
              }
            ]
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }

      if (target.includes("/api/v1/chat/completions")) {
        chatCalls += 1;
        await delay(30);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ rewrittenText: "Privet." })
                }
              }
            ]
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }

      throw new Error(`Unexpected fetch ${target}`);
    }) as unknown as typeof fetch;

    const payload = {
      projectPreset: "ru-gold-2sp-v1",
      jobId: "job-1",
      draftSessionId: "session-1",
      rows: [
        {
          rowId: "r1",
          speakerKey: "speaker-1",
          startSeconds: 0,
          endSeconds: 1,
          text: "privet",
          index: 0
        }
      ],
      openRouterApiKey: "sk-or-test",
      model: "google/gemini-3-flash-preview"
    };

    const app = createApp();
    const streamResponse = await app.handle(
      new Request("http://localhost/api/draft/generate/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
    );
    const reader = streamResponse.body?.getReader();
    expect(streamResponse.status).toBe(200);
    expect(reader).toBeDefined();
    await reader!.read();

    const reconcileResponse = await app.handle(
      new Request("http://localhost/api/draft/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
    );
    const reconciled = await reconcileResponse.json();
    await reader!.cancel().catch(() => {});

    expect(reconcileResponse.status).toBe(200);
    expect(reconciled.draftRows).toEqual([
      {
        rowId: "r1",
        rewrittenText: "Privet.",
        status: "rewritten",
        warnings: ["length_delta"]
      }
    ]);
    expect(chatCalls).toBe(1);
  });

  it("keeps long-running draft streams alive while waiting for rows", async () => {
    process.env.DRAFT_STREAM_KEEPALIVE_MS = "1";
    globalThis.fetch = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/api/v1/models")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "google/gemini-3-flash-preview",
                architecture: { input_modalities: ["text", "audio"] }
              }
            ]
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }

      if (target.includes("/api/v1/chat/completions")) {
        await delay(25);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ rewrittenText: "Privet." })
                }
              }
            ]
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }

      throw new Error(`Unexpected fetch ${target}`);
    }) as unknown as typeof fetch;

    const response = await createApp().handle(
      new Request("http://localhost/api/draft/generate/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPreset: "ru-gold-2sp-v1",
          jobId: "job-keepalive",
          rows: [
            {
              rowId: "r1",
              speakerKey: "speaker-1",
              startSeconds: 0,
              endSeconds: 1,
              text: "privet",
              index: 0
            }
          ],
          openRouterApiKey: "sk-or-test",
          model: "google/gemini-3-flash-preview"
        })
      })
    );
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain(": keepalive");
    expect(text).toContain("event: done");
  });

  it("serves the dedicated gold drafting privacy page", async () => {
    const response = await createApp().handle(new Request("http://localhost/gold-drafting-privacy"));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("Babel Gold Drafting");
    expect(html).toContain("https://reviewgen.ovh/gold-drafting-privacy");
  });
});
