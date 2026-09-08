# Babel Review Backend

## Install and run

Requires Bun 1.3+, Node.js 22.14+ with npm, and the shared platform at `../../shared/babel-extension-platform`. Initialize the parent checkout with `git submodule update --init --recursive` first.

From this directory:

```sh
npm --prefix ../../shared/babel-extension-platform ci
npm --prefix ../../shared/babel-extension-platform run e2e:install:recreation
bun install
cp .env.runtime.example .env.runtime
# Edit .env.runtime; replace or remove both example admin credentials.
bun run build:lab
bun run dev
```

PowerShell: use `Copy-Item .env.runtime.example .env.runtime` instead of `cp`. The app reads `.env.runtime` itself; use the scripts' `--no-env-file` Bun invocation.

- Service: `http://127.0.0.1:3001`; health: `/health`.
- Admin: `/templates-lab`, enabled only when both `TEMPLATES_LAB_USERNAME` and `TEMPLATES_LAB_PASSWORD` are set; uses HTTP Basic Auth.
- Model requests require a user OpenRouter key. A server `OPENROUTER_API_KEY` is not a fallback. Install Review Helper and save the key in its settings to run Lab model requests.
- `HOST`, `PORT`, `CORS_ALLOWED_ORIGINS`, and `OPENROUTER_MODEL` are configurable in `.env.runtime`. See `.env.runtime.example` and `.env.production.example` for deployment values. Set `OPENROUTER_TEST_MODE=true` only for deterministic local feedback without OpenRouter calls.

`build:lab` writes `dist/lab-ui.js`, `dist/lab-ui.css`, and `dist/recreation/`. Include all three outputs in deployments. `build:lab:ui` rebuilds only the shared UI assets.

## Checks

```sh
bun run typecheck
bun run test
bun run eval:smoke
npm --prefix ../../shared/babel-extension-platform run e2e:install:browser
bun run test:lab:browser
```

The browser check also needs Review Helper's dependencies installed. It runs against an isolated backend with synthetic tasks and stubbed model responses.

## Deploy

Build Lab assets before starting `bun run start`. Configure the reverse proxy with `deploy/Caddyfile` or `deploy/nginx.reviewgen.ovh.conf`; keep the backend on `127.0.0.1:3001` and allow `https://dashboard.babel.audio` in CORS.

For `.github/workflows/deploy.yml`, set repository variable `BABEL_EXTENSION_PLATFORM_REF` to the published shared-platform commit SHA containing the required package exports. The workflow requires this pin rather than a floating branch.

```sh
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 100M
pm2 set pm2-logrotate:retain 10
pm2 set pm2-logrotate:compress true
# After deploying updates:
bun run pm2:restart
```

PM2 captures stdout at `logs/pm2/review-backend.out.log` and stderr at `logs/pm2/review-backend.error.log`. `ANALYTICS_LOG_PATH` must point to the stdout file for history browsing. Keep optional analytics and raw-text retention disabled unless explicitly approved; protect admin/history credentials.

Preserve ignored `templates/` and `data/` across deployments. Missing template directories are seeded from bundled defaults; existing production edits remain local. Preserve `docs/prompts/` and `docs/reference/`, including runtime CSV reference data.

To refresh bundled rule sources: `node scripts/import-review-guidelines.mjs <babel-rules-directory>`. To apply targeted template corrections: `node scripts/refresh-review-templates.mjs <template-directory>`; backups go to `data/guideline-migration-backups`.
