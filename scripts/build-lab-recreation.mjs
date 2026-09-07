import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync, lstatSync, symlinkSync, unlinkSync } from 'node:fs';
const root = fileURLToPath(new URL('../', import.meta.url));
const shared = resolve(root, '../../shared/babel-extension-platform/packages/babel-extension-e2e');
const app = resolve(shared, 'fixtures/recreation/app');
const output = resolve(root, 'dist/recreation');
for (const directory of [resolve(root, 'dist'), output]) if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error('Refusing linked build output');
if (!output.startsWith(resolve(root, 'dist') + sep)) throw new Error('Unsafe recreation output path');
const cache = resolve(root, 'tmp');
mkdirSync(cache, { recursive: true });
const stage = mkdtempSync(resolve(cache, 'review-lab-'));
if (!stage.startsWith(cache + sep)) throw new Error('Unsafe staging path');
function patch(file, before, after) {
  const path = resolve(stage, file), text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  if (!text.includes(before)) throw new Error('Captured host contract changed: ' + file);
  writeFileSync(path, text.replace(before, after));
}
function run(script, args) {
  const result = spawnSync(process.execPath, [resolve(app, 'node_modules', script), ...args], { cwd: stage, windowsHide: true, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Recreation build failed: ' + (result.error?.message || result.status));
}
try {
  const { materializeRecreationSnapshot } = await import(pathToFileURL(resolve(shared, 'src/recreation-snapshot.mjs')));
  await materializeRecreationSnapshot({ destinationDir: stage });
  symlinkSync(resolve(app, 'node_modules'), resolve(stage, 'node_modules'), 'junction');
  for (const [source, target] of [['archive.html', 'archive.html'], ['archive-main.tsx', 'src/archive-main.tsx'], ['archive.css', 'src/archive.css'], ['archive-client.ts', 'src/recovered/archive-client.ts']]) copyFileSync(resolve(root, 'scripts/lab-recreation', source), resolve(stage, target));
  // Only host adapters in the temporary build are extended. Captured factories and the fixture remain unchanged.
  patch('src/recovered/scenario-client.ts', 'export async function loadScenario(signal?: AbortSignal): Promise<ScenarioState> {',
    'type ScenarioTransport = { load(signal?: AbortSignal): Promise<ScenarioState>; request(procedure: string, input: unknown, method: string, signal?: AbortSignal): Promise<unknown> };\nlet hostTransport: ScenarioTransport | null = null;\nexport function setScenarioTransport(transport: ScenarioTransport) { hostTransport = transport; }\nexport async function loadScenario(signal?: AbortSignal): Promise<ScenarioState> {\n  if (hostTransport) return hostTransport.load(signal);');
  patch('src/recovered/scenario-client.ts', '  const payload = JSON.stringify({ json: input ?? null });', '  if (hostTransport) return await hostTransport.request(procedure, input, method, signal) as T;\n  const payload = JSON.stringify({ json: input ?? null });');
  patch('src/recovered/RecoveredBabelApp.tsx', '  const { RecoveredPageController: PageController } = native.editor;', '  const { RecoveredPageController: PageController, RecoveredEditorWorkbench: Workbench } = native.editor;');
  patch('src/recovered/RecoveredBabelApp.tsx', '{pathname === "/projects" ? <ProjectsRoute scenario={scenario} />', '{scenario.scenario === "archive" ? <Workbench {...scenario.archiveWorkbenchProps as Record<string, unknown>} /> : pathname === "/projects" ? <ProjectsRoute scenario={scenario} />');
  const configuration = resolve(stage, 'vite.archive.config.mjs');
  writeFileSync(configuration, 'export default { base: "/templates-lab/recreation/", build: { rollupOptions: { input: "archive.html" } } };');
  run('typescript/bin/tsc', ['--noEmit']);
  run('vite/bin/vite.js', ['build', '--config', configuration, '--outDir', output, '--emptyOutDir']);
} finally {
  const link = resolve(stage, 'node_modules');
  if (existsSync(link) && lstatSync(link).isSymbolicLink()) unlinkSync(link);
  rmSync(stage, { recursive: true, force: true });
}
