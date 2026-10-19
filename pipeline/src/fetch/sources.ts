/**
 * Loads and validates pipeline/sources.yaml, and answers "which source owns this URL?"
 * (used by G3 and by tier-2 resolution).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { PHILOSOPHY } from '../../../scripts/catalog-lib';
import type { SourceConfig, SourcesFile } from '../types';

const SOURCE_KEYS = new Set([
  'id', 'name', 'tier', 'kind', 'detection', 'urls', 'domains', 'include', 'exclude', 'keywords',
  'child_sitemaps', 'track_lastmod', 'philosophy', 'max_items_per_run', 'frequency', 'enabled', 'notes',
]);
const FILE_KEYS = new Set(['version', 'official_domains', 'sources']);
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Hostname, lowercased, without a leading "www.". "" if the URL is invalid. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

const normDomain = (d: string) => d.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');

/** Case-insensitive regexes, as documented in sources.yaml. */
export function compilePatterns(patterns: string[] | undefined): RegExp[] {
  return (patterns ?? []).map((p) => new RegExp(p, 'i'));
}

/** Parse and validate; throws one Error listing every problem found. */
export function parseSources(yamlText: string): SourcesFile {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (e) {
    throw new Error(`sources.yaml: invalid YAML: ${(e as Error).message}`);
  }
  const errors: string[] = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('sources.yaml: top level must be a mapping');
  const d = doc as Record<string, unknown>;

  for (const k of Object.keys(d)) if (!FILE_KEYS.has(k)) errors.push(`unknown top-level key "${k}"`);
  if (typeof d.version !== 'number') errors.push('version must be a number');

  let official: string[] | undefined;
  if (d.official_domains !== undefined) {
    if (!isStringArray(d.official_domains)) errors.push('official_domains must be a list of hostnames');
    else {
      official = d.official_domains.map(normDomain);
      for (const h of official) if (!HOST_RE.test(h)) errors.push(`official_domains: "${h}" is not a hostname`);
    }
  }

  if (!Array.isArray(d.sources) || d.sources.length === 0) {
    errors.push('sources must be a non-empty list');
    throw new Error('sources.yaml is invalid:\n  - ' + errors.join('\n  - '));
  }

  const ids = new Set<string>();
  const sources: SourceConfig[] = [];
  d.sources.forEach((raw: unknown, i: number) => {
    const where = (s: Record<string, unknown>) => `source #${i + 1}${typeof s.id === 'string' ? ` (${s.id})` : ''}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`source #${i + 1}: must be a mapping`);
      return;
    }
    const s = raw as Record<string, unknown>;
    const at = where(s);
    const err = (m: string) => errors.push(`${at}: ${m}`);

    for (const k of Object.keys(s)) if (!SOURCE_KEYS.has(k)) err(`unknown field "${k}"`);
    if (typeof s.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(s.id)) err('id must be lowercase letters, digits and dashes');
    else if (ids.has(s.id)) err(`duplicate id "${s.id}"`);
    else ids.add(s.id);
    if (typeof s.name !== 'string' || !s.name.trim()) err('name is required');
    if (s.tier !== 1 && s.tier !== 2) err('tier must be 1 or 2');
    if (s.kind !== 'activity' && s.kind !== 'outing') err('kind must be activity or outing');
    if (s.detection !== 'feed' && s.detection !== 'sitemap' && s.detection !== 'listing') err('detection must be feed, sitemap or listing');

    if (!isStringArray(s.urls) || s.urls.length === 0) err('urls must be a non-empty list');
    else for (const u of s.urls) if (!/^https?:\/\//i.test(u) || !hostOf(u)) err(`invalid url "${u}"`);

    if (!isStringArray(s.domains) || s.domains.length === 0) err('domains must be a non-empty list');
    else for (const h of s.domains) if (!HOST_RE.test(normDomain(h))) err(`domains: "${h}" is not a hostname`);

    for (const key of ['include', 'exclude', 'child_sitemaps'] as const) {
      const v = s[key];
      if (v === undefined) continue;
      if (!isStringArray(v)) {
        err(`${key} must be a list of regexes`);
        continue;
      }
      for (const p of v) {
        try {
          new RegExp(p, 'i');
        } catch (e) {
          err(`${key}: bad regex ${JSON.stringify(p)} (${(e as Error).message})`);
        }
      }
    }
    if (s.child_sitemaps !== undefined && s.detection !== 'sitemap') err('child_sitemaps only applies to sitemap sources');
    if (s.track_lastmod !== undefined && typeof s.track_lastmod !== 'boolean') err('track_lastmod must be true or false');
    if (s.keywords !== undefined && (!isStringArray(s.keywords) || s.keywords.some((k) => !k.trim()))) err('keywords must be a list of words');
    if (s.philosophy !== undefined) {
      if (!isStringArray(s.philosophy)) err('philosophy must be a list');
      else for (const p of s.philosophy) if (!PHILOSOPHY.includes(p)) err(`philosophy "${p}" is not one of ${PHILOSOPHY.join(', ')}`);
    }
    if (s.max_items_per_run !== undefined && !(Number.isInteger(s.max_items_per_run) && (s.max_items_per_run as number) > 0)) {
      err('max_items_per_run must be a positive whole number');
    }
    if (s.frequency !== undefined && s.frequency !== 'weekly' && s.frequency !== 'monthly') err('frequency must be weekly or monthly');
    if (s.enabled !== undefined && typeof s.enabled !== 'boolean') err('enabled must be true or false');
    if (s.notes !== undefined && typeof s.notes !== 'string') err('notes must be text');

    const src = { ...s } as unknown as SourceConfig;
    if (isStringArray(s.domains)) src.domains = s.domains.map(normDomain);
    sources.push(src);
  });

  if (errors.length) throw new Error('sources.yaml is invalid:\n  - ' + errors.join('\n  - '));
  return { version: d.version as number, ...(official ? { official_domains: official } : {}), sources };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Default: pipeline/sources.yaml under the working directory, else next to this module
 * (pipeline/src/fetch -> pipeline/), so it works from the repo root and from a bundle.
 */
export function loadSourcesFile(path?: string): SourcesFile {
  const candidates: string[] = [];
  if (path) candidates.push(isAbsolute(path) ? path : resolve(process.cwd(), path));
  else {
    candidates.push(resolve(process.cwd(), 'pipeline/sources.yaml'));
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      candidates.push(resolve(here, '../../sources.yaml'), resolve(here, 'sources.yaml'), resolve(here, '../sources.yaml'));
    } catch {
      // import.meta.url unavailable (CJS bundle); cwd candidate only.
    }
  }
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`sources.yaml not found (looked in: ${candidates.join(', ')})`);
  return parseSources(readFileSync(found, 'utf8'));
}

const hostMatches = (host: string, domain: string) => host === domain || host.endsWith('.' + domain);

/** Every domain of every tier-1 source (disabled ones included: they are still official). */
export function tier1Domains(sf: SourcesFile): string[] {
  const out = new Set<string>();
  for (const s of sf.sources) if (s.tier === 1) for (const d of s.domains) out.add(normDomain(d));
  return [...out];
}

/** The tier-1 source owning the URL's host (subdomains match; the most specific domain wins). */
export function sourceForUrl(sf: SourcesFile, url: string): SourceConfig | undefined {
  const host = hostOf(url);
  if (!host) return undefined;
  let best: SourceConfig | undefined;
  let bestLen = 0;
  for (const s of sf.sources) {
    if (s.tier !== 1) continue;
    for (const d of s.domains) {
      const dom = normDomain(d);
      if (hostMatches(host, dom) && dom.length > bestLen) {
        best = s;
        bestLen = dom.length;
      }
    }
  }
  return best;
}

/** True if the URL is on a tier-1 source domain or in official_domains. */
export function isOfficialUrl(sf: SourcesFile, url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (sourceForUrl(sf, url)) return true;
  return (sf.official_domains ?? []).some((d) => hostMatches(host, normDomain(d)));
}
