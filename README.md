# Babel Review Backend (Bun + Elysia)

Server-side review engine for the extension.

## Run

```bash
cd review-backend
cp .env.example .env
# edit .env and set OPENROUTER_API_KEY
bun install
bun run dev
```

Notes:
- Bun auto-loads `.env` in dev/runtime.
- `OPENROUTER_API_KEY` is required when `OPENROUTER_TEST_MODE=false`.
- `OPENROUTER_MODEL` is optional (defaults to `openai/gpt-oss-120b`).
- `OPENROUTER_TEST_MODE` is optional (`false` by default). Set `true` to skip OpenRouter and return mock feedback (`test test test`, scores `1/2/3`).
- `REVIEW_PAIR_LOG_PATH` is optional (defaults to `logs/review-text-pairs.jsonl`).

Each `POST /api/review/generate` call appends one JSON line with:
- `reviewActionId`
- `originalText` (joined from `original.annotations[].content`)
- `reviewedText` (joined from `current.annotations[].content`)
- `loggedAt`, `originalCapturedAt`, `currentCapturedAt`

Default URL: `http://127.0.0.1:3001`

## Endpoints

- `GET /health`
- `POST /api/review/prepare`
- `POST /api/review/generate`

## `POST /api/review/prepare` body

```json
{
  "reviewActionId": "uuid",
  "original": {},
  "current": {}
}
```

Returns prepared payload with `stats`, `featurePacket`, and `prompts`.

`featurePacket.diagnostics` now includes reviewer-oriented signals:
- `word_accuracy` (change magnitude/severity)
- `timestamp_behavior` (grew vs shrank segments, severity, advice hint)
- `punctuation_formatting` (punctuation + spacing issue counters)
- `tags_and_emphasis` (`<>`, `[]`, `{}`, `**`, breathing-tag deltas)
- `segmentation` (added/deleted/split/combined event estimates, direction)
- `reviewer_playbook_hints` (0.75 playback / zoom-hotkey hints, pause rule hint)

## `POST /api/review/generate` body

```json
{
  "reviewActionId": "uuid",
  "original": {},
  "current": {}
}
```

Returns:

```json
{
  "prepared": {},
  "llm": {
    "feedback": []
  }
}
```
