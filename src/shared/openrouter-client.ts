import { isObject, toFiniteNumber } from "./http";

export type OpenRouterTextContentPart = {
  type: "text";
  text: string;
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

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const DEFAULT_OPENROUTER_CHAT_TIMEOUT_MS = 60_000;

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
      stream: false,
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

  const json = parseMaybeJson(text) as Record<string, unknown> | null;
  if (!json) {
    throw new Error("OpenRouter returned non-JSON payload.");
  }

  const choice = (json.choices as Array<Record<string, unknown>> | undefined)?.[0];
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
