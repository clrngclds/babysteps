// baby steps web server (SDD §5.5): static export + catalog from the private content bucket +
// anonymous visit counter. Node built-ins only. Google APIs are called over REST with a token from
// the Cloud Run metadata server (the service's attached service account; no keys).
import http from 'node:http';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import {
  cacheControl, contentType, csp, etagOf, inlineScriptHashes, isCatalogPath, isCompressible,
  MIN_COMPRESS_BYTES, pickEncoding, resolveStatic, SECURITY_HEADERS, sgDate, validateVisit,
} from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const STATIC_DIR = process.env.STATIC_DIR || join(HERE, '..', 'out');
const BUCKET = process.env.CONTENT_BUCKET || '';
const BQ_DATASET = process.env.BQ_DATASET || 'babysteps';
const BQ_TABLE = process.env.BQ_TABLE || 'visits';
let PROJECT = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || '';

const LATEST = '/catalog/latest.json';
const LATEST_TTL_MS = 30_000; // how quickly a newly published catalog version is picked up
const MISS_TTL_MS = 30_000;
const ERROR_TTL_MS = 10_000;
const CATALOG_CACHE_MAX = 500; // entries; a catalog version is ~41 files
const MAX_VISIT_BODY = 256;

const log = (severity, message, extra = {}) =>
  process.stdout.write(JSON.stringify({ severity, message, ...extra }) + '\n');

/* ------------------------------------------------------------------ */
/* Static files: loaded into memory at startup (the export is ~3 MB). */
/* ------------------------------------------------------------------ */

function makeEntry(urlPath, body, { br, gz } = {}, fast = false) {
  const type = contentType(urlPath);
  const entry = { body, type, etag: etagOf(body), cache: cacheControl(urlPath), br: null, gzip: null, csp: null };
  if (isCompressible(urlPath) && body.length >= MIN_COMPRESS_BYTES) {
    entry.br = br ?? zlib.brotliCompressSync(body, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: fast ? 5 : 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length },
    });
    entry.gzip = gz ?? zlib.gzipSync(body, { level: fast ? 6 : 9 });
    entry.compressible = true;
  } else if (isCompressible(urlPath)) {
    entry.compressible = true;
  }
  if (type.startsWith('text/html')) entry.csp = csp(inlineScriptHashes(body.toString('utf8')));
  return entry;
}

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = new Map(); // url path (e.g. /milestones/index.html) -> entry
function loadStatic() {
  if (!existsSync(STATIC_DIR)) throw new Error(`static dir not found: ${STATIC_DIR} (run npm run build)`);
  const t0 = Date.now();
  for (const abs of walk(STATIC_DIR)) {
    if (abs.endsWith('.br') || abs.endsWith('.gz')) continue; // precompressed siblings (server/precompress.mjs)
    const urlPath = '/' + relative(STATIC_DIR, abs).split(sep).join('/');
    const read = (p) => (existsSync(p) ? readFileSync(p) : undefined);
    files.set(urlPath, makeEntry(urlPath, readFileSync(abs), { br: read(`${abs}.br`), gz: read(`${abs}.gz`) }, true));
  }
  log('INFO', `loaded ${files.size} static files in ${Date.now() - t0} ms`, { bucket: BUCKET || null });
}

/* ------------------------------------------------------------------ */
/* Google APIs over REST with the service's own identity.             */
/* ------------------------------------------------------------------ */

const METADATA = 'http://metadata.google.internal/computeMetadata/v1';
let token = null;
let tokenPromise = null;

async function accessToken() {
  if (process.env.GOOGLE_OAUTH_ACCESS_TOKEN) return process.env.GOOGLE_OAUTH_ACCESS_TOKEN; // local testing only
  if (token && token.exp > Date.now() + 60_000) return token.value;
  tokenPromise ??= (async () => {
    try {
      const r = await fetch(`${METADATA}/instance/service-accounts/default/token`, {
        headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(2000),
      });
      if (!r.ok) throw new Error(`metadata token ${r.status}`);
      const j = await r.json();
      token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
      return token.value;
    } finally {
      tokenPromise = null;
    }
  })();
  return tokenPromise;
}

async function projectId() {
  if (PROJECT) return PROJECT;
  const r = await fetch(`${METADATA}/project/project-id`, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(2000) });
  if (!r.ok) throw new Error(`metadata project ${r.status}`);
  PROJECT = await r.text();
  return PROJECT;
}

