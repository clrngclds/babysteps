// Pure helpers for the baby steps web server (SDD §5.5). No I/O here, so they can be unit-tested.
import { createHash } from 'node:crypto';
import { extname } from 'node:path';

export const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // Next static export serves RSC payloads as .txt; the client router expects text/plain in export mode.
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

export const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.txt', '.webmanifest', '.map', '.svg']);
export const MIN_COMPRESS_BYTES = 1024;

export function contentType(path) {
  return TYPES[extname(path).toLowerCase()] || 'application/octet-stream';
}

export function isCompressible(path) {
  return COMPRESSIBLE.has(extname(path).toLowerCase());
}

export const IMMUTABLE = 'public, max-age=31536000, immutable';
const LONG = 'public, max-age=2592000'; // 30 days: fonts and icons outside the hashed /_next/static tree
const SHORT = 'public, max-age=3600';

/** Cache-Control for a URL path (the path that was requested, not the file on disk). */
export function cacheControl(urlPath) {
  if (urlPath.startsWith('/_next/static/')) return IMMUTABLE;
  if (/^\/catalog\/v\d+\//.test(urlPath)) return IMMUTABLE;
  if (urlPath === '/catalog/latest.json') return 'no-cache';
  if (urlPath === '/sw.js') return 'no-cache';
  const ext = extname(urlPath).toLowerCase();
  if (urlPath.endsWith('/') || ext === '.html') return 'no-cache';
  if (['.woff2', '.woff', '.ttf'].includes(ext)) return LONG;
  if (urlPath.startsWith('/icons/') || ['.png', '.svg', '.ico', '.jpg', '.jpeg', '.webp'].includes(ext)) return LONG;
  // RSC payloads (index.txt) and the manifest are not content-hashed.
  if (ext === '.txt' || ext === '.webmanifest') return 'no-cache';
  return SHORT;
}

/** Catalog paths that may be read from the content bucket. Anything else under /catalog/ is a 404. */
const CATALOG_RE = /^\/catalog\/(?:latest\.json|v[1-9]\d{0,5}\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.json)$/;
export function isCatalogPath(urlPath) {
  return CATALOG_RE.test(urlPath);
}

/**
 * Map a request path to a static file key, following Next's `trailingSlash: true` export layout:
 *   /            -> /index.html
 *   /milestones/ -> /milestones/index.html
 *   /milestones  -> 308 redirect to /milestones/
 *   /sw.js       -> /sw.js
 * `has` tells whether a file key exists. Returns { file } | { redirect } | null.
 */
export function resolveStatic(urlPath, has) {
  if (urlPath.endsWith('/')) {
    const key = `${urlPath}index.html`;
    return has(key) ? { file: key } : null;
  }
  if (has(urlPath)) return { file: urlPath };
  if (has(`${urlPath}/index.html`)) return { redirect: `${urlPath}/` };
  return null;
}

/**
 * Last Singapore date (inclusive) on which the old 2-field body {day_first, month_first} is still
 * accepted. Clients cached by the service worker before week_first was added (deployed 2026-10-19)
 * keep sending it for a while; after this date it is rejected like any other body.
 */
export const LEGACY_VISIT_BODY_UNTIL = '2026-11-02';

/**
 * Strict validation for POST /api/visit. Accepts exactly {day_first, month_first, week_first}, all
 * booleans, or (until LEGACY_VISIT_BODY_UNTIL) exactly {day_first, month_first}. Anything else -> null.
 * The legacy form returns no week_first, so the row stores NULL for it.
 */
export function validateVisit(raw, { today = sgDate(), legacyUntil = LEGACY_VISIT_BODY_UNTIL } = {}) {
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const keys = Object.keys(v).sort().join(',');
  if (keys === 'day_first,month_first,week_first') {
    if (typeof v.day_first !== 'boolean' || typeof v.month_first !== 'boolean' || typeof v.week_first !== 'boolean') return null;
    return { day_first: v.day_first, month_first: v.month_first, week_first: v.week_first };
  }
  if (keys === 'day_first,month_first' && today <= legacyUntil) {
    if (typeof v.day_first !== 'boolean' || typeof v.month_first !== 'boolean') return null;
    return { day_first: v.day_first, month_first: v.month_first };
  }
  return null;
}

/** The BigQuery row for a validated visit: Singapore date + the flags. Nothing else. */
export function visitRow(v, date) {
  const row = { date, day_first: v.day_first, month_first: v.month_first };
  if (typeof v.week_first === 'boolean') row.week_first = v.week_first;
  return row;
}

/** Calendar date in Asia/Singapore as YYYY-MM-DD. */
export function sgDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** sha256 CSP source expressions for every inline <script> in an HTML document. */
export function inlineScriptHashes(html) {
  const out = new Set();
  const re = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[1].length === 0) continue;
    out.add(`'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  }
  return [...out];
}

/**
 * Content-Security-Policy: same origin only, no third parties. Next's static export inlines its
 * bootstrap scripts, so each HTML page gets the hashes of its own inline scripts instead of
 * 'unsafe-inline'. The prerendered skeletons use style="" attributes, hence style-src-attr.
 */
export function csp(scriptHashes = []) {
  return [
    "default-src 'self'",
    `script-src 'self'${scriptHashes.length ? ' ' + scriptHashes.join(' ') : ''}`,
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'cross-origin-opener-policy': 'same-origin',
};

/** Pick a content encoding from Accept-Encoding: 'br', 'gzip' or null. */
export function pickEncoding(header, have) {
  if (!header) return null;
  const accepted = new Map();
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    let q = 1;
    for (const p of params) {
      const [k, val] = p.trim().split('=');
      if (k === 'q') q = Number(val);
    }
    if (name) accepted.set(name, Number.isFinite(q) ? q : 0);
  }
  const ok = (n) => (accepted.has(n) ? accepted.get(n) > 0 : accepted.has('*') && accepted.get('*') > 0);
  if (have.br && ok('br')) return 'br';
  if (have.gzip && ok('gzip')) return 'gzip';
  return null;
}

export function etagOf(buf) {
  return `"${createHash('sha1').update(buf).digest('base64url').slice(0, 22)}"`;
}
