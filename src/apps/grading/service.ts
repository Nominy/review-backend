import { config } from '../../config';
import { effectivePrompt } from "../../shared/prompt-settings";
import { requestOpenRouterChat } from '../../shared/openrouter-client';
import { computeReviewMetrics } from "./metrics";
import { buildPrompts } from "./prompt";
import { CATEGORIES } from "./rules";
import type { CategoryName, NormalizedState, PromptPacket } from "./types";
import { composeReviewSystemPrompt } from "../../shared/guidelines";

export const GRADING_VERSION = 'guidelines-2026-09-v4';
export type GradingInput = { reviewActionId: string; original: NormalizedState; current: NormalizedState };
export type Grade = { category: CategoryName; score: 1 | 2 | 3; note: string };
const evidenceKeys = ['wordAccuracy', 'timestampAccuracy', 'punctuationFormatting', 'tagsEmphasis', 'segmentation'] as const;

/** Validate every category before returning any grades; never invent missing model scores. */
export function validateGrades(raw: string, packet: PromptPacket): Grade[] {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed?.feedback) || parsed.feedback.length !== CATEGORIES.length) {
    throw new Error('The grader must return all five categories.');
  }
  const seen = new Set<string>();
  for (const item of parsed.feedback) {
    if (!item || !CATEGORIES.includes(item.category) || seen.has(item.category)
      || !Number.isInteger(item.score) || item.score < 1 || item.score > 3
      || typeof item.note !== 'string' || !item.note.trim() || item.note.length > 500) {
      throw new Error('The grader returned an invalid category, score, or explanation.');
    }
    seen.add(item.category);
    if (item.score > packet.scoreCaps[item.category as CategoryName]) {
      throw new Error(`The grade for ${item.category} exceeds its evidence-based score cap.`);
    }
  }
  return CATEGORIES.map(category => {
    const item = parsed.feedback.find((item: Grade) => item.category === category);
    return { category, score: item.score, note: item.note.trim() };
  });
}

type ModelCall = (prompts: { systemPrompt: string; userPrompt: string }) => Promise<string>;
export async function generateGrades(input: GradingInput, callModel?: ModelCall, systemPrompt?: string, apiKey = '') {
  const computed = computeReviewMetrics(input.original, input.current, input.reviewActionId);
  const prompts = buildPrompts(computed.promptPacket);
  prompts.systemPrompt = composeReviewSystemPrompt(systemPrompt ?? effectivePrompt('grader', prompts.systemPrompt));
  const model = config.openRouterModel;
  const send = callModel ?? (async (prompts) => {
    if (!apiKey) throw new Error('Grading backend requires an OpenRouter API key.');
    return requestOpenRouterChat({ apiKey, model, title: 'Babel Review Grader', temperature: 0,
      messages: [{ role: 'system', content: prompts.systemPrompt }, { role: 'user', content: prompts.userPrompt }] });
  });
  let grades: Grade[];
  let repaired = false;
  const startedAt = Date.now();
  const first = await send(prompts);
  try { grades = validateGrades(first, computed.promptPacket); }
  catch (error) {
    repaired = true;
    const repair = await send({ ...prompts, userPrompt: `${prompts.userPrompt}\n\nПредыдущий ответ не прошёл проверку JSON, состава категорий или верхних границ. Верни ровно пять допустимых оценок в пределах scoreCaps и пояснения по-русски.` });
    grades = validateGrades(repair, computed.promptPacket);
  }
  return {
    reviewActionId: input.reviewActionId,
    originalActionId: input.original.actionId,
    version: GRADING_VERSION,
    generatedAt: new Date().toISOString(),
    model, repaired, latencyMs: Date.now() - startedAt,
    grades: grades.map((grade, index) => ({ ...grade,
      scoreCap: computed.promptPacket.scoreCaps[grade.category],
      evidence: computed.promptPacket.categoryEvidence[evidenceKeys[index]]
    })),
    footprint: computed.promptPacket.editFootprint
  };
}
