import type { Elysia } from "elysia";
import { config } from "../../config";

type AnyElysia = Elysia<any, any, any, any, any, any, any>;

function localEngineUrl(path: string): string {
  return `${config.localEngineBaseUrl.replace(/\/+$/, "")}${path}`;
}

function assertDashboardOrigin(request: Request): void {
  const origin = request.headers.get("origin") || "";
  if (origin !== "https://dashboard.babel.audio") {
    throw new Error("Local engine proxy only accepts requests from the Babel dashboard.");
  }
}

function multipartBodyToFormData(body: unknown): FormData {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Expected multipart form data.");
  }
  const form = new FormData();
  for (const [key, rawValue] of Object.entries(body as Record<string, unknown>)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (typeof value === "string") {
        form.append(key, value);
      } else if (value instanceof File) {
        form.append(key, value, value.name);
      } else if (value instanceof Blob) {
        form.append(key, value, "audio.wav");
      } else if (key === "payload" && value && typeof value === "object") {
        form.append(key, JSON.stringify(value));
      } else {
        throw new Error(`Unsupported multipart field: ${key}`);
      }
    }
  }
  return form;
}

async function proxyLocalEngine(path: string, init?: RequestInit): Promise<Response> {
  try {
    const upstream = await fetch(localEngineUrl(path), init);
    const headers = new Headers();
    const contentType = upstream.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter !== null) headers.set("retry-after", retryAfter);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers
    });
  } catch (error) {
    return Response.json(
      {
        error: "Local engine is unavailable.",
        detail: error instanceof Error ? error.message : String(error)
      },
      { status: 502 }
    );
  }
}

export function registerLocalEngineRoutes(app: AnyElysia): void {
  app.onRequest(({ request }) => {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith("/api/local-engine/")) {
      try {
        assertDashboardOrigin(request);
      } catch (error) {
        return new Response(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          { status: 403, headers: { "content-type": "application/json" } }
        );
      }
    }
    return undefined;
  });
  app.get("/api/local-engine/health", ({ request, set }) => {
    try {
      assertDashboardOrigin(request);
      return proxyLocalEngine("/health");
    } catch (error) {
      set.status = 403;
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
  app.post("/api/local-engine/draft", ({ body, set, request }) => {
    try {
      assertDashboardOrigin(request);
      const form = multipartBodyToFormData(body);
      return proxyLocalEngine("/v1/draft", {
        method: "POST",
        body: form,
        headers: { "X-Babel-Local-Engine": "1" }
      });
    } catch (error) {
      set.status = 400;
      return {
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });
}
