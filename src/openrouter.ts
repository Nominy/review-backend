import { CATEGORIES } from "./rules";
import type { CategoryName } from "./types";

type SendArgs = {
  apiKey: string;
  model: string;
  prompts: {
    systemPrompt: string;
    userPrompt: string;
  };
};

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function parseMaybeJson(text: string): unknown | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function normalizeContent(content: unknown): string {
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

function parseModelJson(text: string): unknown {
  const direct = parseMaybeJson(text);
  if (direct) return direct;

  const fenced = /```json\s*([\s\S]*?)```/i.exec(text || "");
  if (fenced) {
    const parsed = parseMaybeJson(fenced[1]);
    if (parsed) return parsed;
  }

  const start = (text || "").indexOf("{");
  const end = (text || "").lastIndexOf("}");
  if (start >= 0 && end > start) {
    const parsed = parseMaybeJson(text.slice(start, end + 1));
    if (parsed) return parsed;
  }

  throw new Error("Model response is not valid JSON.");
}

function normalizeCategoryKey(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function categoryAliasMap(): Map<string, CategoryName> {
  const map = new Map<string, CategoryName>();
  const aliases: Record<CategoryName, string[]> = {
    "Word Accuracy": ["word accuracy", "wordaccuracy", "accuracy of transcribed words", "wording accuracy"],
    "Timestamp Accuracy": ["timestamp accuracy", "timing accuracy", "time accuracy", "timestamps accuracy"],
    "Punctuation & Formatting": [
      "punctuation & formatting",
      "punctuation and formatting",
      "punctuation formatting",
      "formatting and punctuation"
    ],
    "Tags & Emphasis": ["tags & emphasis", "tags and emphasis", "tag emphasis", "emphasis and tags"],
    Segmentation: ["segmentation", "segmenting", "segment breaks", "segment quality"]
  };

  for (const category of CATEGORIES) {
    map.set(normalizeCategoryKey(category), category);
    for (const alias of aliases[category]) {
      map.set(normalizeCategoryKey(alias), category);
    }
  }
  return map;
}

const aliasMap = categoryAliasMap();

function parseScore(item: Record<string, unknown>): number {
  const raw = item.score ?? item.grade ?? item.rating ?? item.value;
  const score = Number.parseInt(String(raw), 10);
  if (Number.isFinite(score)) return score;
  return Number.NaN;
}

function parseNote(item: Record<string, unknown>): string {
  const note =
    item.note ??
    item.advice ??
    item.comment ??
    item.text ??
    item.feedback ??
    item.description ??
    "";
  return typeof note === "string" ? note.trim() : "";
}

function extractItems(payload: unknown): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];

  const pushFromArray = (arr: unknown[]) => {
    for (const raw of arr) {
      if (!raw || typeof raw !== "object") continue;
      const obj = raw as Record<string, unknown>;
      if (typeof obj.category === "string") {
        items.push(obj);
        continue;
      }
      const keys = Object.keys(obj);
      if (keys.length === 1 && obj[keys[0]] && typeof obj[keys[0]] === "object") {
        const nested = obj[keys[0]] as Record<string, unknown>;
        items.push({ category: keys[0], ...nested });
      }
    }
  };

  if (!payload || typeof payload !== "object") return items;
  const root = payload as Record<string, unknown>;

  if (Array.isArray(root.feedback)) {
    pushFromArray(root.feedback);
  } else if (root.feedback && typeof root.feedback === "object") {
    for (const [k, v] of Object.entries(root.feedback as Record<string, unknown>)) {
      if (v && typeof v === "object") {
        items.push({ category: k, ...(v as Record<string, unknown>) });
      }
    }
  }

  if (Array.isArray(root.categories)) pushFromArray(root.categories);
  if (Array.isArray(root.results)) pushFromArray(root.results);
  if (!items.length && Array.isArray(payload)) pushFromArray(payload);
  return items;
}

function validateFeedback(payload: unknown): { feedback: Array<{ category: CategoryName; score: number; note: string }> } {
  if (!payload || typeof payload !== "object") {
    throw new Error("Model output must be an object.");
  }

  const items = extractItems(payload);
  if (!items.length) {
    throw new Error("Missing feedback categories in model output.");
  }

  const byCategory = new Map<CategoryName, Record<string, unknown>>();
  for (const item of items) {
    const canonical = aliasMap.get(normalizeCategoryKey(item.category));
    if (!canonical || byCategory.has(canonical)) continue;
    byCategory.set(canonical, item);
  }

  const normalized: Array<{ category: CategoryName; score: number; note: string }> = [];
  for (const category of CATEGORIES) {
    const item = byCategory.get(category);
    if (!item) throw new Error(`Missing category: ${category}`);

    const score = parseScore(item);
    if (!Number.isFinite(score) || score < 1 || score > 3) {
      throw new Error(`Invalid score for ${category}`);
    }

    const note = parseNote(item);
    if (!note) throw new Error(`Empty note for ${category}`);

    normalized.push({
      category,
      score,
      note: note.slice(0, 500)
    });
  }

  return { feedback: normalized };
}

function parseAndValidate(content: string) {
  const parsed = parseModelJson(content);
  const validated = validateFeedback(parsed);
  return { parsed, validated };
}

async function requestOnce(args: SendArgs, messages: Array<{ role: string; content: string }>): Promise<string> {
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "Babel Review Assistant"
    },
    body: JSON.stringify({
      model: args.model,
      temperature: 0.2,
      stream: false,
      response_format: { type: "json_object" },
      provider: {
        sort: "latency",
        allow_fallbacks: true,
        require_parameters: true
      },
      messages
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

  const content = normalizeContent(
    ((json.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as Record<string, unknown> | undefined)
      ?.content
  );
  return content;
}

export async function sendToOpenRouter(args: SendArgs): Promise<{
  feedback: Array<{ category: CategoryName; score: number; note: string }>;
  rawContent: string;
  model: string;
  latencyMs: number;
  receivedAt: string;
  repaired?: boolean;
}> {
  const startedAt = Date.now();
  const baseMessages = [
    { role: "system", content: args.prompts.systemPrompt },
    { role: "user", content: args.prompts.userPrompt }
  ];

  try {
    const content = await requestOnce(args, baseMessages);
    const { validated } = parseAndValidate(content);
    return {
      feedback: validated.feedback,
      rawContent: content,
      model: args.model,
      latencyMs: Date.now() - startedAt,
      receivedAt: new Date().toISOString()
    };
  } catch {
    const firstContent = await requestOnce(args, baseMessages);
    const repairInstruction = [
      "Исправь свой предыдущий ответ и верни СТРОГО JSON (без Markdown/текста).",
      "Схема: { feedback: [ {category, score, note}, ... ] }.",
      `feedback должен содержать РОВНО 5 элементов и РОВНО эти категории (точные названия): ${JSON.stringify(CATEGORIES)}`,
      "score: целое 1..3 (1 лучше, 3 хуже).",
      "note: по-русски, <= 500 символов, 1-2 предложения, конкретное действие + доброжелательная фраза.",
      "Нельзя пропускать категории и нельзя добавлять лишние категории."
    ].join("\n");

    const repairedContent = await requestOnce(args, [
      ...baseMessages,
      { role: "assistant", content: firstContent },
      { role: "user", content: repairInstruction }
    ]);
    const { validated } = parseAndValidate(repairedContent);

    return {
      feedback: validated.feedback,
      rawContent: repairedContent,
      model: args.model,
      latencyMs: Date.now() - startedAt,
      receivedAt: new Date().toISOString(),
      repaired: true
    };
  }
}

