import { extractChanges, getRelevantCategories } from "./change-extractor";
import type { Change, PromptPacket, TemplatePromptCatalog } from "./types";

/**
 * Builds the system + user prompts using the change-list approach.
 *
 * Instead of dumping the full PromptPacket as JSON, we:
 * 1. Extract a flat, numbered Change[] list from the packet
 * 2. Build a human-readable numbered list in the user prompt
 * 3. Include only the template catalog sections relevant to the change types present
 * 4. Ask the LLM to classify each change by number → templateId
 */

const RESPONSE_SCHEMA = '{"classifications": [{"change": 1, "templateId": "category.template_id"}]}';

function buildSystemPrompt(): string {
  return [
    "You are a transcript issue classifier for Babel Audio.",
    "You receive a numbered list of changes between two transcript versions.",
    "For each change, decide if it matches an issue template from the catalog.",
    "",
    "Rules:",
    "1. Only use template IDs from the provided catalog. Do not invent IDs.",
    "2. A change may match zero or one template. Skip changes that match nothing.",
    "3. Multiple changes may map to the same template — that is fine.",
    "4. For text changes, choose the most specific template that explains the edit.",
    "5. Do not return a broad generic template when a specific one already explains it.",
    "6. Generic punctuation templates are fallback-only — do not combine them with",
    "   dedicated tag/service-markup templates unless there is separate independent",
    "   punctuation evidence.",
    "7. For segmentation changes, use the relationship and severity information provided.",
    "8. For tag changes, examine tag additions/removals specifically.",
    "",
    "Output rules:",
    "- Return strict JSON only. No markdown. No prose outside JSON.",
    "- Use exactly this schema:",
    RESPONSE_SCHEMA,
    '- If no changes match any template, return: {"classifications": []}',
  ].join("\n");
}

function formatChangeList(changes: Change[]): string {
  if (changes.length === 0) {
    return "(no changes detected)";
  }

  return changes
    .map((c) => `${c.index}. [${c.type}] ${c.description}`)
    .join("\n");
}

function buildScopedCatalog(
  changes: Change[],
  fullCatalog: TemplatePromptCatalog
): string {
  const relevant = getRelevantCategories(changes);

  // Filter to only categories that have changes, preserving order
  const sections: string[] = [];

  for (const category of Object.keys(fullCatalog) as Array<keyof TemplatePromptCatalog>) {
    if (!relevant.has(category)) continue;

    const templates = fullCatalog[category];
    if (!templates || templates.length === 0) continue;

    const lines = templates.map((t) => `  - ${t.id}: ${t.description}`);
    sections.push(`${category}:\n${lines.join("\n")}`);
  }

  if (sections.length === 0) {
    return "(no relevant templates)";
  }

  return sections.join("\n\n");
}

function buildUserPrompt(
  changes: Change[],
  fullCatalog: TemplatePromptCatalog
): string {
  return [
    "Classify each change against the matching template from the catalog below.",
    "",
    "Changes:",
    formatChangeList(changes),
    "",
    "Template catalog:",
    buildScopedCatalog(changes, fullCatalog),
  ].join("\n");
}

export function buildPrompts(
  promptPacket: PromptPacket,
  templateCatalog: TemplatePromptCatalog
): {
  systemPrompt: string;
  userPrompt: string;
  preview: string;
} {
  const changes = extractChanges(promptPacket);
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(changes, templateCatalog);

  return {
    systemPrompt,
    userPrompt,
    preview: `SYSTEM:\n${systemPrompt}\n\nUSER:\n${userPrompt}`,
  };
}
