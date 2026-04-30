import { isObject, toFiniteNumber } from "./http";

export type OpenRouterMessage = {
  role: string;
  content: string;
};

export type OpenRouterReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type OpenRouterProviderSort = "price" | "throughput" | "latency";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

let cachedModelIds: Set<string> | null = null;
let cachedModelIdsAt = 0;
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

async function requestOpenRouterChatCore(args: {
  apiKey: string;
  model: string;
  messages: OpenRouterMessage[];
  temperature?: number;
  reasoningEffort?: OpenRouterReasoningEffort;
  providerSort?: OpenRouterProviderSort;
  provider?: {
    sort?: OpenRouterProviderSort;
    allow_fallbacks?: boolean;
    require_parameters?: boolean;
  };
  title: string;
}): Promise<string> {
  const provider = args.provider ?? {
    sort: args.providerSort ?? "latency",
    allow_fallbacks: true,
    require_parameters: true
  };

  const response = await fetch(OPENROUTER_URL, {
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

  return normalizeContent(
    ((json.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as
      | Record<string, unknown>
      | undefined)?.content
  );
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
        ...(plan.useProvider ? { provider } : {}),
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
  const now = Date.now();
  if (cachedModelIds && now - cachedModelIdsAt < MODEL_CACHE_TTL_MS) {
    return cachedModelIds;
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

  for (const item of data) {
    if (isObject(item) && typeof item.id === "string" && item.id.trim()) {
      modelIds.add(item.id.trim());
    }
  }

  if (!modelIds.size) {
    throw new Error("OpenRouter returned no model ids.");
  }

  cachedModelIds = modelIds;
  cachedModelIdsAt = now;
  return modelIds;
}

export async function assertOpenRouterModelExists(model: string): Promise<void> {
  const normalizedModel = model.trim();
  if (!normalizedModel) {
    throw new Error("model is required.");
  }

  const modelIds = await fetchOpenRouterModelIds();
  if (!modelIds.has(normalizedModel)) {
    throw new Error(`OpenRouter model does not exist: ${normalizedModel}`);
  }
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
