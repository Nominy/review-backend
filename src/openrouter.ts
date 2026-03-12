import type { LoadedTemplateRegistry } from "./template-registry";
import type { TemplateSelectionResponse } from "./types";

type SendArgs = {
  apiKey: string;
  model: string;
  prompts: {
    systemPrompt: string;
    userPrompt: string;
  };
  registry: LoadedTemplateRegistry;
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

function validateClassifications(
  payload: unknown,
  registry: LoadedTemplateRegistry
): TemplateSelectionResponse {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Model output must be an object.");
  }

  const record = payload as Record<string, unknown>;

  // Accept both new schema {"classifications": [...]} and legacy {"findings": [...]}
  const rawClassifications = record.classifications ?? record.findings;
  if (!Array.isArray(rawClassifications)) {
    throw new Error("Model output must contain a classifications (or findings) array.");
  }

  const seen = new Set<string>();
  const findings: string[] = [];

  for (const item of rawClassifications) {
    let templateId: string;

    if (typeof item === "string") {
      // Legacy format: plain string template ID
      templateId = item.trim();
    } else if (item && typeof item === "object" && "templateId" in item) {
      // New format: {"change": N, "templateId": "..."}
      templateId = String((item as Record<string, unknown>).templateId).trim();
    } else {
      continue; // skip malformed entries instead of throwing
    }

    if (!templateId || seen.has(templateId)) {
      continue;
    }
    if (!registry.templatesById.has(templateId)) {
      continue; // skip unknown IDs silently — don't throw on hallucinated IDs
    }

    seen.add(templateId);
    findings.push(templateId);
  }

  return { findings };
}

function parseAndValidate(content: string, registry: LoadedTemplateRegistry) {
  const parsed = parseModelJson(content);
  const validated = validateClassifications(parsed, registry);
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

  return normalizeContent(
    ((json.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as
      | Record<string, unknown>
      | undefined)?.content
  );
}

export async function sendToOpenRouter(args: SendArgs): Promise<{
  findings: string[];
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

  const firstContent = await requestOnce(args, baseMessages);

  try {
    const { validated } = parseAndValidate(firstContent, args.registry);
    return {
      findings: validated.findings,
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

    const repairedContent = await requestOnce(args, [
      ...baseMessages,
      { role: "assistant", content: firstContent },
      { role: "user", content: repairInstruction }
    ]);
    const { validated } = parseAndValidate(repairedContent, args.registry);

    return {
      findings: validated.findings,
      rawContent: repairedContent,
      model: args.model,
      latencyMs: Date.now() - startedAt,
      receivedAt: new Date().toISOString(),
      repaired: true
    };
  }
}
