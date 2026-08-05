import { isObject, toFiniteNumber } from "./http";

export type OpenRouterCacheControl = {
  type: "ephemeral";
  ttl?: "1h";
};

export type OpenRouterTextContentPart = {
  type: "text";
  text: string;
  cache_control?: OpenRouterCacheControl;
};

export type OpenRouterAudioContentPart = {
  type: "input_audio";
  input_audio: {
    data: string;
    format: string;
  };
};

export type OpenRouterContentPart = OpenRouterTextContentPart | OpenRouterAudioContentPart;

export type OpenRouterMessage = {
  role: string;
  content: string | OpenRouterContentPart[];
};

export type OpenRouterReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type OpenRouterProviderSort = "price" | "throughput" | "latency";
export type OpenRouterServiceTier = "default" | "flex" | "priority";

export function buildCachedOpenRouterTextContent(text: string): OpenRouterTextContentPart {
  return {
    type: "text",
    text,
    cache_control: { type: "ephemeral" }
  };
}

export function shouldUseGeminiPromptCaching(model: string): boolean {
  return model.trim().toLowerCase().startsWith("google/gemini");
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const DEFAULT_OPENROUTER_CHAT_TIMEOUT_MS = 180_000;

let cachedModelIds: Set<string> | null = null;
let cachedModelIdsAt = 0;
let cachedModelCapabilities: Map<string, Set<string>> | null = null;
let cachedModelCapabilitiesAt = 0;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

export type CreditsSnapshot = {
  total: number | null;
  used: number | null;
  remaining: number | null;
  line: string;
  error?: string;
};

function errorLooksProviderRoutingFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("no endpoints found that can handle the requested parameters")
    || normalized.includes("provider routing")
    || normalized.includes("unsupported parameter")
    || normalized.includes("requires")
  );
}

function parsePositiveIntegerEnv(name: string, defaultValue: number): number {
  const raw = (process.env[name] || "").trim();
  if (!raw) {
    return defaultValue;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : defaultValue;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isTransientTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("returned non-JSON payload") ||
    error.message.includes("returned empty assistant content") ||
    error.message.includes("request timed out") ||
    /OpenRouter HTTP (429|5\d\d):/.test(error.message)
  );
}

export function parseSseChatResponse(
  text: string
): { content: string; finishReason: string; error: string | null; chunkCount: number } | null {
  if (!/^\s*(?::|data:)/.test(text)) {
    return null;
  }

  let content = "";
  let finishReason = "";
  let error: string | null = null;
  let chunkCount = 0;

  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const chunk = parseMaybeJson(payload) as Record<string, unknown> | null;
    if (!chunk) continue;
    chunkCount += 1;

    const upstreamError = formatOpenRouterErrorPayload(chunk);
    if (upstreamError && !error) {
      error = upstreamError;
    }

    const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
    if (!choice) continue;

    const delta = choice.delta as Record<string, unknown> | undefined;
    if (delta) {
      content += normalizeContent(delta.content);
      if ("text" in delta) content += normalizeContent(delta.text);
    }

    const message = choice.message as Record<string, unknown> | undefined;
    if (message) content += normalizeContent(message.content);

    if (typeof choice.finish_reason === "string" && choice.finish_reason) {
      finishReason = choice.finish_reason;
    } else if (typeof choice.native_finish_reason === "string" && choice.native_finish_reason) {
      finishReason = choice.native_finish_reason;
    }
  }

  return { content, finishReason, error, chunkCount };
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

const TRANSIENT_TRANSPORT_ATTEMPTS = 3;

function formatOpenRouterErrorPayload(json: Record<string, unknown>): string | null {
  if (!isObject(json.error)) {
    return null;
  }

  const message = typeof json.error.message === "string" ? json.error.message.trim() : "";
  const code = json.error.code;
  const codeText = typeof code === "string" || typeof code === "number" ? String(code).trim() : "";

  if (!message && !codeText) {
    return "OpenRouter returned an error payload.";
  }

  return `OpenRouter error${codeText ? ` ${codeText}` : ""}${message ? `: ${message}` : ""}`;
}

