import { CATEGORIES } from "./rules";
import type { PromptPacket, TemplatePromptCatalog } from "./types";

export function buildPrompts(
  promptPacket: PromptPacket,
  templateCatalog: TemplatePromptCatalog
): {
  systemPrompt: string;
  userPrompt: string;
  preview: string;
} {
  const schema = {
    findings: ["word_accuracy.example_issue"]
  };

  const promptCatalog = CATEGORIES.map((category) => ({
    category,
    templates: templateCatalog[category]
  }));

  const systemPrompt = [
    "You are a QA issue classifier for Babel Audio.",
    "Select template IDs for issues that are clearly supported by the provided diffs.",
    "",
    "How to use the payload:",
    "- textDiffs are the primary source for Word Accuracy, Punctuation & Formatting, and Tags & Emphasis.",
    "- timingDiffs are focused timestamp changes for stable segments.",
    "- segmentationDiffs show unmatched segments and segment count changes.",
    "- Do not expect severity labels, scores, or pre-labeled text categories.",
    "",
    "Selection rules:",
    "1. Return only template IDs from the provided catalog.",
    "2. Do not invent IDs.",
    "3. Do not return duplicate IDs.",
    "4. findings may be an empty array.",
    "5. If the text diffs show a language-level issue, choose the matching text template yourself.",
    "6. Prefer the most specific template that fully explains the evidence.",
    "7. Do not return a broad generic template when a more specific template already explains the same local diff.",
    "8. Generic punctuation templates are fallback-only: do not combine them with dedicated tag or service-markup templates unless there is separate independent punctuation evidence elsewhere.",
    "",
    "Output rules:",
    "- Return strict JSON only. No markdown. No prose outside JSON.",
    "- Use exactly this schema:",
    JSON.stringify(schema)
  ].join("\n");

  const userPrompt = [
    "Review the focused diff packet and choose all matching issue templates.",
    "",
    "Focused diff packet:",
    JSON.stringify(promptPacket, null, 2),
    "",
    "Template catalog:",
    JSON.stringify(promptCatalog, null, 2)
  ].join("\n");

  return {
    systemPrompt,
    userPrompt,
    preview: `SYSTEM:\n${systemPrompt}\n\nUSER:\n${userPrompt}`
  };
}
