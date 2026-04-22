# Babel Review Backend (Bun + Elysia)

Server-side review engine for the extension.

## Docs

Durable review workflow and prompting material now lives in `docs/`:

- `docs/review-feedback-spec.md`
- `docs/prompts/master_prompt_ru.md`
- `docs/reference/`

This repo remains source-only. It does not publish packaged ZIP artifacts.

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
- `reportTexts` (array of 1..N variants; backend picks one deterministically per review action)
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
- `ANALYTICS_LOG_PATH` is optional (defaults to `logs/pm2/review-backend.out.log`) and is used by the history API to read structured logs captured by the process manager.
- `REVIEW_SESSIONS_DIR` is optional (defaults to `data/review-sessions`).
- `PENDING_TEMPLATE_PROPOSAL_PATH` is optional (defaults to `data/prompt-lab/pending-template-proposals.json`).
- `HOST` is optional (defaults to `127.0.0.1`).
- `PORT` is optional (defaults to `3001`).
- `PUBLIC_BASE_URL` is optional (for logs/visibility; defaults to `http://<HOST>:<PORT>`).
- `CORS_ALLOWED_ORIGINS` is optional:
  - set `*` to allow all origins (dev)
  - or comma-separated values (recommended), e.g. `https://dashboard.babel.audio`
- `TEMPLATES_LAB_USERNAME` and `TEMPLATES_LAB_PASSWORD` are optional:
  - when both are set, the admin UI is enabled at `/templates-lab`
  - the whole section uses HTTP Basic Auth

Each `POST /api/review/generate` call emits one JSON line to stdout with:
- `reviewActionId`
- `originalText` (joined from `original.annotations[].content`)
- `reviewedText` (joined from `current.annotations[].content`)
- `loggedAt`, `originalCapturedAt`, `currentCapturedAt`

Each analytics event emits one JSON line to stdout with:
- event type (`review_generate`, `submit_transcript_review_action`, and the interactive-session lifecycle events)
- full `original` and `current` normalized states
- extracted `originalText` and `currentText`
- computed metrics (`stats` + `featurePacket`)
- `aiReview` payload (when available)
- `inputBoxes` snapshot (user correction fields at submit time)
- metadata (source/status/timestamps)

The backend no longer appends those logs directly to files. In production, capture stdout/stderr with PM2 and let PM2 rotate the files.

Default URL: `http://127.0.0.1:3001`

## Production Domain (`reviewgen.ovh`)

1. Point DNS `A` record for `reviewgen.ovh` to your server IP.
2. Run backend on server with:
   - `HOST=127.0.0.1`
   - `PORT=3001`
   - `PUBLIC_BASE_URL=https://reviewgen.ovh`
   - `CORS_ALLOWED_ORIGINS=https://dashboard.babel.audio`
   - `ANALYTICS_LOG_PATH=logs/pm2/review-backend.out.log`
   - you can start from `.env.production.example`
3. Put reverse proxy in front of backend:
   - Caddy example: `deploy/Caddyfile`
   - Nginx example: `deploy/nginx.reviewgen.ovh.conf`
4. Proxy `https://reviewgen.ovh` -> `http://127.0.0.1:3001`.

Recommended process manager setup:

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 100M
pm2 set pm2-logrotate:retain 10
pm2 set pm2-logrotate:compress true
```

The included [ecosystem.config.cjs](/C:/Users/User/Desktop/dev/babel/reviewer/review-backend/ecosystem.config.cjs) writes stdout to `logs/pm2/review-backend.out.log` and stderr to `logs/pm2/review-backend.error.log`. Point `ANALYTICS_LOG_PATH` at the stdout file if you want `/api/review-history` to keep working.

After this, extension can call `https://reviewgen.ovh/api/review/generate`.

## Templates Lab

The backend can also serve a lightweight admin UI for managing template JSON files directly:

- `GET /templates-lab`
- `GET /api/templates-lab/templates`
- `POST /api/templates-lab/save`

