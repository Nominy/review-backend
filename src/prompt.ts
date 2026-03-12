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
    "You are a transcript issue classifier for Babel Audio.",
    "Select template IDs for issues that are clearly supported by the provided diffs.",
    "",
    "How to use the payload:",
    "- localTextEvidence is the text-preserving local packet. Use it for Tags & Emphasis, Punctuation & Formatting, and local text-change context.",
    "- localTextEvidence.changedPairs are simple before/after row pairs intended for text-level debugging, not authoritative segmentation evidence.",
    "- babelDiff.segmentation is the official Babel source for split/merge/add/delete and other segmentation judgments.",
    "- babelDiff.segmentation.samples include exact reference/hypothesis member segments, timings, word ranges, and changed tokens for each structural mapping.",
    "- babelDiff.timestamp is the official Babel source for timestamp precision, segment matching, and shift severity.",
    "- babelDiff.wordAccuracy is useful for word-error evidence and per-speaker breakdowns, but Babel aligned text may omit or flatten tags.",
    "- Do not use babelDiff alone to judge Tags & Emphasis.",
    "- Do not expect severity labels, scores, or pre-labeled text categories.",
    "",
    "Selection rules:",
    "1. Return only template IDs from the provided catalog.",
    "2. Do not invent IDs.",
    "3. Do not return duplicate IDs.",
    "4. findings may be an empty array.",
    "5. If the text diffs show a language-level issue, choose the matching text template yourself.",
    "5a. For Segmentation and Timestamp Accuracy, use official babelDiff evidence when present.",
    "5aa. For split/merge/add/delete judgments, rely on babelDiff.segmentation.samples member segments and timings, not just summary counts.",
    "5b. For Tags & Emphasis, prefer localTextEvidence because Babel diff may strip tags from aligned text.",
    "5c. For Word Accuracy, use babelDiff.wordAccuracy plus localTextEvidence.changedPairs when helpful.",
    "5d. Do not infer segmentation problems from local row pairing alone.",
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
