import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(process.argv[2] || resolve(root, '../../../babel-rules'));
const rules = readdirSync(resolve(source, 'rules')).filter(name => name.endsWith('.md')).sort().map(file => {
  const raw = readFileSync(resolve(source, 'rules', file), 'utf8').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) throw new Error('Missing rule metadata: ' + file);
  const meta = Object.fromEntries(match[1].split('\n').map(line => { const i = line.indexOf(':'); return [line.slice(0, i), line.slice(i + 1).trim()]; }));
  return { slug: meta.slug, title: meta.title, section: meta.section, source: meta.source, updated: meta.updated, revision: Number(meta.rev), text: match[2].trim(), file: 'rules/' + file };
});
// The webinar contains an explicit no-penalty clarification absent from the split rule cards.
const webinarFile = 'Итоги вебинара 03_06_2026.md';
const webinar = readFileSync(resolve(source, webinarFile), 'utf8').split(/\r?\n/).filter(line => !/^\[image\d+\]:/.test(line)).join('\n').trim();
rules.push({ slug: 'уточнения-вебинара-2026-06-03', title: 'Уточнения вебинара: уверенность и комментарии L1', section: 'уточнения', source: webinarFile, updated: '2026-06-03', revision: 1, text: webinar, file: webinarFile });
const revision = createHash('sha256').update(JSON.stringify(rules)).digest('hex').slice(0, 16);
mkdirSync(resolve(root, 'src/guidelines'), { recursive: true });
writeFileSync(resolve(root, 'src/guidelines/source.json'), JSON.stringify({ source: basename(source), revision, rules }, null, 2) + '\n');
console.log(`Imported ${rules.length} rules, revision ${revision}.`);
