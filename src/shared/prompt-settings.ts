import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export type PromptSettings = { classifier: string | null; grader: string | null };
const empty: PromptSettings = { classifier: null, grader: null };
export const promptSettingsPath = () => resolve(process.env.PROMPT_SETTINGS_PATH || 'data/prompt-lab/prompts.json');
export function readPromptSettings(path = promptSettingsPath()) {
  const settings: PromptSettings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { ...empty };
  validatePromptSettings(settings);
  return { settings, revision: createHash('sha256').update(JSON.stringify(settings)).digest('hex') };
}
export function validatePromptSettings(value: unknown): asserts value is PromptSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Prompt settings are required.');
  for (const key of ['classifier', 'grader'] as const) {
    const text = (value as PromptSettings)[key];
    if (text !== null && (typeof text !== 'string' || !text.trim() || text.length > 40000)) throw new Error(`${key} prompt must contain 1–40000 characters, or null for the default.`);
  }
}
export function savePromptSettings(settings: PromptSettings, revision: string, path = promptSettingsPath()) {
  validatePromptSettings(settings);
  if (readPromptSettings(path).revision !== revision) throw Object.assign(new Error('Prompts changed in another session. Reload before saving.'), { statusCode: 409 });
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ classifier: settings.classifier, grader: settings.grader }, null, 2));
  renameSync(temporary, path);
  return readPromptSettings(path);
}
export function effectivePrompt(kind: keyof PromptSettings, fallback: string) {
  return readPromptSettings().settings[kind] ?? fallback;
}
