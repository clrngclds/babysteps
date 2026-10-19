/**
 * Auto-publish and rollback (SDD §8.5, §6.5; contract in deploy/README.md):
 *   1. validate the merged content (G9, strict coverage) with scripts/catalog-lib.ts
 *   2. build catalog/v{N+1}/ with the same lib and upload every file
 *   3. overwrite catalog/latest.json (generation precondition, so two writers can't race)
 *   4. health-check the live site; if it fails, put the previous latest.json back
 */
import { buildCatalog, validate, type RawData } from '../../../scripts/catalog-lib';
import type { Bucket } from '../gcp/storage';
import { writeJson } from '../gcp/storage';
import type { ContentSet } from '../types';
import { PATHS } from '../content/store';

export interface LatestPointer {
  version: number;
  published_at: string;
  path: string;
}

export interface HealthCheckOptions {
  siteUrl: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for instances to pick up the new latest.json (server caches it for 30 s). */
  timeoutMs?: number;
  pollMs?: number;
}

export interface HealthResult {
  ok: boolean;
  checks: string[];
  error?: string;
}

export interface PublishResult {
  ok: boolean;
  version: number | null;
  previous: number | null;
  rolledBack: boolean;
  errors: string[];
  files: number;
  counts?: { activities: number; milestones: number; outings: number };
}

export async function readLatest(b: Bucket): Promise<{ pointer: LatestPointer; generation: string } | null> {
  const o = await b.read(PATHS.latest);
  return o ? { pointer: JSON.parse(o.body) as LatestPointer, generation: o.generation } : null;
}

