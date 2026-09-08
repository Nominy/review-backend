import { describe, expect, it } from 'bun:test';
import { computeReviewMetrics } from "./metrics";
import { CATEGORIES } from "./rules";
import { generateGrades, validateGrades } from './service';
import { validateGradingInput } from './routes';
import { createApp } from '../../app';
import { config } from '../../config';
import type { Annotation, NormalizedState } from "./types";
const originalId = '11111111-1111-4111-8111-111111111111';
const currentId = '22222222-2222-4222-8222-222222222222';
const segment = (id: string, text: string, start: number, end = start + 2, track = 'speaker-a'): Annotation => ({
  id, content: text, startTimeInSeconds: start, endTimeInSeconds: end, processedRecordingId: track,
  reviewActionId: '', type: 'speech', metadata: null
});
const state = (annotations: Annotation[], current = false): NormalizedState => ({ actionId: current ? currentId : originalId,
  actionLevel: current ? 2 : 1, actionDecision: 'pending', annotations, recordings: [], lintErrors: [], capturedAt: '' });
const input = (before: Annotation[], after: Annotation[]) => ({ reviewActionId: currentId, original: state(before), current: state(after, true) });
const feedback = (score = 1) => JSON.stringify({ feedback: CATEGORIES.map(category => ({ category, score, note: 'Проверено.' })) });

describe('restored grade evidence', () => {
  it('exempts L1 uncertainty comments without hiding mandatory service tags', () => {
    const before = [segment('a', 'Привет. {Возможно, нужен такой-то тег}', 0), segment('comment', '{Возможно, там такое-то слово}', 4)];
    const after = [segment('b', 'Привет.', 0)];
    const packet = computeReviewMetrics(state(before), state(after, true), currentId).promptPacket;
    expect(Object.values(packet.ownershipSummary)).toEqual([0, 0, 0, 0, 0]);
    const withTag = computeReviewMetrics(state([segment('a', '5 {СКАЗ: пять}', 0)]), state([segment('b', '5', 0)], true), currentId).promptPacket;
    expect(withTag.ownershipSummary.tagsOwned).toBe(1);
  });
  it('attributes compound-number normalization to tags while preserving real number corrections', () => {
    const normalized = computeReviewMetrics(state([segment('a', 'двадцать пять рублей', 0)]), state([segment('b', '25 {СКАЗ: двадцать пять} рублей', 0)], true), currentId).promptPacket;
    expect(normalized.ownershipSummary.tagsOwned).toBe(1);
    expect(normalized.ownershipSummary.wordOwned).toBe(0);
    const corrected = computeReviewMetrics(state([segment('a', '5 {СКАЗ: пять} рублей', 0)]), state([segment('b', '6 {СКАЗ: шесть} рублей', 0)], true), currentId).promptPacket;
    expect(corrected.ownershipSummary.wordOwned).toBe(1);
  });
  it('recognizes emphasis and capitalization without inventing lexical errors', () => {
    const packet = computeReviewMetrics(state([segment('a', 'Это важно.', 0), segment('b', 'привет.', 4)]), state([segment('c', 'Это *важно*.', 0), segment('d', 'Привет.', 4)], true), currentId).promptPacket;
    expect(packet.ownershipSummary.tagsOwned).toBe(1);
    expect(packet.ownershipSummary.punctuationOwned).toBe(1);
    expect(packet.ownershipSummary.wordOwned).toBe(0);
  });
  it('applies the 50 ms timing tolerance before building grade evidence', () => {
    const before = state([segment('a', 'Слово.', 0, 2)]);
    const close = computeReviewMetrics(before, state([segment('b', 'Слово.', 0, 2.05)], true), currentId).promptPacket;
    const shifted = computeReviewMetrics(before, state([segment('b', 'Слово.', 0, 2.1)], true), currentId).promptPacket;
    expect(close.ownershipSummary.timestampOwned).toBe(0);
    expect(shifted.ownershipSummary.timestampOwned).toBe(1);
    expect(shifted.scoreCaps['Timestamp Accuracy']).toBe(1);
  });
  it('keeps unchanged transcripts at the best score in every category', () => {
    const pair = input([segment('a', 'Привет, мир.', 0)], [segment('b', 'Привет, мир.', 0)]);
    const result = computeReviewMetrics(pair.original, pair.current, currentId);
    expect(Object.values(result.promptPacket.scoreCaps)).toEqual([1, 1, 1, 1, 1]);
    expect(result.promptPacket.ownershipSummary.wordOwned).toBe(0);
  });
  it('attributes repeated punctuation edits without lowering word accuracy', () => {
    const before = [segment('a', 'Привет мир', 0), segment('b', 'Как дела', 4)];
    const after = [segment('c', 'Привет, мир.', 0), segment('d', 'Как дела?', 4)];
    const packet = computeReviewMetrics(state(before), state(after, true), currentId).promptPacket;
    expect(packet.scoreCaps['Punctuation & Formatting']).toBe(2);
    expect(packet.scoreCaps['Word Accuracy']).toBe(1);
  });
  it('matches speaker tracks separately even when speech overlaps exactly', () => {
    const before = [segment('a', 'Первый голос', 0), segment('b', 'Второй голос', 0, 2, 'speaker-b')];
    const after = [segment('c', 'Второй голос', 0, 2, 'speaker-b'), segment('d', 'Первый голос', 0)];
    const packet = computeReviewMetrics(state(before), state(after, true), currentId).promptPacket;
    expect(packet.editFootprint.stableMatchedSegments).toBe(2);
    expect(packet.ownershipSummary.wordOwned).toBe(0);
  });
  it('counts a split and combine separately even with zero net segment change', () => {
    const before = [segment('a', 'Один два', 0, 4), segment('b', 'Три', 6, 8), segment('c', 'Четыре', 8, 10)];
    const after = [segment('d', 'Один', 0, 2), segment('e', 'Два', 2, 4), segment('f', 'Три четыре', 6, 10)];
    const packet = computeReviewMetrics(state(before), state(after, true), currentId).promptPacket;
    expect(packet.editFootprint.segmentCountDelta).toBe(0);
    expect(packet.ownershipSummary.segmentationOwned).toBe(2);
    expect(packet.ownershipSummary.wordOwned).toBe(0);
    expect(packet.ownershipSummary.timestampOwned).toBe(0);
    expect(packet.scoreCaps.Segmentation).toBe(2);
  });
  it('restores systemic thresholds for repeated lexical corrections', () => {
    const before = Array.from({ length: 5 }, (_, i) => segment(`a${i}`, 'Первый вариант', i * 4));
    const after = Array.from({ length: 5 }, (_, i) => segment(`b${i}`, 'Другой текст', i * 4));
    expect(computeReviewMetrics(state(before), state(after, true), currentId).promptPacket.scoreCaps['Word Accuracy']).toBe(3);
  });
});

