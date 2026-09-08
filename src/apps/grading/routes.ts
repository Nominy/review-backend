import { requestApiKey } from "../../shared/review-key";
import type { AnyElysia } from 'elysia';
import { isObject } from '../../shared/http';
import { generateGrades, type GradingInput } from './service';
import { writeStructuredLog } from "../../shared/structured-logger";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateGradingInput(body: unknown): asserts body is GradingInput {
  if (!isObject(body) || typeof body.reviewActionId !== 'string' || !uuid.test(body.reviewActionId)) {
    throw new Error('A valid reviewActionId is required.');
  }
  for (const name of ['original', 'current'] as const) {
    const state = body[name];
    if (!isObject(state) || typeof state.actionId !== 'string' || !uuid.test(state.actionId)
      || !Array.isArray(state.annotations) || !state.annotations.length || state.annotations.length > 4000
      || !Array.isArray(state.recordings)) throw new Error(`${name} must contain a valid transcript snapshot.`);
    const ids = new Set<string>();
    for (const annotation of state.annotations) {
      if (!isObject(annotation) || typeof annotation.id !== 'string' || !annotation.id || ids.has(annotation.id)
        || typeof annotation.content !== 'string' || annotation.content.length > 20000
        || typeof annotation.processedRecordingId !== 'string' || !annotation.processedRecordingId
        || typeof annotation.startTimeInSeconds !== 'number' || !Number.isFinite(annotation.startTimeInSeconds)
        || typeof annotation.endTimeInSeconds !== 'number' || !Number.isFinite(annotation.endTimeInSeconds)
        || annotation.startTimeInSeconds < 0 || annotation.endTimeInSeconds <= annotation.startTimeInSeconds) {
        throw new Error(`${name} contains an invalid or duplicate annotation.`);
      }
      ids.add(annotation.id);
    }
  }
  const input = body as unknown as GradingInput;
  if (input.current.actionId !== input.reviewActionId || input.original.actionId === input.current.actionId
    || input.original.actionLevel !== 1 || input.current.actionLevel <= 1 || !Number.isInteger(input.current.actionLevel)) {
    throw new Error('Grading requires the L1 original and a distinct current review action.');
  }
  const originalTracks = new Set(input.original.annotations.map(a => a.processedRecordingId));
  if (!input.current.annotations.some(a => originalTracks.has(a.processedRecordingId))) {
    throw new Error('Original and current snapshots must belong to the same recording.');
  }
}

export function registerGradingRoutes(app: AnyElysia): void {
  app.post('/api/review/grade', async ({ body, headers, set }) => {
    try { validateGradingInput(body); }
    catch (error) { set.status = 400; return { error: error instanceof Error ? error.message : String(error) }; }
    try {
      const result = await generateGrades(body, undefined, undefined, requestApiKey(headers));
      writeStructuredLog({ logType: 'review_analytics', loggedAt: result.generatedAt, eventType: 'review_graded', reviewActionId: body.reviewActionId, original: body.original, current: body.current, aiReview: result });
      return result;
    }
    catch (error) { set.status = 502; return { error: error instanceof Error ? error.message : String(error) }; }
  });
}
