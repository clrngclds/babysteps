// Writes max-quality .br and .gz siblings for text assets in out/, so the server doesn't spend
// cold-start time compressing. Run after `npm run build` (the Dockerfile does this).
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { isCompressible, MIN_COMPRESS_BYTES } from './lib.mjs';

const dir = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', 'out');
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));

let n = 0, raw = 0, br = 0;
for (const f of walk(dir)) {
  if (f.endsWith('.br') || f.endsWith('.gz') || !isCompressible(f)) continue;
  const body = readFileSync(f);
  if (body.length < MIN_COMPRESS_BYTES) continue;
  const b = zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length } });
  writeFileSync(`${f}.br`, b);
  writeFileSync(`${f}.gz`, zlib.gzipSync(body, { level: 9 }));
  n++; raw += body.length; br += b.length;
}
console.log(`precompressed ${n} files: ${(raw / 1024).toFixed(0)} KB -> ${(br / 1024).toFixed(0)} KB brotli`);
