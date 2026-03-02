import { loadDefaultEnvFiles } from "./load-env";

loadDefaultEnvFiles();

function requireEnv(name: string): string {
  const value = (process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  const value = (process.env[name] || "").trim();
  return value || fallback;
}

function booleanEnv(name: string, fallback = false): boolean {
  const value = (process.env[name] || "").trim().toLowerCase();
  if (!value) return fallback;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function parseCorsOriginEnv(name: string): true | string[] {
  const raw = (process.env[name] || "").trim();
  if (!raw || raw === "*") return true;

  const list = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return list.length ? list : true;
}

const openRouterTestMode = booleanEnv("OPENROUTER_TEST_MODE", false);
const port = Number(process.env.PORT || 3001);
const host = optionalEnv("HOST", "127.0.0.1");
const defaultPublicBaseUrl = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;

export const config = {
  host,
  port,
  openRouterTestMode,
  openRouterApiKey: openRouterTestMode ? optionalEnv("OPENROUTER_API_KEY", "") : requireEnv("OPENROUTER_API_KEY"),
  openRouterModel: optionalEnv("OPENROUTER_MODEL", "openai/gpt-oss-120b"),
  reviewPairLogPath: optionalEnv("REVIEW_PAIR_LOG_PATH", "logs/review-text-pairs.jsonl"),
  analyticsLogPath: optionalEnv("ANALYTICS_LOG_PATH", "logs/review-analytics.jsonl"),
  publicBaseUrl: optionalEnv("PUBLIC_BASE_URL", defaultPublicBaseUrl),
  corsOrigin: parseCorsOriginEnv("CORS_ALLOWED_ORIGINS")
};