/** Highest N with any object under catalog/v{N}/ (a half-written version is never reused). */
export async function maxStoredVersion(b: Bucket): Promise<number> {
  const names = await b.list('catalog/v');
  let max = 0;
  for (const n of names) {
    const m = /^catalog\/v(\d+)\//.exec(n);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

export function toRaw(c: ContentSet): RawData {
  return { activities: c.activities, milestones: c.milestones, outings: c.outings };
}

/** G9: full catalog validation of the merged content. */
export function validateForPublish(c: ContentSet) {
  return validate(toRaw(c), { strictPublishedCoverage: true });
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Live-site health check: /health is 200, /catalog/latest.json reports `version`, and files of that
 * version load and parse with the expected counts.
 */
export async function healthCheck(
  version: number,
  expect: { activities: number; outings: number },
  opts: HealthCheckOptions,
): Promise<HealthResult> {
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  const checks: string[] = [];
  const get = async (path: string) => {
    const r = await f(`${opts.siteUrl}${path}`, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(15_000) });
    return r;
  };
  try {
    const h = await get('/health');
    if (!h.ok) return { ok: false, checks, error: `/health returned ${h.status}` };
    checks.push('/health 200');

    let seen = -1;
    for (;;) {
      const r = await get(`/catalog/latest.json?ts=${Date.now()}`);
      if (r.ok) {
        const j = (await r.json()) as LatestPointer;
        seen = j.version;
        if (j.version === version) break;
      }
      if (Date.now() > deadline) return { ok: false, checks, error: `site still reports version ${seen}, expected ${version}` };
      await sleep(opts.pollMs ?? 10_000);
    }
    checks.push(`latest.json reports v${version}`);

    const acts = await get(`/catalog/v${version}/activities.json`);
    if (!acts.ok) return { ok: false, checks, error: `v${version}/activities.json returned ${acts.status}` };
    const aj = (await acts.json()) as unknown[];
    if (!Array.isArray(aj) || aj.length !== expect.activities)
      return { ok: false, checks, error: `v${version}/activities.json has ${Array.isArray(aj) ? aj.length : '?'} items, expected ${expect.activities}` };
    checks.push(`v${version}/activities.json: ${aj.length} activities`);

    const outs = await get(`/catalog/v${version}/outings.json`);
    const oj = outs.ok ? ((await outs.json()) as unknown[]) : null;
    if (!oj || oj.length !== expect.outings) return { ok: false, checks, error: `v${version}/outings.json mismatch (${outs.status})` };
    checks.push(`v${version}/outings.json: ${oj.length} outings`);

    const bm = await get(`/catalog/v${version}/by_month/00.json`);
    if (!bm.ok) return { ok: false, checks, error: `v${version}/by_month/00.json returned ${bm.status}` };
    await bm.json();
    checks.push(`v${version}/by_month/00.json loads`);
    return { ok: true, checks };
  } catch (e) {
    return { ok: false, checks, error: String((e as Error).message ?? e) };
  }
}

export interface PublishOptions {
  now?: Date;
  health: HealthCheckOptions | null; // null = skip (tests / local)
}

export async function publishCatalog(b: Bucket, content: ContentSet, opts: PublishOptions): Promise<PublishResult> {
  const v = validateForPublish(content);
  if (v.errors.length) return { ok: false, version: null, previous: null, rolledBack: false, errors: v.errors, files: 0 };

  const cur = await readLatest(b);
  const previous = cur?.pointer.version ?? 0;
  const version = Math.max(previous, await maxStoredVersion(b)) + 1;
  const built = buildCatalog(toRaw(content), version, (opts.now ?? new Date()).toISOString());

  // Upload the complete version folder first; latest.json only moves once every file is there.
  const entries = Object.entries(built.files);
  for (const [rel, value] of entries) await writeJson(b, `catalog/v${version}/${rel}`, value);
  const stored = (await b.list(`catalog/v${version}/`)).length;
  if (stored !== entries.length)
    return { ok: false, version, previous, rolledBack: false, errors: [`uploaded ${stored}/${entries.length} files`], files: stored };

  await writeJson(b, PATHS.latest, built.latest, { ifGenerationMatch: cur ? cur.generation : '0' });

  if (opts.health) {
    const h = await healthCheck(version, { activities: built.counts.activities, outings: built.counts.outings }, opts.health);
    if (!h.ok) {
      if (cur) await writeJson(b, PATHS.latest, cur.pointer);
      return {
        ok: false,
        version,
        previous,
        rolledBack: !!cur,
        errors: [`health check failed: ${h.error}`, ...h.checks],
        files: entries.length,
        counts: built.counts,
      };
    }
  }
  return { ok: true, version, previous, rolledBack: false, errors: [], files: entries.length, counts: built.counts };
}

/**
 * Repoints latest.json at an existing version (default: the one before the current).
 * Refuses versions whose folder is incomplete.
 */
export async function rollback(b: Bucket, to?: number, now = new Date()): Promise<{ from: number; to: number }> {
  const cur = await readLatest(b);
  if (!cur) throw new Error('catalog/latest.json not found');
  const from = cur.pointer.version;
  let target = to;
  if (target === undefined) {
    const versions = new Set<number>();
    for (const n of await b.list('catalog/v')) {
      const m = /^catalog\/v(\d+)\/activities\.json$/.exec(n);
      if (m) versions.add(Number(m[1]));
    }
    target = [...versions].filter((x) => x < from).sort((a, c) => c - a)[0];
    if (target === undefined) throw new Error(`no version older than v${from}`);
  }
  if (target === from) throw new Error(`latest.json already points at v${from}`);
  const needed = ['activities.json', 'milestones.json', 'outings.json', 'milestone_to_activities.json', 'by_month/00.json', 'by_month/36.json'];
  for (const f of needed) {
    if (!(await b.read(`catalog/v${target}/${f}`))) throw new Error(`catalog/v${target}/${f} is missing; refusing to roll back`);
  }
  await writeJson(
    b,
    PATHS.latest,
    { version: target, published_at: now.toISOString(), path: `catalog/v${target}/` } satisfies LatestPointer,
    { ifGenerationMatch: cur.generation },
  );
  return { from, to: target };
}
