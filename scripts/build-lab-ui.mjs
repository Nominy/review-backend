import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import { UI_STYLES } from '@nominy/babel-extension-frontend/ui-styles';
const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(resolve(root, 'dist'), { recursive: true });
writeFileSync(resolve(root, 'dist/lab-ui.css'), UI_STYLES);
await build({ entryPoints: [resolve(root, 'src/apps/review/templates-lab/shared-ui.js')], outfile: resolve(root, 'dist/lab-ui.js'), bundle: true, format: 'esm', minify: true });
