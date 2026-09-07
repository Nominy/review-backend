# Restored review grading

`POST /api/review/grade` accepts `{ reviewActionId, original, current }` normalized
snapshots and returns five grades, their notes, evidence, and a grading version.
It is independent of `/api/review/generate` and the template-based Review Helper
pipeline. The existing backend OpenRouter configuration supplies the model/key.
No new deployment or remote service is created by this change.

## Historical source

`legacy/{metrics,edit-attribution,prompt,types,rules}.ts` were recovered from
review-backend commit `402a1e2`. The original rules use a 1–3 scale, one primary
owner for each correction, category-specific score caps, and micro-edit limits.
The model selects grades within those limits and writes concise Russian notes.
The grader retains those thresholds and prompt rules.

Corrections made during recovery:

- Match only segments from the same recording track.
- Reserve split/combine components for Segmentation; only actual 1:1 matches
  contribute lexical or timestamp evidence.
- Count distinct structural changes rather than only their net segment delta.
- Parenthesize tag-change detection correctly.
- Enforce complete, unique categories and score caps in code, not only in prompts.
  An invalid response gets one repair attempt and then fails without invented grades.
- Reject malformed, empty, same-action, non-L1 baseline, or unrelated snapshot pairs.

Transcript evidence is untrusted data in the model prompt. Grades are relative
to the reviewed transcript, not an independent audio assessment. The inherited
engine samples up to three evidence examples per category while retaining full
category counts; a score of 1 does not certify a transcript is error-free.

Tests: `bun test src/apps/grading/grading.test.ts` (also included in `npm test`).
The tests inject model responses and do not call paid inference.