async function fetchOpenRouterChat(init: RequestInit): Promise<Response> {
  const timeoutMs = parsePositiveIntegerEnv("OPENROUTER_CHAT_TIMEOUT_MS", DEFAULT_OPENROUTER_CHAT_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(OPENROUTER_URL, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      throw new Error(`OpenRouter request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestOpenRouterChatCore(args: {
  apiKey: string;
  model: string;
  messages: OpenRouterMessage[];
  temperature?: number;
  reasoningEffort?: OpenRouterReasoningEffort;
  providerSort?: OpenRouterProviderSort;
  serviceTier?: OpenRouterServiceTier;
  provider?: {
    sort?: OpenRouterProviderSort;
    allow_fallbacks?: boolean;
    require_parameters?: boolean;
  } | null;
  title: string;
}): Promise<string> {
  const provider = args.provider === null
    ? null
    : (args.provider ?? {
    sort: args.providerSort ?? "latency",
    allow_fallbacks: true,
    require_parameters: true
    });

  let lastError: unknown;
  for (let attempt = 1; attempt <= TRANSIENT_TRANSPORT_ATTEMPTS; attempt += 1) {
    try {
      return await performOpenRouterChatAttempt(args, provider);
    } catch (error) {
      lastError = error;
      if (attempt >= TRANSIENT_TRANSPORT_ATTEMPTS || !isTransientTransportError(error)) {
        throw error;
      }
      await sleep(500 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function performOpenRouterChatAttempt(
  args: Parameters<typeof requestOpenRouterChatCore>[0],
  provider: { sort?: OpenRouterProviderSort; allow_fallbacks?: boolean; require_parameters?: boolean } | null
): Promise<string> {
  const response = await fetchOpenRouterChat({
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
      "X-Title": args.title
    },
    body: JSON.stringify({
      model: args.model,
      temperature: args.temperature ?? 0.2,
      stream: true,
      ...(args.reasoningEffort ? { reasoning: {
          effort: args.reasoningEffort,
          exclude: true
        } } : {}),
      ...(args.serviceTier && args.serviceTier !== "default" ? { service_tier: args.serviceTier } : {}),
      ...(provider ? { provider } : {}),
      messages: args.messages
    })
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenRouter HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  const sse = parseSseChatResponse(text);
  const json = sse ? null : (parseMaybeJson(text) as Record<string, unknown> | null);
  if (!sse && !json) {
    throw new Error(
      `OpenRouter returned non-JSON payload (HTTP ${response.status}): ${text.trim().slice(0, 200) || "<empty body>"}`
    );
  }

  if (sse) {
    if (sse.error) {
      throw new Error(sse.error);
    }
    if (!sse.content.trim()) {
      const details = [
        sse.finishReason ? `finish=${sse.finishReason}` : "",
        `chunks=${sse.chunkCount}`,
        text.trim() ? `body=${text.trim().slice(0, 160)}` : "body=<empty>"
      ]
        .filter(Boolean)
        .join(" ");
      throw new Error(`OpenRouter returned empty assistant content (${details}).`);
    }
    return sse.content;
  }

  const upstreamError = formatOpenRouterErrorPayload(json!);
  if (upstreamError) {
    throw new Error(upstreamError);
  }

  const choice = (json!.choices as Array<Record<string, unknown>> | undefined)?.[0];
  const content = normalizeContent((choice?.message as Record<string, unknown> | undefined)?.content);
  if (!content.trim()) {
    const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : "";
    const nativeFinishReason = typeof choice?.native_finish_reason === "string" ? choice.native_finish_reason : "";
    const reasonText = [finishReason, nativeFinishReason].filter(Boolean).join("/");
    throw new Error(
      `OpenRouter returned empty assistant content${reasonText ? ` (${reasonText})` : ""}.`
    );
  }

  return content;
}

export function parseMaybeJson(text: string): unknown | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function normalizeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("");
  }
  return typeof content === "undefined" ? "" : JSON.stringify(content);
}

export async function requestOpenRouterChat(args: {
  apiKey: string;
  model: string;
  messages: OpenRouterMessage[];
  temperature?: number;
  reasoningEffort?: OpenRouterReasoningEffort;
  providerSort?: OpenRouterProviderSort;
  serviceTier?: OpenRouterServiceTier;
  title: string;
}): Promise<string> {
  if (!args.reasoningEffort) {
    return requestOpenRouterChatCore({
      ...args,
      provider: {
        sort: args.providerSort ?? "latency",
        allow_fallbacks: true,
        require_parameters: true
      }
    });
  }

  const fallbackPlan = [
    { useReasoning: true, useProvider: true },
    { useReasoning: false, useProvider: true },
    { useReasoning: true, useProvider: false },
    { useReasoning: false, useProvider: false }
  ];
  const provider = {
    sort: args.providerSort ?? "latency",
    allow_fallbacks: true,
    require_parameters: true
  };

  for (let i = 0; i < fallbackPlan.length; i += 1) {
    const plan = fallbackPlan[i];
    try {
      return await requestOpenRouterChatCore({
        apiKey: args.apiKey,
        model: args.model,
        messages: args.messages,
        temperature: args.temperature,
        reasoningEffort: plan.useReasoning ? args.reasoningEffort : undefined,
        serviceTier: args.serviceTier,
        provider: plan.useProvider ? provider : null,
        title: args.title
      });
    } catch (error) {
      if (
        i < fallbackPlan.length - 1 &&
        error instanceof Error &&
        error.message.includes("OpenRouter HTTP 404:") &&
        errorLooksProviderRoutingFailure(error.message)
      ) {
        continue;
      }

      throw error;
    }
  }

  throw new Error("OpenRouter request failed after provider/reasoning fallbacks.");
}

export async function fetchOpenRouterModelIds(): Promise<Set<string>> {
  return (await fetchOpenRouterModelCatalog()).modelIds;
}

export async function assertOpenRouterModelExists(model: string): Promise<void> {
  const normalizedModel = model.trim();
  if (!normalizedModel) {
    throw new Error("model is required.");
  }

  const catalog = await fetchOpenRouterModelCatalog();
  if (!catalog.modelIds.has(normalizedModel)) {
    throw new Error(`OpenRouter model does not exist: ${normalizedModel}`);
  }
}

export async function assertOpenRouterModelSupportsAudio(model: string): Promise<void> {
  const normalizedModel = model.trim();
  if (!normalizedModel) {
    throw new Error("model is required.");
  }

  let catalog = await fetchOpenRouterModelCatalog();
  if (!catalog.modelIds.has(normalizedModel)) {
    // Tests and long-running processes may carry a stale cache while users type a new model id.
    catalog = await fetchOpenRouterModelCatalog({ forceRefresh: true });
  }

  if (!catalog.modelIds.has(normalizedModel)) {
    throw new Error(`OpenRouter model does not exist: ${normalizedModel}`);
  }

  const inputModalities = catalog.inputModalitiesByModel.get(normalizedModel) || new Set<string>();
  if (!inputModalities.has("audio")) {
    throw new Error(`OpenRouter model does not support audio input: ${normalizedModel}`);
  }
}

async function fetchOpenRouterModelCatalog(options: { forceRefresh?: boolean } = {}): Promise<{
  modelIds: Set<string>;
  inputModalitiesByModel: Map<string, Set<string>>;
}> {
  const now = Date.now();
  if (
    !options.forceRefresh &&
    cachedModelIds &&
    cachedModelCapabilities &&
    now - cachedModelIdsAt < MODEL_CACHE_TTL_MS &&
    now - cachedModelCapabilitiesAt < MODEL_CACHE_TTL_MS
  ) {
    return {
      modelIds: cachedModelIds,
      inputModalitiesByModel: cachedModelCapabilities
    };
  }

  const response = await fetch(OPENROUTER_MODELS_URL, {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenRouter models HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  const json = parseMaybeJson(text);
  const data = isObject(json) && Array.isArray(json.data) ? json.data : [];
  const modelIds = new Set<string>();
  const inputModalitiesByModel = new Map<string, Set<string>>();

  for (const item of data) {
    if (!isObject(item) || typeof item.id !== "string" || !item.id.trim()) {
      continue;
    }
    const id = item.id.trim();
    modelIds.add(id);
    const architecture = isObject(item.architecture) ? item.architecture : {};
    const rawInputModalities = Array.isArray(architecture.input_modalities)
      ? architecture.input_modalities
      : Array.isArray(item.input_modalities)
        ? item.input_modalities
        : [];
    inputModalitiesByModel.set(
      id,
      new Set(
        rawInputModalities
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean)
      )
    );
  }

  if (!modelIds.size) {
    throw new Error("OpenRouter returned no model ids.");
  }

  cachedModelIds = modelIds;
  cachedModelIdsAt = now;
  cachedModelCapabilities = inputModalitiesByModel;
  cachedModelCapabilitiesAt = now;
  return {
    modelIds,
    inputModalitiesByModel
  };
}

function fmtCredits(value: number | null): string {
  return value === null ? "?" : value.toFixed(4);
}

function funnyCreditsLine(remaining: number | null): string {
  if (remaining === null) return "Wallet status: classified paperwork.";
  if (remaining <= 0) return "Wallet status: ramen mode engaged.";
  if (remaining < 1) return "Wallet status: fumes, but still rolling.";
  if (remaining < 10) return "Wallet status: comfy, no panic.";
  return "Wallet status: credits are chilling.";
}

export async function fetchOpenRouterCredits(apiKey: string): Promise<CreditsSnapshot> {
  if (!apiKey.trim()) {
    return {
      total: null,
      used: null,
      remaining: null,
      line: "Wallet status: test mode, imaginary money."
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(OPENROUTER_CREDITS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`OpenRouter HTTP ${response.status}`);
    }

    const json = (await response.json()) as unknown;
    const data = isObject(json) && isObject(json.data) ? json.data : {};

    const total = toFiniteNumber(
      data.total_credits ?? data.totalCredits ?? data.total ?? data.credits
    );
    const used = toFiniteNumber(data.total_usage ?? data.totalUsage ?? data.used_credits ?? data.used);
    const remaining = toFiniteNumber(
      data.remaining_credits ??
        data.remainingCredits ??
        (total !== null && used !== null ? total - used : Number.NaN)
    );

    return {
      total,
      used,
      remaining,
      line: `OpenRouter credits: total=${fmtCredits(total)}, remaining=${fmtCredits(
        remaining
      )}. ${funnyCreditsLine(remaining)}`
    };
  } catch (error) {
    return {
      total: null,
      used: null,
      remaining: null,
      line: "OpenRouter credits: unavailable. Wallet taking a coffee break.",
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}
