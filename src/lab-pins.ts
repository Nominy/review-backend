import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config';
import { getReviewHistoryDetail, listReviewHistory, type ReviewHistoryDetail } from './history';

type Pin = { pinnedAt: string; task: ReviewHistoryDetail };
const path = () => resolve(process.env.LAB_PINS_PATH || 'data/prompt-lab/pinned-tasks.json');
export function readLabPins(): Pin[] {
  return existsSync(path()) ? JSON.parse(readFileSync(path(), 'utf8')) : [];
}
export async function getLabTask(historyId: string): Promise<ReviewHistoryDetail> {
  if (!historyId.startsWith('pinned:')) return getReviewHistoryDetail({ logPath: config.analyticsLogPath, historyId });
  const pin = readLabPins().find(pin => pin.task.historyId === historyId);
  if (!pin) throw new Error('Pinned task not found.');
  return pin.task;
}
export async function setLabTaskPin(input: { pinned: boolean; historyId?: string; reviewActionId?: string }) {
  // Resolve first, then read/modify/write synchronously so overlapping requests preserve other pins.
  const task = input.pinned ? await getLabTask(input.historyId || '') : null;
  const id = task?.reviewActionId || input.reviewActionId;
  if (typeof id !== 'string' || !id.trim() || id.length > 200) throw new Error('A review action ID is required.');
  const pins = readLabPins();
  if (task && !pins.some(pin => pin.task.reviewActionId === id)) pins.unshift({ pinnedAt: new Date().toISOString(), task: { ...task, historyId: `pinned:${id}` } });
  const next = input.pinned ? pins : pins.filter(pin => pin.task.reviewActionId !== id);
  const target = path();
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(next));
  renameSync(temporary, target);
  return { ok: true, pinned: input.pinned, reviewActionId: id };
}
export async function listLabTasks() {
  const pins = readLabPins();
  const recent = await listReviewHistory({ logPath: config.analyticsLogPath, limit: 10, checkedOnly: true, distinctTasks: true, excludeActionIds: pins.map(pin => pin.task.reviewActionId) });
  return { ...recent, pinned: pins.map(({ task, pinnedAt }) => ({ historyId: task.historyId, reviewActionId: task.reviewActionId, loggedAt: task.loggedAt, eventType: task.eventType, originalSegments: task.original.annotations.length, currentSegments: task.current.annotations.length, pinnedAt })) };
}