/** Object bytes, or null if the object doesn't exist. Throws on any other failure. */
async function gcsRead(name) {
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(BUCKET)}/o/${encodeURIComponent(name)}?alt=media`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(4000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`gcs ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function insertVisit(row) {
  const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${await projectId()}/datasets/${BQ_DATASET}/tables/${BQ_TABLE}/insertAll`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'bigquery#tableDataInsertAllRequest', rows: [{ json: row }] }),
    signal: AbortSignal.timeout(5000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.insertErrors) throw new Error(`bigquery insertAll ${r.status} ${JSON.stringify(j.insertErrors || j.error?.message || '')}`);
}

/* ------------------------------------------------------------------ */
/* Catalog: bucket first, small in-memory cache, baked copy fallback.  */
/* ------------------------------------------------------------------ */

const catalogCache = new Map(); // url path -> { entry, expires, fromBucket }
const inflight = new Map();
let lastBucketError = 0;

function cachePut(key, value) {
  catalogCache.delete(key);
  catalogCache.set(key, value);
  while (catalogCache.size > CATALOG_CACHE_MAX) catalogCache.delete(catalogCache.keys().next().value);
}

async function catalogEntry(urlPath) {
  const baked = files.get(urlPath) || null;
  if (!BUCKET) return baked;
  const hit = catalogCache.get(urlPath);
  if (hit && hit.expires > Date.now()) {
    catalogCache.delete(urlPath);
    catalogCache.set(urlPath, hit); // LRU touch
    return hit.entry;
  }
  if (inflight.has(urlPath)) return inflight.get(urlPath);
  const job = (async () => {
    try {
      const body = await gcsRead(urlPath.slice(1));
      if (body) {
        const entry = makeEntry(urlPath, body, {}, true);
        cachePut(urlPath, { entry, expires: urlPath === LATEST ? Date.now() + LATEST_TTL_MS : Infinity, fromBucket: true });
        return entry;
      }
      cachePut(urlPath, { entry: baked, expires: Date.now() + MISS_TTL_MS, fromBucket: false });
      return baked;
    } catch (e) {
      if (Date.now() - lastBucketError > 60_000) {
        lastBucketError = Date.now();
        log('WARNING', 'catalog bucket read failed; serving cached or baked copy', { error: String(e.message || e) });
      }
      // Prefer the last copy we had from the bucket (it may be newer than the image), then the baked one.
      const entry = hit?.fromBucket ? hit.entry : baked;
      cachePut(urlPath, { entry, expires: Date.now() + ERROR_TTL_MS, fromBucket: Boolean(hit?.fromBucket) });
      return entry;
    } finally {
      inflight.delete(urlPath);
    }
  })();
  inflight.set(urlPath, job);
  return job;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

const BASE_CSP = csp();

function baseHeaders(extra = {}) {
  return { ...SECURITY_HEADERS, 'content-security-policy': BASE_CSP, ...extra };
}

function sendEntry(req, res, entry, status = 200, cacheOverride) {
  const headers = baseHeaders({
    'content-type': entry.type,
    'cache-control': cacheOverride || entry.cache,
    etag: entry.etag,
  });
  if (entry.csp) headers['content-security-policy'] = entry.csp;
  if (entry.compressible) headers.vary = 'Accept-Encoding';
  if (status === 200) {
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === entry.etag)) {
      res.writeHead(304, headers);
      return res.end();
    }
  }
  const enc = pickEncoding(req.headers['accept-encoding'], { br: Boolean(entry.br), gzip: Boolean(entry.gzip) });
  const body = enc === 'br' ? entry.br : enc === 'gzip' ? entry.gzip : entry.body;
  if (enc) headers['content-encoding'] = enc;
  headers['content-length'] = body.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendText(res, status, text, extra = {}) {
  const body = Buffer.from(text);
  res.writeHead(status, baseHeaders({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-length': body.length, ...extra }));
  res.end(body);
}

function notFound(req, res) {
  const page = files.get('/404.html');
  if (page) return sendEntry(req, res, page, 404, 'no-cache');
  return sendText(res, 404, 'Not found');
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleVisit(req, res) {
  if (req.method !== 'POST') return sendText(res, 405, 'Method not allowed', { allow: 'POST' });
  const ctype = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ctype !== 'application/json') return sendText(res, 415, 'Unsupported media type');
  // Same-origin only. Browsers always send Origin on POST; reject other sites' pages.
  const origin = req.headers.origin;
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch { /* invalid */ }
    if (host !== req.headers.host) return sendText(res, 403, 'Forbidden');
  }
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_VISIT_BODY) return sendText(res, 413, 'Payload too large', { connection: 'close' });
  let raw;
  try {
    raw = await readBody(req, MAX_VISIT_BODY);
  } catch (e) {
    return sendText(res, e.status || 400, 'Bad request', { connection: 'close' });
  }
  const v = validateVisit(raw);
  if (!v) return sendText(res, 400, 'Bad request');
  // One row: Singapore date + the two flags. No IP, user agent, ID or anything else.
  try {
    await insertVisit({ date: sgDate(), day_first: v.day_first, month_first: v.month_first });
  } catch (e) {
    log('ERROR', 'visit insert failed', { error: String(e.message || e) });
    return sendText(res, 503, 'Unavailable');
  }
  res.writeHead(204, baseHeaders({ 'cache-control': 'no-store' }));
  res.end();
}

async function handle(req, res) {
  let pathname;
  try {
    const u = new URL(req.url, 'http://x');
    pathname = decodeURIComponent(u.pathname);
    if (pathname.includes('\0') || pathname.includes('\\')) throw new Error('bad path');
    req.search = u.search;
  } catch {
    return sendText(res, 400, 'Bad request');
  }

  if (pathname === '/healthz' || pathname === '/health') return sendText(res, 200, 'ok');
  if (pathname === '/api/visit') return handleVisit(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed', { allow: 'GET, HEAD' });

  if (pathname.startsWith('/catalog/')) {
    if (!isCatalogPath(pathname)) return notFound(req, res);
    const entry = await catalogEntry(pathname);
    return entry ? sendEntry(req, res, entry) : notFound(req, res);
  }

  const r = resolveStatic(pathname, (k) => files.has(k));
  if (!r) return notFound(req, res);
  if (r.redirect) {
    res.writeHead(308, baseHeaders({ location: r.redirect + (req.search || ''), 'cache-control': 'no-cache', 'content-length': 0 }));
    return res.end();
  }
  return sendEntry(req, res, files.get(r.file), 200, cacheControl(pathname.endsWith('/') ? pathname : r.file));
}

loadStatic();
const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    log('ERROR', 'unhandled', { error: String(e?.stack || e) });
    if (!res.headersSent) sendText(res, 500, 'Internal error');
    else res.destroy();
  });
});
server.keepAliveTimeout = 65_000;
server.listen(PORT, () => log('INFO', `listening on ${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
