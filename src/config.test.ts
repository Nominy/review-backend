import { afterEach, describe, expect, it } from "bun:test";

const CONFIG_ENV_KEYS = [
  "OPENROUTER_TEST_MODE",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "HOST",
  "PORT",
  "PUBLIC_BASE_URL",
  "CORS_ALLOWED_ORIGINS",
  "ANALYTICS_LOG_PATH",
  "REVIEW_SESSIONS_DIR",
  "PENDING_TEMPLATE_PROPOSAL_PATH",
  "TEMPLATES_LAB_USERNAME",
  "TEMPLATES_LAB_PASSWORD"
] as const;

const originalEnv = new Map<string, string | undefined>(
  CONFIG_ENV_KEYS.map((key) => [key, process.env[key]])
);

function restoreEnv() {
  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (typeof value === "undefined") {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function importFreshConfig() {
  return import(`./config.ts?test=${Date.now()}-${Math.random()}`);
}

afterEach(() => {
  restoreEnv();
});

describe("config", () => {
  it("parses shared OpenRouter and host settings from env", async () => {
    process.env.OPENROUTER_TEST_MODE = "true";
    process.env.OPENROUTER_API_KEY = "";
    process.env.OPENROUTER_MODEL = "openai/test-model";
    process.env.HOST = "0.0.0.0";
    process.env.PORT = "4567";
    delete process.env.PUBLIC_BASE_URL;
    process.env.CORS_ALLOWED_ORIGINS = "https://a.test, https://b.test";

    const { config } = await importFreshConfig();

    expect(config.openRouterTestMode).toBe(true);
    expect(config.openRouterApiKey).toBe("");
    expect(config.openRouterModel).toBe("openai/test-model");
    expect(config.publicBaseUrl).toBe("http://127.0.0.1:4567");
    expect(config.corsOrigin).toEqual(["https://a.test", "https://b.test"]);
  });

  it("parses review-owned storage and templates lab settings", async () => {
    process.env.OPENROUTER_TEST_MODE = "false";
    process.env.OPENROUTER_API_KEY = "review-key";
    process.env.ANALYTICS_LOG_PATH = "custom/logs/review.log";
    process.env.REVIEW_SESSIONS_DIR = "custom/review-sessions";
    process.env.PENDING_TEMPLATE_PROPOSAL_PATH = "custom/pending-template-proposals.json";
    process.env.TEMPLATES_LAB_USERNAME = "lab-user";
    process.env.TEMPLATES_LAB_PASSWORD = "lab-pass";

    const { config } = await importFreshConfig();

    expect(config.analyticsLogPath).toBe("custom/logs/review.log");
    expect(config.reviewSessionsDir).toBe("custom/review-sessions");
    expect(config.pendingTemplateProposalPath).toBe("custom/pending-template-proposals.json");
    expect(config.templatesLabUsername).toBe("lab-user");
    expect(config.templatesLabPassword).toBe("lab-pass");
    expect(config.templatesLabEnabled).toBe(true);
  });

  it("exposes the shared model settings drafting now relies on", async () => {
    process.env.OPENROUTER_TEST_MODE = "true";
    process.env.OPENROUTER_API_KEY = "";
    process.env.OPENROUTER_MODEL = "openai/drafting-model";

    const { config } = await importFreshConfig();

    expect(config.openRouterTestMode).toBe(true);
    expect(config.openRouterModel).toBe("openai/drafting-model");
  });
});