It is disabled unless both `TEMPLATES_LAB_USERNAME` and `TEMPLATES_LAB_PASSWORD` are configured.

The UI now stages create/edit/delete/CSV-import changes locally. Nothing is written to `templates/*.json` until the user clicks `Save Draft`.

Approved reviewer proposals are stored separately in `PENDING_TEMPLATE_PROPOSAL_PATH`. Templates Lab now shows that pending queue and can copy queued items into the local draft without mutating the live registry files first.

CSV export from the UI downloads the current draft as a 4-column file:

```csv
category,name,error description,template text 1,template text 2,...
```

CSV import inside the UI supports two optional toggles:
- `Ignore first line`: skip the first CSV row entirely and treat the file as data-only
- `Overwrite existing registry`: replace the current draft with only the templates from the CSV before saving

By default, CSV import expects a header row that starts with:

```csv
category,name,error description,template text 1,template text 2,...
```

Rules:
- columns 4+ are treated as template variants
- empty variant cells are ignored
- each row must have at least one non-empty variant

## Endpoints

- `GET /health`
- `POST /api/review/prepare`
- `POST /api/review/generate`
- `POST /api/review/sessions`
- `GET /api/review/sessions/:sessionId`
- `POST /api/review/sessions/:sessionId/comments`
- `POST /api/review/sessions/:sessionId/template-suggestions`
- `POST /api/review/sessions/:sessionId/template-suggestions/:proposalId/decision`
- `POST /api/review/sessions/:sessionId/finalize`
- `GET /api/review-history`
- `GET /api/review-history/:historyId`
- `POST /api/trpc/transcriptions.submitTranscriptReviewAction`
- `POST /api/analytics/submit-transcript-review-action`

## Protected History API

History browsing reads structured analytics entries from `ANALYTICS_LOG_PATH` and is protected with the same HTTP Basic Auth credentials as Templates Lab.

With the default PM2 setup, `ANALYTICS_LOG_PATH` should point to the PM2 stdout log file because the application now writes analytics to stdout instead of appending directly to a dedicated file.

Requirements:
- `TEMPLATES_LAB_USERNAME`
- `TEMPLATES_LAB_PASSWORD`

If those env vars are not set, the history API returns `404`.

`GET /api/review-history` query params:
- `limit` default `50`, capped at `200`
- `reviewActionId` optional substring filter
- `query` optional free-text filter over action id, original/current text, and matched template ids
- `eventType` optional: any logged review analytics event type, including the interactive-session events

`GET /api/review-history/:historyId` returns:
- stored `original` / `current` states
- stored `aiReview`
- stored metrics analysis snapshot
- reconstructed `prepared` payload, including the full deterministic prompts

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

Returns:

```json
{
  "prepared": {},
  "llm": {
    "feedback": [],
    "matchedTemplateIds": [],
    "classifications": []
  }
}
```

## `POST /api/review/sessions` body

```json
{
  "reviewActionId": "uuid",
  "original": {},
  "current": {},
  "babelDiff": {}
}
```

Returns a persisted interactive session payload with:
- `sessionId`
- `reviewActionId`
- `prepared`
- `changes`
- `cards`
- `categoryFeedback`
- `comments`
- `suggestions`
- `aiReview`

## `POST /api/review/sessions/:sessionId/comments` body

```json
{
  "sessionComment": "optional text",
  "cardComments": {
    "change-1": "specific reviewer note"
  }
}
```

## `POST /api/review/sessions/:sessionId/template-suggestions`

Uses only explicit saved reviewer comments from the session and returns the updated session with `suggestions`.

## `POST /api/review/sessions/:sessionId/template-suggestions/:proposalId/decision` body

```json
{
  "decision": "approved"
}
```

Approving a suggestion appends it to the pending proposal queue; it does not mutate `templates/*.json`.

## `POST /api/review/sessions/:sessionId/finalize` body

```json
{
  "mode": "apply"
}
```

Returns the final category feedback payload used by the extension to apply notes into the Babel page.

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
