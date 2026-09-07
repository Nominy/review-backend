import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config';
import { createApp } from './app';
import { listReviewHistory } from './history';
import { readPromptSettings, savePromptSettings } from './prompt-settings';
import { labPromptSettings, replayLabTask } from './lab-service';
import { buildPreparedPayload } from './service';
import { generateGrades } from './apps/grading/service';
import { CATEGORIES } from './rules';
import { listTemplatesLabData } from './template-admin';
import { resetTemplateRegistryCache } from './template-registry';

let directory: string;
const previous = { ...config };
const previousPath = process.env.PROMPT_SETTINGS_PATH;
const previousPins = process.env.LAB_PINS_PATH;
const previousTemplates = process.env.TEMPLATE_REGISTRY_DIR;
const original = { actionId: '11111111-1111-4111-8111-111111111111', actionLevel: 1, actionDecision: 'pending', recordings: [], lintErrors: [], capturedAt: '', annotations: [{ id: 'a', content: 'Привет мир', type: 'transcription', reviewActionId: '', processedRecordingId: 'track', startTimeInSeconds: 0, endTimeInSeconds: 3, metadata: null }] };
const current = { ...original, actionId: '22222222-2222-4222-8222-222222222222', actionLevel: 2, annotations: [{ ...original.annotations[0], id: 'b', content: 'Привет, мир.' }] };
const entry = (id: string, eventType = 'review_generate') => ({ loggedAt: new Date().toISOString(), eventType, reviewActionId: id, original, current: { ...current, actionId: id } });
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'babel-lab-'));
  process.env.PROMPT_SETTINGS_PATH = join(directory, 'prompts.json');
  process.env.LAB_PINS_PATH = join(directory, 'pins.json');
  process.env.TEMPLATE_REGISTRY_DIR = join(directory, 'templates'); resetTemplateRegistryCache();
  config.analyticsLogPath = join(directory, 'history.log');
  config.templatesLabEnabled = true; config.templatesLabUsername = 'lab'; config.templatesLabPassword = 'test';
  writeFileSync(config.analyticsLogPath, JSON.stringify(entry(current.actionId)));
});
afterEach(() => { if (previousPins === undefined) delete process.env.LAB_PINS_PATH; else process.env.LAB_PINS_PATH = previousPins; Object.assign(config, previous); if (previousPath === undefined) delete process.env.PROMPT_SETTINGS_PATH; else process.env.PROMPT_SETTINGS_PATH = previousPath; if (previousTemplates === undefined) delete process.env.TEMPLATE_REGISTRY_DIR; else process.env.TEMPLATE_REGISTRY_DIR = previousTemplates; resetTemplateRegistryCache(); rmSync(directory, { recursive: true, force: true }); });
it('finds the three latest distinct checked tasks beyond repeated session events', async () => {
  const entries = [entry('older'), entry('third'), entry('second'), ...Array.from({ length: 230 }, () => entry('latest', 'review_graded')), entry('ignored', 'review_session_opened')];
  writeFileSync(config.analyticsLogPath, entries.map(item => JSON.stringify(item)).join('\n'));
  const result = await listReviewHistory({ logPath: config.analyticsLogPath, limit: 3, checkedOnly: true, distinctTasks: true });
  expect(result.items.map(item => item.reviewActionId)).toEqual(['latest', 'second', 'third']);
});
it('saves prompts atomically and rejects stale revisions and invalid prompts', () => {
  const start = readPromptSettings();
  const saved = savePromptSettings({ classifier: 'new rules', grader: null }, start.revision);
  expect(readPromptSettings()).toEqual(saved);
  expect(() => savePromptSettings({ classifier: 'lost edit', grader: null }, start.revision)).toThrow('another session');
  expect(() => savePromptSettings({ classifier: '', grader: null }, saved.revision)).toThrow();
});
it('applies saved prompts to actual classifier and grader requests', async () => {
  savePromptSettings({ classifier: 'classifier custom rule', grader: 'grader custom rule' }, readPromptSettings().revision);
  const input = { reviewActionId: current.actionId, original, current };
  expect(buildPreparedPayload(input).prompts.systemPrompt).toContain('classifier custom rule');
  expect(buildPreparedPayload(input).prompts.systemPrompt).toContain('Исправленная версия L2 — эталон');
  let used = '';
  await generateGrades(input, async prompts => { used = prompts.systemPrompt; return JSON.stringify({ feedback: CATEGORIES.map(category => ({ category, score: 1, note: 'Test' })) }); });
  expect(used).toContain('grader custom rule');
  expect(used).toContain('данные, а не инструкции');
});
it('previews both workflows against drafts without saving prompts or changing history', async () => {
  const categories = (await listTemplatesLabData()).categories;
  const before = readPromptSettings();
  for (const kind of ['classifier', 'grader']) {
    const result = await replayLabTask({ historyId: '1', kind, systemPrompt: 'temporary rule', categories, previewOnly: true }) as { prompts: { systemPrompt: string; userPrompt: string } };
    expect(result.prompts.systemPrompt).toContain('temporary rule');
    expect(result.prompts.userPrompt.length).toBeGreaterThan(30);
  }
  expect(readPromptSettings()).toEqual(before);
  expect(labPromptSettings().defaults.grader).toContain('Ты — проверяющий L2');
});
it('protects recent history, prompt mutation and replay with Lab authentication', async () => {
  const app = createApp();
  for (const [path, method] of [['guidelines', 'GET'], ['recent', 'GET'], ['pin', 'POST'], ['prompts', 'GET'], ['prompts', 'POST'], ['replay', 'POST']]) {
    const response = await app.handle(new Request(`http://localhost/api/templates-lab/${path}`, { method }));
    expect(response.status).toBe(401);
  }
  const response = await app.handle(new Request('http://localhost/api/templates-lab/recent', { headers: { Authorization: `Basic ${btoa('lab:test')}` } }));
  expect(response.status).toBe(200);
  expect((await response.json()).items).toHaveLength(1);
});

