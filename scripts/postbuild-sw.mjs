// Generates out/sw.js from scripts/sw-template.js with the precache lists for this build.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'out');

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(out).map((p) => '/' + relative(out, p).split('\\').join('/'));
const shell = files
  .filter((f) => !f.startsWith('/catalog/') && f !== '/sw.js' && !f.startsWith('/404') && !/\/pages\/_(app|error)/.test(f))
  .map((f) => (f.endsWith('/index.html') ? f.slice(0, -'index.html'.length) : f))
  .sort();

const latest = JSON.parse(readFileSync(join(out, 'catalog/latest.json'), 'utf8'));
const catalog = files.filter((f) => f.startsWith(`/${latest.path}`)).sort();

const hash = createHash('sha256');
for (const f of [...shell, ...catalog]) {
  const disk = f.endsWith('/') ? `${f}index.html` : f;
  hash.update(f);
  hash.update(readFileSync(join(out, disk)));
}
const build = hash.digest('hex').slice(0, 12);

const sw = readFileSync(join(root, 'scripts/sw-template.js'), 'utf8')
  .replace('__BUILD__', build)
  .replace('__PRECACHE__', JSON.stringify(shell))
  .replace('__CATALOG_PRECACHE__', JSON.stringify(catalog));
writeFileSync(join(out, 'sw.js'), sw);
console.log(`sw.js: build ${build}, ${shell.length} shell files, ${catalog.length} catalog files (v${latest.version})`);
