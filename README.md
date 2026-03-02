# Babel Review Backend (Bun + Elysia)

Server-side review engine for the extension.

## Run

```bash
cd review-backend
cp .env.runtime.example .env.runtime
# edit .env.runtime and set OPENROUTER_API_KEY
bun install
bun run dev
```

Notes:
- This project loads `.env.runtime` from app code (`src/load-env.ts`) and runs Bun with `--no-env-file` as a workaround for a Bun dotenv crash on some environments.
- `OPENROUTER_API_KEY` is required when `OPENROUTER_TEST_MODE=false`.
- `OPENROUTER_MODEL` is optional (defaults to `openai/gpt-oss-120b`).
- `OPENROUTER_TEST_MODE` is optional (`false` by default). Set `true` to skip OpenRouter and return mock feedback (`test test test`, scores `1/2/3`).
- `REVIEW_PAIR_LOG_PATH` is optional (defaults to `logs/review-text-pairs.jsonl`).
- `ANALYTICS_LOG_PATH` is optional (defaults to `logs/review-analytics.jsonl`).
- `HOST` is optional (defaults to `127.0.0.1`).
- `PORT` is optional (defaults to `3001`).
- `PUBLIC_BASE_URL` is optional (for logs/visibility; defaults to `http://<HOST>:<PORT>`).
- `CORS_ALLOWED_ORIGINS` is optional:
  - set `*` to allow all origins (dev)
  - or comma-separated values (recommended), e.g. `https://dashboard.babel.audio`

Each `POST /api/review/generate` call appends one JSON line with:
- `reviewActionId`
- `originalText` (joined from `original.annotations[].content`)
- `reviewedText` (joined from `current.annotations[].content`)
- `loggedAt`, `originalCapturedAt`, `currentCapturedAt`

Each analytics event appends one JSON line to `ANALYTICS_LOG_PATH` with:
- event type (`review_generate` or `submit_transcript_review_action`)
- full `original` and `current` normalized states
- extracted `originalText` and `currentText`
- computed metrics (`stats` + `featurePacket`)
- `aiReview` payload (when available)
- `inputBoxes` snapshot (user correction fields at submit time)
- metadata (source/status/timestamps)

Default URL: `http://127.0.0.1:3001`

## Production Domain (`reviewgen.ovh`)

1. Point DNS `A` record for `reviewgen.ovh` to your server IP.
2. Run backend on server with:
   - `HOST=127.0.0.1`
   - `PORT=3001`
   - `PUBLIC_BASE_URL=https://reviewgen.ovh`
   - `CORS_ALLOWED_ORIGINS=https://dashboard.babel.audio`
   - you can start from `.env.production.example`
3. Put reverse proxy in front of backend:
   - Caddy example: `deploy/Caddyfile`
   - Nginx example: `deploy/nginx.reviewgen.ovh.conf`
4. Proxy `https://reviewgen.ovh` -> `http://127.0.0.1:3001`.

After this, extension can call `https://reviewgen.ovh/api/review/generate`.

## Endpoints

- `GET /health`
- `POST /api/review/prepare`
- `POST /api/review/generate`
- `POST /api/trpc/transcriptions.submitTranscriptReviewAction`
- `POST /api/analytics/submit-transcript-review-action`

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

## `POST /api/trpc/transcriptions.submitTranscriptReviewAction` body

```json
{
  "reviewActionId": "uuid",
  "original": {},
  "current": {},
  "inputBoxes": {},
  "aiReview": {},
  "metadata": {}
}
```

Returns:

```json
{
  "ok": true,
  "savedAt": "2026-02-24T00:00:00.000Z",
  "reviewActionId": "uuid",
  "prepared": {}
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
