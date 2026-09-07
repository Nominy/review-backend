# Review Lab

Review Lab uses the shared Babel frontend components and Review Helper orange theme. `npm run build:lab:ui` bundles the shared component adapter and stylesheet into `dist/lab-ui.js` and `dist/lab-ui.css`; `npm run build:lab` builds both these files and the native recreation. Include all three outputs when deploying. Local CSS owns only Lab layout and transcript geometry. Dynamically rendered templates, task cards, and results receive the same shared controls. The embedded native Babel editor retains its own presentation.

Open /templates-lab on the Review backend and authenticate with TEMPLATES_LAB_USERNAME / TEMPLATES_LAB_PASSWORD. The existing URL and template CRUD, CSV import/export, and pending suggestions remain available.

Rules & grading guide opens the bundled `babel-rules` source documents and the exact scoring caps used by the grader. The interface stays English; model instructions, source rules, and feedback explanations are Russian. Both workflows treat the revised L2 transcript as ground truth and explain L1 → L2 corrections without sending audio to the model. Playback remains available for human inspection. The default backend model is `google/gemini-3.7-flash` (an explicit `OPENROUTER_MODEL` overrides it).

Refresh the source snapshot with `node scripts/import-review-guidelines.mjs C:/path/to/babel-rules`. The imported documents include their source, revision, and update date and are bundled for deployment; no sibling checkout is required at runtime. `node scripts/refresh-review-templates.mjs <template-directory>` applies the current targeted template corrections, preserving IDs and backing up changed files under `data/guideline-migration-backups`. Existing custom system prompts remain editable; the shared L2-ground-truth and attribution contract is appended to both actual requests and full prompt previews. The current rule corpus is included in both workflows even with a custom prompt.

The home screen lists the last ten distinct unpinned tasks with generated feedback, generated grades, applied reviews, or submitted reviews. It reads ANALYTICS_LOG_PATH, skips intermediate session events and deduplicates before limiting. No sample tasks are inserted into real history. The grader now emits review_graded structured log events into the same server stdout stream; the deployed process manager must capture it at ANALYTICS_LOG_PATH as for other review events.

Open a task for a full-screen workspace:
- Babel editor: the existing captured Babel workbench, hosted with a read-only archive adapter.
- Transcript: archived text and segment timing by recording track.
- Diff view: complete text differences by track, plus model evidence and structural changes from the review metrics engine.
- Templates: the existing editor moves into the workspace, retaining unsaved drafts and pending proposals.
- Model prompt: separate classifier and grader system instructions, full input preview, test run, defaults, reload, and save.

This is an archive reconstruction from normalized snapshots. New Review Helper snapshots preserve recording source URIs and playable CDN URLs. Native waveform playback and standard audio controls use these saved links. Older snapshots without URLs retain text-only viewing. The Babel editor tab embeds that existing recovered runtime. Its source snapshot and captured factories remain unchanged: the Lab build verifies and materializes the snapshot into a temporary directory and extends only the temporary host adapters. The native player is shown when saved audio links are available and hidden otherwise. No replacement audio is generated.

Inspect full prompt does not call a model. Test on this task calls the configured OpenRouter model with the current prompt draft and (for classification) template draft, validates its output, and leaves both archived results and live settings unchanged. Grades retain the server's evidence caps and 1–3 scale. The saved review result remains alongside the new test result. Test results are ephemeral and do not create new recent-task entries.

Save prompts activates system instructions for future Review Helper classifications and Review Grader calls. Settings persist at data/prompt-lab/prompts.json (override with PROMPT_SETTINGS_PATH); atomic replacement and revision checks prevent overwriting another editor's saves. Save template draft persists templates independently. Unsaved prompt drafts survive closing and reopening the overlay in the same page; page navigation warns about unsaved edits.

TEMPLATE_REGISTRY_DIR optionally selects an isolated template directory; a missing directory is initialized from defaults. Existing directories are preserved. Tests use this setting so they cannot change the live template registry.

Validation: npm test; npm run typecheck; npm run test:lab:browser. The browser check requires the sibling shared/babel-extension-platform dependencies and a Playwright Chromium installation. It runs an isolated temporary backend with synthetic snapshots, checks template and prompt saves, prompt inspection, result rendering, mobile layout and reopening, and saves frontend-preview/review-lab.png. Model output is explicitly stubbed in this check; no paid calls are made.

Build the embedded editor with npm run build:lab before deployment and include dist/recreation with the backend. The build requires the sibling shared/babel-extension-platform recreation dependencies to be installed. It verifies the pinned fixture checksums, typechecks the archive host, and bundles the editor locally. Without these built assets, the archive transcript, diff, templates, and prompt tools still work; the native tab reports missing assets.

Pinning holds a snapshot in a separate Pinned section and excludes that action from the ten-task queue. The queue backfills with older unpinned tasks. Unpinning restores chronological eligibility; tasks older than the latest ten may fall outside the visible queue. Pins persist on the backend in data/prompt-lab/pinned-tasks.json (override LAB_PINS_PATH), including the captured task so it remains usable after history-log rotation. Pinning does not change anything in Babel.

Recording capture: Review Helper preserves processedRecordingUrl, processedRecordingUri and chunkedProcessedRecordingId. For source URIs it calls Babel's existing same-origin application.getAudioPresignedUrls API, with a three-second deadline; a failed lookup preserves transcript capture and any direct URL already available. URLs are loaded directly by the browser, not proxied by the backend. A CDN link may expire; revisit the task in Babel and capture it again to obtain a fresh link. Reload the rebuilt Review Helper extension before capturing new tasks.

## User OpenRouter keys

Install/reload Review Helper and refresh the Lab. Its OpenRouter panel shares a
key with Babel and extension options in the same browser profile. Model replays
use the extension bridge; preview-only requests remain local to the backend.
The raw key is never returned to the Lab page bridge, put into request JSON, or
stored in task history. HTTP Basic Lab authentication is preserved separately.
The usage panel reads `GET /api/review/key-usage` using the supplied header key;
null limits mean no per-key cap, not zero account credits. The backend does not
persist these keys or change its global configuration for individual requests.
