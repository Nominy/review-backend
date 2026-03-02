import { CATEGORIES } from "./rules";
import type { PromptPacket } from "./types";

export function buildPrompts(promptPacket: PromptPacket): {
  systemPrompt: string;
  userPrompt: string;
  preview: string;
} {
  const schema = {
    feedback: CATEGORIES.map((category) => ({
      category,
      score: 1,
      note: "..."
    }))
  };

  const promptInput = {
    editFootprint: promptPacket.editFootprint,
    ownershipSummary: promptPacket.ownershipSummary,
    scoreCaps: promptPacket.scoreCaps,
    categoryEvidence: promptPacket.categoryEvidence
  };

  const systemPrompt = [
    "You are an L2 QA reviewer for Babel Audio.",
    "ORIGINAL is the L1 transcript before QA. CURRENT is the L2 transcript after QA.",
    "Your job is to explain what L1 should improve, based only on the observed QA corrections.",
    "",
    "Critical attribution rules:",
    "1. Every concrete correction belongs to exactly one primary category.",
    "2. Do not double count side effects in multiple categories.",
    "3. Segmentation owns split/combine/add/delete events.",
    "4. Timestamp Accuracy applies only to stable 1:1 segment boundary adjustments.",
    "5. Number rendering with service tags like {SKAZ: ...} or {ISKAZ: ...} belongs to Tags & Emphasis, not Word Accuracy.",
    "6. If punctuation moved because a word was added or removed, that still belongs to Word Accuracy, not Punctuation & Formatting.",
    "",
    "Scoring rules:",
    "- Use score caps from the user payload as hard upper bounds.",
    "- 1 = isolated or no material issue.",
    "- 2 = repeated issue.",
    "- 3 = clearly systemic issue.",
    "- If a category has no material evidence, keep score at 1.",
    "",
    "Output rules:",
    "- Return strict JSON only. No markdown. No prose outside JSON.",
    "- Use exactly this schema:",
    JSON.stringify(schema),
    `- feedback must contain exactly ${CATEGORIES.length} items with these exact categories: ${JSON.stringify(CATEGORIES)}`,
    "- note must be in Russian.",
    "- note must be concise, practical, and must mention only the primary owned issue for that category.",
    "- For score 1, keep the note calm and brief. For score 2 or 3, be direct and corrective, without generic praise."
  ].join("\n");

  const userPrompt = [
    "Review the category evidence below and generate feedback.",
    "",
    "Internal checklist before scoring:",
    "- Is there actual owned evidence for this category?",
    "- Is it isolated, repeated, or systemic?",
    "- Could this be a side effect owned by another category? If yes, do not count it here.",
    "",
    "Prompt packet:",
    JSON.stringify(promptInput, null, 2)
  ].join("\n");

  return {
    systemPrompt,
    userPrompt,
    preview: `SYSTEM:\n${systemPrompt}\n\nUSER:\n${userPrompt}`
  };
}
