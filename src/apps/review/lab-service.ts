import { config } from "../../config";
import { getLabTask } from './lab-pins';
import { readPromptSettings } from "../../shared/prompt-settings";
import { buildSystemPrompt, buildPrompts } from './prompt';
import { computeReviewMetrics } from './metrics';
import { computeReviewMetrics as gradingMetrics } from "../grading/metrics";
import { buildPrompts as gradingPrompts } from "../grading/prompt";
import { generateGrades } from "../grading/service";
import { validateGradingInput } from "../grading/routes";
import { buildTemplateRegistry, validateTemplateRegistryFileData } from './template-registry';
import { sendToOpenRouter } from './openrouter';
import { renderFeedbackFromTemplateMatches } from './template-renderer';
import { extractChanges } from './change-extractor';
import type { NormalizedState } from './types';
import { composeReviewSystemPrompt } from "../../shared/guidelines";

export function labPromptSettings() {
  const empty: NormalizedState = { actionId: '', actionLevel: 1, actionDecision: '', annotations: [], recordings: [], lintErrors: [], capturedAt: '' };
  return { ...readPromptSettings(), model: config.openRouterModel, defaults: {
    classifier: buildSystemPrompt(), grader: gradingPrompts(gradingMetrics(empty, empty, '').promptPacket).systemPrompt
  } };
}

export async function replayLabTask(body: unknown, apiKey = '') {
  const input = body as { historyId?: string; kind?: string; systemPrompt?: string; categories?: unknown[]; previewOnly?: boolean };
  if (!input || !['classifier', 'grader'].includes(input.kind || '') || typeof input.historyId !== 'string'
    || typeof input.systemPrompt !== 'string' || !input.systemPrompt.trim() || input.systemPrompt.length > 40000) {
    throw Object.assign(new Error('A history ID, prompt kind and nonempty system prompt (up to 40000 characters) are required.'), { statusCode: 400 });
  }
  const task = await getLabTask(input.historyId);
  if (input.kind === 'grader') {
    validateGradingInput(task);
    const prompts = gradingPrompts(gradingMetrics(task.original, task.current, task.reviewActionId).promptPacket);
    if (input.previewOnly) return { prompts: { ...prompts, systemPrompt: composeReviewSystemPrompt(input.systemPrompt) }, model: config.openRouterModel };
    return generateGrades(task, undefined, input.systemPrompt, apiKey);
  }
  if (!Array.isArray(input.categories) || input.categories.length !== 5) throw Object.assign(new Error('All five template categories are required.'), { statusCode: 400 });
  const files = input.categories.map((value, index) => {
    const category = value as Record<string, unknown>;
    return validateTemplateRegistryFileData(`draft-${index}`, { ...category, version: category.fileVersion });
  });
  const registry = buildTemplateRegistry(files);
  const computed = computeReviewMetrics(task.original, task.current, task.reviewActionId, task.babelDiff);
  const prompts = buildPrompts(computed.promptPacket, registry.promptCatalog);
  prompts.systemPrompt = composeReviewSystemPrompt(input.systemPrompt);
  if (input.previewOnly) return { prompts, model: config.openRouterModel };
  if (!apiKey) throw new Error('Replay requires an OpenRouter API key.');
  const result = await sendToOpenRouter({ apiKey, model: config.openRouterModel, prompts, registry });
  const changeIds = new Set(extractChanges(computed.promptPacket).map(change => change.index));
  if (result.classifications.some(item => !changeIds.has(item.change))) throw new Error('Model returned an unknown change number.');
  return { ...result, ...renderFeedbackFromTemplateMatches(task.reviewActionId, result.findings, registry) };
}
