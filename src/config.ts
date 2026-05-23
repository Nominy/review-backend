import {
  booleanEnv,
  loadDefaultEnvFiles,
  optionalEnv,
  parseCorsOriginEnv,
  requireEnv
} from "./shared/env";

loadDefaultEnvFiles();

const openRouterTestMode = booleanEnv("OPENROUTER_TEST_MODE", false);
const port = Number(process.env.PORT || 3001);
const host = optionalEnv("HOST", "127.0.0.1");
const DEFAULT_MAX_REQUEST_BODY_MB = 512;
const defaultPublicBaseUrl = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = (process.env[name] || "").trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export const config = {
  host,
  port,
  maxRequestBodySize: positiveIntegerEnv("DRAFT_MAX_REQUEST_BODY_MB", DEFAULT_MAX_REQUEST_BODY_MB) * 1024 * 1024,
  openRouterTestMode,
  openRouterApiKey: openRouterTestMode ? optionalEnv("OPENROUTER_API_KEY", "") : requireEnv("OPENROUTER_API_KEY"),
  openRouterModel: optionalEnv("OPENROUTER_MODEL", "google/gemini-3-flash-preview"),
  analyticsLogPath: optionalEnv("ANALYTICS_LOG_PATH", "logs/pm2/review-backend.out.log"),
  reviewSessionsDir: optionalEnv("REVIEW_SESSIONS_DIR", "data/review-sessions"),
  pendingTemplateProposalPath: optionalEnv(
    "PENDING_TEMPLATE_PROPOSAL_PATH",
    "data/prompt-lab/pending-template-proposals.json"
  ),
  publicBaseUrl: optionalEnv("PUBLIC_BASE_URL", defaultPublicBaseUrl),
  corsOrigin: parseCorsOriginEnv("CORS_ALLOWED_ORIGINS"),
  templatesLabUsername: optionalEnv("TEMPLATES_LAB_USERNAME", ""),
  templatesLabPassword: optionalEnv("TEMPLATES_LAB_PASSWORD", ""),
  templatesLabEnabled:
    !!optionalEnv("TEMPLATES_LAB_USERNAME", "") && !!optionalEnv("TEMPLATES_LAB_PASSWORD", "")
};
