import type { LoadedTemplateRegistry } from "./template-registry";
import type { ReviewClassification, TemplateSelectionResponse } from "./types";

type SendArgs = {
  apiKey: string;
  model: string;
  prompts: {
    systemPrompt: string;
    userPrompt: string;
  };
  registry: LoadedTemplateRegistry;
};

type OpenRouterMessage = {
  role: string;
  content: string;
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

export function parseModelJson(text: string): unknown {
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

function validateClassifications(
  payload: unknown,
  registry: LoadedTemplateRegistry
): TemplateSelectionResponse & { classifications: ReviewClassification[] } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Model output must be an object.");
  }

  const record = payload as Record<string, unknown>;
  const rawClassifications = record.classifications ?? record.findings;
  if (!Array.isArray(rawClassifications)) {
    throw new Error("Model output must contain a classifications (or findings) array.");
  }

  const findings: string[] = [];
  const seenFindings = new Set<string>();
  const classifications: ReviewClassification[] = [];
  const seenChanges = new Set<number>();

  for (const item of rawClassifications) {
    if (typeof item === "string") {
      const templateId = item.trim();
      if (!templateId || seenFindings.has(templateId) || !registry.templatesById.has(templateId)) {
        continue;
      }
      seenFindings.add(templateId);
      findings.push(templateId);
      continue;
    }

    if (!item || typeof item !== "object" || !("templateId" in item)) {
      continue;
    }

    const templateId = String((item as Record<string, unknown>).templateId || "").trim();
    const change = Number((item as Record<string, unknown>).change);
    if (!templateId || !registry.templatesById.has(templateId)) {
      continue;
    }

    if (!seenFindings.has(templateId)) {
      seenFindings.add(templateId);
      findings.push(templateId);
    }

    if (!Number.isInteger(change) || change <= 0 || seenChanges.has(change)) {
      continue;
    }

    seenChanges.add(change);
    classifications.push({ change, templateId });
  }

  classifications.sort((left, right) => left.change - right.change);
  return { findings, classifications };
}

function parseAndValidate(content: string, registry: LoadedTemplateRegistry) {
  const parsed = parseModelJson(content);
  const validated = validateClassifications(parsed, registry);
  return { parsed, validated };
}

export async function requestOpenRouter(
  apiKey: string,
  model: string,
  messages: OpenRouterMessage[],
  temperature = 0.2
): Promise<string> {
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "Babel Review Assistant"
    },
    body: JSON.stringify({
      model,
      temperature,
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

  return normalizeContent(
    ((json.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as
      | Record<string, unknown>
      | undefined)?.content
  );
}

export async function sendToOpenRouter(args: SendArgs): Promise<{
  findings: string[];
  classifications: ReviewClassification[];
  rawContent: string;
  model: string;
  latencyMs: number;
  receivedAt: string;
  repaired?: boolean;
}> {
  const startedAt = Date.now();
  const baseMessages: OpenRouterMessage[] = [
    { role: "system", content: args.prompts.systemPrompt },
    { role: "user", content: args.prompts.userPrompt }
  ];

  const firstContent = await requestOpenRouter(args.apiKey, args.model, baseMessages);

  try {
    const { validated } = parseAndValidate(firstContent, args.registry);
    return {
      findings: validated.findings,
      classifications: validated.classifications,
      rawContent: firstContent,
      model: args.model,
      latencyMs: Date.now() - startedAt,
      receivedAt: new Date().toISOString()
    };
  } catch {
    const repairInstruction = [
      "Return strict JSON only.",
      "Use exactly this schema: {\"classifications\": [{\"change\": 1, \"templateId\": \"category.template_id\"}]}.",
      "Each entry maps a change number to a valid template ID from the provided catalog.",
      "If no changes match, return: {\"classifications\": []}.",
      "Do not include any explanation or markdown."
    ].join("\n");

    const repairedContent = await requestOpenRouter(args.apiKey, args.model, [
      ...baseMessages,
      { role: "assistant", content: firstContent },
      { role: "user", content: repairInstruction }
    ]);
    const { validated } = parseAndValidate(repairedContent, args.registry);

    return {
      findings: validated.findings,
      classifications: validated.classifications,
      rawContent: repairedContent,
      model: args.model,
      latencyMs: Date.now() - startedAt,
      receivedAt: new Date().toISOString(),
      repaired: true
    };
  }
}
