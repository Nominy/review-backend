import { fileURLToPath } from "node:url";
import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { registerDraftingRoutes } from "./apps/drafting/routes";
import { registerReviewRoutes } from "./apps/review/routes";
import { config } from "./config";
import { fetchOpenRouterCredits } from "./shared/openrouter-client";
import { BACKEND_VERSION } from "./version";

const PRIVACY_PAGE_PATH = fileURLToPath(new URL("./public/privacy.html", import.meta.url));
type AnyElysia = Elysia<any, any, any, any, any, any, any>;

export function createApp(): AnyElysia {
  const app = new Elysia()
    .use(
      cors({
        origin: config.corsOrigin,
        methods: ["GET", "POST", "PUT", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"]
      })
    )
    .get("/", () => ({
      ok: true,
      service: "babel-review-backend",
      docs: "/health",
      privacy: "/privacy",
      now: new Date().toISOString()
    }))
    .get("/privacy", () => Bun.file(PRIVACY_PAGE_PATH))
    .get("/health", async () => {
      const credits = await fetchOpenRouterCredits(config.openRouterApiKey);
      return {
        ok: true,
        service: "babel-review-backend",
        backendVersion: BACKEND_VERSION,
        testMode: config.openRouterTestMode,
        now: new Date().toISOString(),
        openRouterCredits: credits
      };
    });

  registerReviewRoutes(app);
  registerDraftingRoutes(app);

  return app;
}