describe('grading output and request contract', () => {
  const pair = input([segment('a', 'Привет.', 0)], [segment('b', 'Привет.', 0)]);
  const packet = computeReviewMetrics(pair.original, pair.current, currentId).promptPacket;
  it('rejects missing, duplicate, fractional, and unsupported grades', () => {
    expect(() => validateGrades('{"feedback":[]}', packet)).toThrow();
    expect(() => validateGrades(feedback(1.5), packet)).toThrow();
    expect(() => validateGrades(feedback(3), packet)).toThrow('score cap');
    const duplicate = JSON.parse(feedback()); duplicate.feedback[1] = duplicate.feedback[0];
    expect(() => validateGrades(JSON.stringify(duplicate), packet)).toThrow();
  });
  it('repairs invalid model output once, then returns evidence with every grade', async () => {
    let calls = 0;
    const result = await generateGrades(pair, async () => ++calls === 1 ? '{"feedback":[]}' : feedback());
    expect(calls).toBe(2); expect(result.repaired).toBe(true);
    expect(result.grades).toHaveLength(5);
    expect(result.grades.every(grade => grade.score === 1 && grade.evidence.count === 0)).toBe(true);
  });
  it('does not fabricate grades after a failed repair', async () => {
    let calls = 0;
    await expect(generateGrades(pair, async () => { calls++; return '{}'; })).rejects.toThrow();
    expect(calls).toBe(2);
  });
  it('rejects wrong action, empty baselines, bad times, and unrelated recordings', () => {
    expect(() => validateGradingInput(pair)).not.toThrow();
    expect(() => validateGradingInput({ ...pair, reviewActionId: originalId })).toThrow();
    expect(() => validateGradingInput({ ...pair, original: state([]) })).toThrow();
    expect(() => validateGradingInput(input([segment('a', 'Text', 0)], [segment('b', 'Text', 0, 0)]))).toThrow();
    expect(() => validateGradingInput(input([segment('a', 'Text', 0)], [segment('b', 'Text', 0, 2, 'unrelated')]))).toThrow();
  });
  it('uses independent supplied keys for concurrent grade requests', async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = config.openRouterApiKey;
    const seen: string[] = [];
    try {
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('authorization')!);
        await new Promise(resolve => setTimeout(resolve, 5));
        return Response.json({ choices: [{ message: { content: feedback() }, finish_reason: 'stop' }] });
      }) as typeof fetch;
      const app = createApp();
      const responses = await Promise.all(['sk-or-user-a', 'sk-or-user-b'].map(key => app.handle(new Request('http://localhost/api/review/grade', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenRouter-Key': key }, body: JSON.stringify(pair)
      }))));
      expect(responses.map(response => response.status)).toEqual([200, 200]);
      expect(seen.sort()).toEqual(['Bearer sk-or-user-a', 'Bearer sk-or-user-b']);
      expect(config.openRouterApiKey).toBe(originalKey);
    } finally { globalThis.fetch = originalFetch; }
  });
  it('serves the grading endpoint through the real backend router', async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = config.openRouterApiKey;
    const requests: string[] = [];
    try {
      config.openRouterApiKey = 'synthetic-grading-test-key';
      globalThis.fetch = (async (url: string | URL | Request) => {
        requests.push(String(url));
        return new Response(JSON.stringify({ choices: [{ message: { content: feedback() }, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch;
      const response = await createApp().handle(new Request('http://localhost/api/review/grade', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenRouter-Key': 'explicit-user-fixture' }, body: JSON.stringify(pair)
      }));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.reviewActionId).toBe(currentId);
      expect(body.grades).toHaveLength(5);
      expect(requests).toEqual(['https://openrouter.ai/api/v1/chat/completions']);
    } finally { globalThis.fetch = originalFetch; config.openRouterApiKey = originalKey; }
  });
});