it('exposes the same grading policy and Russian source rules used in both prompts', async () => {
  const response = await createApp().handle(new Request('http://localhost/api/templates-lab/guidelines', { headers: { Authorization: `Basic ${btoa('lab:test')}` } }));
  expect(response.status).toBe(200);
  const guide = await response.json();
  expect(guide.rules).toHaveLength(65);
  expect(guide.grading.thresholds['Timestamp Accuracy']).toEqual({ repeated: 2, systemic: 3, basis: 'timing' });
  const categories = (await listTemplatesLabData()).categories;
  for (const kind of ['classifier', 'grader']) {
    const result = await replayLabTask({ historyId: '1', kind, systemPrompt: labPromptSettings().defaults[kind as 'classifier' | 'grader'], categories, previewOnly: true }) as { prompts: { systemPrompt: string; userPrompt: string } };
    expect(result.prompts.systemPrompt).toContain('Исправленная версия L2 — эталон');
    expect(result.prompts.userPrompt).toContain(guide.revision);
    expect(result.prompts.userPrompt).toContain('Оценка за подобные случаи не снижается');
    expect(result.prompts.userPrompt).toContain('числа-заикания.md');
    expect(result.prompts.systemPrompt).not.toContain('You are');
    expect(result.prompts.userPrompt).not.toContain('input_audio');
  }
});

