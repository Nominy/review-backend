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

const openRouterTestMode = booleanEnv("OPENROUTER_TEST_MODE", false);

export const config = {
  port: Number(process.env.PORT || 3001),
  openRouterTestMode,
  openRouterApiKey: openRouterTestMode ? optionalEnv("OPENROUTER_API_KEY", "") : requireEnv("OPENROUTER_API_KEY"),
  openRouterModel: optionalEnv("OPENROUTER_MODEL", "openai/gpt-oss-120b"),
  reviewPairLogPath: optionalEnv("REVIEW_PAIR_LOG_PATH", "logs/review-text-pairs.jsonl")
};
