# Babel Review Backend (Bun + Elysia)

Server-side review engine for the extension.

## Template Registry

Issue templates are stored under `templates/` as five JSON files, one per review category:

- `templates/word-accuracy.json`
- `templates/timestamp-accuracy.json`
- `templates/punctuation-formatting.json`
- `templates/tags-emphasis.json`
- `templates/segmentation.json`

Each template entry now contains:

- `id`
- `title`
- `description`
- `reportText`
- `priority`
- `enabled`

The backend now asks the LLM to return only matching template IDs from this catalog. Final reviewer notes are assembled locally from the matching template strings, while `POST /api/review/generate` keeps the same five-card response shape for extension compatibility.

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
- `OPENROUTER_TEST_MODE` is optional (`false` by default). Set `true` to skip OpenRouter and return deterministic default template-backed feedback.
- `REVIEW_PAIR_LOG_PATH` is optional (defaults to `logs/review-text-pairs.jsonl`).
- `ANALYTICS_LOG_PATH` is optional (defaults to `logs/review-analytics.jsonl`).
- `HOST` is optional (defaults to `127.0.0.1`).
- `PORT` is optional (defaults to `3001`).
- `PUBLIC_BASE_URL` is optional (for logs/visibility; defaults to `http://<HOST>:<PORT>`).
- `CORS_ALLOWED_ORIGINS` is optional:
  - set `*` to allow all origins (dev)
  - or comma-separated values (recommended), e.g. `https://dashboard.babel.audio`
- `TEMPLATES_LAB_USERNAME` and `TEMPLATES_LAB_PASSWORD` are optional:
  - when both are set, the admin UI is enabled at `/templates-lab`
  - the whole section uses HTTP Basic Auth

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

## Templates Lab

The backend can also serve a lightweight admin UI for managing template JSON files directly:

- `GET /templates-lab`
- `GET /api/templates-lab/templates`
- `POST /api/templates-lab/save`

It is disabled unless both `TEMPLATES_LAB_USERNAME` and `TEMPLATES_LAB_PASSWORD` are configured.

The UI now stages create/edit/delete/CSV-import changes locally. Nothing is written to `templates/*.json` until the user clicks `Save Draft`.

CSV export from the UI downloads the current draft as a 4-column file:

```csv
category,name,error description,template text
```

CSV import inside the UI supports two optional toggles:
- `Ignore first line`: skip the first CSV row entirely and treat the file as data-only
- `Overwrite existing registry`: replace the current draft with only the templates from the CSV before saving

By default, CSV import expects a header row with exactly:

```csv
category,name,error description,template text
```

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

The prepared payload is now intentionally lean:
- `featurePacket.overview` gives high-level counts
- `featurePacket.samples.textDiffs` provides focused before/after text pairs for NLP-heavy review
- `featurePacket.samples.timingDiffs` provides focused boundary shifts for timestamp review
- `featurePacket.samples.unmatchedOriginal` / `unmatchedCurrent` provide segmentation clues

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