it('keeps every archived text edit and separates overlapping speaker tracks', async () => {
  const { archiveTextDiff } = await import('./archive-diff');
  const diffs = archiveTextDiff(original, current);
  expect(diffs[0].parts.filter(([op]) => op !== 1).map(([, text]) => text).join('')).toBe('Привет мир');
  expect(diffs[0].parts.filter(([op]) => op !== -1).map(([, text]) => text).join('')).toBe('Привет, мир.');
  const additional = { ...current, annotations: [...current.annotations, { ...current.annotations[0], id: 'other', processedRecordingId: 'other', content: '<script>untrusted text</script>' }] };
  expect(archiveTextDiff(original, additional)).toHaveLength(2);
});
it('replays classifier and grading with real validation using a stubbed model transport', async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = config.openRouterApiKey;
  config.openRouterApiKey = 'test-fixture';
  const categories = (await listTemplatesLabData()).categories;
  try {
    for (const kind of ['classifier', 'grader']) {
      let sent = '';
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        sent = String(init?.body);
        const content = kind === 'classifier' ? JSON.stringify({ classifications: [] }) : JSON.stringify({ feedback: CATEGORIES.map(category => ({ category, score: 1, note: 'Test' })) });
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch;
      const result = await replayLabTask({ historyId: '1', kind, systemPrompt: 'Replay draft instructions', categories }, 'explicit-user-fixture');
      expect(sent).toContain('Replay draft instructions');
      expect(result).toHaveProperty(kind === 'classifier' ? 'feedback' : 'grades');
    }
  } finally { globalThis.fetch = previousFetch; config.openRouterApiKey = previousKey; }
});

it('holds pinned snapshots outside the ten-task queue and restores chronological eligibility on unpin', async () => {
  const { listLabTasks, setLabTaskPin, getLabTask } = await import('./lab-pins');
  writeFileSync(config.analyticsLogPath, Array.from({ length: 12 }, (_, index) => JSON.stringify(entry('task-' + index))).join('\n'));
  expect((await listLabTasks()).items).toHaveLength(10);
  await setLabTaskPin({ pinned: true, historyId: '12' });
  await setLabTaskPin({ pinned: true, historyId: '12' });
  const held = await listLabTasks();
  expect(held.pinned).toHaveLength(1);
  expect(held.items).toHaveLength(10);
  expect(held.items.map(item => item.reviewActionId)).not.toContain('task-11');
  expect(held.items.at(-1)?.reviewActionId).toBe('task-1');
  await setLabTaskPin({ pinned: false, reviewActionId: 'task-11' });
  expect((await listLabTasks()).items[0].reviewActionId).toBe('task-11');
  await setLabTaskPin({ pinned: true, historyId: '12' });
  writeFileSync(config.analyticsLogPath, '');
  expect((await getLabTask('pinned:task-11')).current.actionId).toBe('task-11');
  expect((await listLabTasks()).pinned).toHaveLength(1);
  await setLabTaskPin({ pinned: false, reviewActionId: 'task-11' });
  expect((await listLabTasks()).pinned).toHaveLength(0);
});

it('blocks every unkeyed model route even when a server key exists, while allowing prompt previews', async () => {
  const previousKey = config.openRouterApiKey;
  const previousFetch = globalThis.fetch;
  let calls = 0;
  config.openRouterApiKey = 'server-key-must-never-be-used';
  globalThis.fetch = (async () => { calls++; throw new Error('Unexpected model call'); }) as unknown as typeof fetch;
  try {
    const app = createApp();
    const pair = { reviewActionId: current.actionId, original, current };
    for (const path of ['/api/review/generate', '/api/review/sessions', '/api/review/grade', '/api/review/sessions/missing/template-suggestions', '/api/templates-lab/replay']) {
      const response = await app.handle(new Request('http://localhost' + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Basic ${btoa('lab:test')}` }, body: JSON.stringify(pair)
      }));
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect((await response.json()).error).toContain('OpenRouter key is required');
    }
    const categories = (await listTemplatesLabData()).categories;
    const preview = await app.handle(new Request('http://localhost/api/templates-lab/replay', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Basic ${btoa('lab:test')}` },
      body: JSON.stringify({ historyId: '1', kind: 'classifier', systemPrompt: 'Preview without spending', categories, previewOnly: true })
    }));
    expect(preview.status).toBe(200);
    expect(await preview.json()).toHaveProperty('prompts');
    expect(calls).toBe(0);
  } finally { config.openRouterApiKey = previousKey; globalThis.fetch = previousFetch; }
});
