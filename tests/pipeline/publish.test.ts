import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryBucket, readJson, writeJson } from '../../pipeline/src/gcp/storage';
import { healthCheck, maxStoredVersion, publishCatalog, readLatest, rollback } from '../../pipeline/src/publish/publish';
import { migrateActivities, migrateOutings, migrateRecord, isMigrated, SEED_DATE } from '../../pipeline/src/content/migrate';
import { mergeCandidates, nextActivityId, nextOutingId, retireRecords } from '../../pipeline/src/content/merge';
import { seedContent, loadContent, PATHS, appendQuarantine } from '../../pipeline/src/content/store';
import { jobFinished, jobStarted, readJobHealth } from '../../pipeline/src/jobs/job-health';
import { buildDigest } from '../../pipeline/src/jobs/digest';
import { validate, buildCatalog } from '../../scripts/catalog-lib';
import type { Activity, Candidate, ContentSet, Outing, RunReport } from '../../pipeline/src/types';

const root = join(__dirname, '..', '..');
const read = (f: string) => JSON.parse(readFileSync(join(root, 'data', f), 'utf8'));
const content = (): ContentSet => ({ activities: read('activities.json'), milestones: read('milestones.json'), outings: read('sg_outings.json') });

/** A fake live site that serves whatever the bucket's latest.json points at (or a fixed broken response). */
function fakeSite(b: MemoryBucket, opts: { broken?: boolean; stale?: boolean } = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/health') return new Response('ok');
    if (url.pathname === '/catalog/latest.json') {
      const l = await readJson<{ version: number }>(b, 'catalog/latest.json');
      return json(opts.stale ? { ...l, version: 1 } : l);
    }
    if (opts.broken) return new Response('boom', { status: 500 });
    const o = await b.read(url.pathname.slice(1));
    return o ? new Response(o.body, { headers: { 'content-type': 'application/json' } }) : new Response('nf', { status: 404 });
  }) as typeof fetch;
}

async function bucketWithV2(): Promise<MemoryBucket> {
  const b = new MemoryBucket();
  const c = content();
  for (const v of [1, 2]) {
    const built = buildCatalog(c, v, '2026-10-19T00:00:00Z');
    for (const [rel, val] of Object.entries(built.files)) await writeJson(b, `catalog/v${v}/${rel}`, val);
  }
  await writeJson(b, 'catalog/latest.json', { version: 2, published_at: '2026-10-19T08:51:12.625Z', path: 'catalog/v2/' });
  return b;
}

const noSleep = async () => {};

describe('migration (SDD 6.2 backfill)', () => {
  it('real data is migrated: every record has added_at, status, origin', () => {
    const c = content();
    expect(isMigrated(c.activities)).toBe(true);
    expect(isMigrated(c.outings)).toBe(true);
    expect(c.activities.every((a) => a.added_at === SEED_DATE && a.status === 'published' && a.origin === 'seed')).toBe(true);
    expect(c.outings.every((o) => o.added_at === SEED_DATE && o.status === 'published' && o.origin === 'seed')).toBe(true);
  });

  it('keeps field order and appends lifecycle fields at the end; paid stays', () => {
    const raw = { id: 'x', title: 't', verified: true, paid: true };
    const m = migrateRecord(raw);
    expect(Object.keys(m)).toEqual(['id', 'title', 'verified', 'paid', 'added_at', 'status', 'origin']);
    expect(m.paid).toBe(true);
  });

  it('is idempotent and never overwrites existing values', () => {
    const a = { id: 'x', added_at: '2026-11-01', status: 'retired', origin: 'pipeline' };
    expect(migrateRecord(a)).toEqual(a);
    const acts = migrateActivities(content().activities);
    expect(migrateActivities(acts)).toEqual(acts);
    expect(migrateOutings(content().outings)).toEqual(content().outings);
  });

  it('activity and outing field order matches the v2 schema with the new fields last', () => {
    const c = content();
    expect(Object.keys(c.activities[0])).toEqual([
      'id', 'title', 'month', 'category', 'philosophy', 'milestone_ids', 'summary', 'how_to', 'materials', 'setting', 'energy',
      'senses', 'play_type', 'duration_min', 'parent_role', 'safety_notes', 'source_name', 'source_url', 'verified', 'paid',
      'added_at', 'status', 'origin',
    ]);
    expect(Object.keys(c.outings[0]).slice(-4)).toEqual(['paid', 'added_at', 'status', 'origin']);
  });

  it('catalog lib accepts the new fields and rejects bad values', () => {
    const c = content();
    expect(validate(c, { strictPublishedCoverage: true }).errors).toEqual([]);
    c.activities[0] = { ...c.activities[0], status: 'gone', origin: 'robot', added_at: '18/10/2026' };
    const errs = validate(c).errors.join('\n');
    expect(errs).toContain('bad status gone');
    expect(errs).toContain('bad origin robot');
    expect(errs).toContain('added_at not ISO date');
  });

  it('catalog build drops retired activities and retired outings', () => {
    const c = content();
    const r = retireRecords(c, new Set([c.activities[5].id, c.outings[0].id]));
    const built = buildCatalog(r, 3, 'now');
    expect((built.files['activities.json'] as Activity[]).some((a) => a.id === c.activities[5].id)).toBe(false);
    expect((built.files['outings.json'] as Outing[]).some((o) => o.id === c.outings[0].id)).toBe(false);
    expect(built.counts.outings).toBe(61);
  });

  it('seedContent writes content/ once and never overwrites without force', async () => {
    const b = new MemoryBucket();
    expect(await seedContent(b, content())).toBe('seeded');
    const c = (await loadContent(b))!;
    expect(c.activities).toHaveLength(620);
    c.activities.pop();
    await writeJson(b, PATHS.activities, c.activities);
    expect(await seedContent(b, content())).toBe('exists');
    expect((await loadContent(b))!.activities).toHaveLength(619);
    expect(await seedContent(b, content(), true)).toBe('seeded');
    expect((await loadContent(b))!.activities).toHaveLength(620);
  });
});

const actCandidate = (over: Partial<Activity> = {}): Candidate => ({
  kind: 'activity',
  draft: {
    title: 'Scarf pull from a tissue box', month: 9, category: 'fine_motor', philosophy: ['montessori'], milestone_ids: ['fm-09-1'],
    summary: 'Baby pulls soft scarves out of a box.', how_to: 'Stuff scarves in a box. Let baby pull them out.', materials: ['tissue box', 'scarves'],
    setting: 'indoor', energy: 'calm', senses: ['touch', 'sight'], play_type: ['exploration'], duration_min: 10, parent_role: 'alongside',
    safety_notes: 'Supervise; put scarves away after play.', source_name: 'How We Montessori', source_url: 'https://www.howwemontessori.com/x', paid: false,
    ...over,
  } as Candidate['draft'],
  supporting_quote: 'q', source_id: 'how-we-montessori', page_url: 'https://www.howwemontessori.com/x', extracted_at: 'now', attempts: 1,
});

describe('merge', () => {
  it('assigns the next free id in the month x category cell and sets lifecycle fields', () => {
    const c = content();
    const r = mergeCandidates(c, [actCandidate(), actCandidate({ title: 'Second' } as Partial<Activity>)], '2026-10-26');
    expect(r.addedActivities.map((a) => a.id)).toEqual(['act-m09-fm-' + String(c.activities.filter((a) => a.id.startsWith('act-m09-fm-')).length + 1).padStart(2, '0'), expect.stringMatching(/^act-m09-fm-\d\d$/)]);
    expect(new Set(r.content.activities.map((a) => a.id)).size).toBe(622);
    const a = r.addedActivities[0];
    expect(a).toMatchObject({ verified: true, added_at: '2026-10-26', status: 'published', origin: 'pipeline' });
    expect(Object.keys(a)).toEqual(Object.keys(c.activities[0]));
    expect(c.activities).toHaveLength(620); // pure
  });

  it('outing ids are slugged and unique; venue updates keep id, added_at and origin', () => {
    const taken = new Set(['sg-event-tiny-tales']);
    expect(nextOutingId('event', 'Tiny Tales!', taken)).toBe('sg-event-tiny-tales-2');
    const c = content();
    const o = c.outings[0];
    const { id: _i, added_at: _a, status: _s, origin: _o, last_verified: _l, ...draft } = o;
    const upd: Candidate = { kind: 'outing', draft: { ...draft, name: 'Renamed garden' }, supporting_quote: 'q', source_id: 'nparks', page_url: o.url, extracted_at: 'now', attempts: 1, purpose: 'venue-update', replaces_id: o.id };
    const r = mergeCandidates(c, [upd], '2026-11-01');
    const n = r.content.outings.find((x) => x.id === o.id)!;
    expect(n).toMatchObject({ name: 'Renamed garden', added_at: '2026-10-18', origin: 'seed', last_verified: '2026-11-01' });
    expect(r.updated).toEqual([{ id: o.id, reason: 'venue re-check' }]);
    expect(nextActivityId(c, 9, 'other', new Set())).toMatch(/^act-m09-oth-\d\d$/);
  });
});

describe('publish and rollback (mock bucket)', () => {
  it('publishes v3: complete folder first, then latest.json; health check passes', async () => {
    const b = await bucketWithV2();
    const c = content();
    const r = await publishCatalog(b, c, { health: { siteUrl: 'https://site', fetchImpl: fakeSite(b), sleep: noSleep } });
    expect(r).toMatchObject({ ok: true, version: 3, previous: 2, rolledBack: false });
    expect((await readLatest(b))!.pointer).toMatchObject({ version: 3, path: 'catalog/v3/' });
    const v3 = await b.list('catalog/v3/');
    expect(v3).toHaveLength(r.files);
    // latest.json is written after every v3 file
    const lastV3Write = Math.max(...v3.map((p) => b.writes.lastIndexOf(p)));
    expect(b.writes.lastIndexOf('catalog/latest.json')).toBeGreaterThan(lastV3Write);
  });

  it('rolls latest.json back when the live health check fails', async () => {
    const b = await bucketWithV2();
    const r = await publishCatalog(b, content(), { health: { siteUrl: 'https://site', fetchImpl: fakeSite(b, { broken: true }), sleep: noSleep } });
    expect(r).toMatchObject({ ok: false, version: 3, rolledBack: true });
    expect((await readLatest(b))!.pointer.version).toBe(2);
    expect(r.errors[0]).toContain('health check failed');
  });

  it('rolls back when the site never reports the new version', async () => {
    const b = await bucketWithV2();
    const r = await publishCatalog(b, content(), { health: { siteUrl: 'https://site', fetchImpl: fakeSite(b, { stale: true }), sleep: noSleep, timeoutMs: 0 } });
    expect(r.rolledBack).toBe(true);
    expect((await readLatest(b))!.pointer.version).toBe(2);
  });

  it('G9: invalid content publishes nothing', async () => {
    const b = await bucketWithV2();
    const c = content();
    const cell = c.activities.filter((a) => a.month === 4 && a.category === 'language').map((a) => a.id);
    const r = await publishCatalog(b, retireRecords(c, new Set(cell)), { health: null });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('coverage: month 4 language');
    expect(await b.list('catalog/v3/')).toEqual([]);
    expect((await readLatest(b))!.pointer.version).toBe(2);
  });

  it('a half-written version folder is never reused or pointed at', async () => {
    const b = await bucketWithV2();
    b.failWrites.add('catalog/v3/by_month/10.json');
    await expect(publishCatalog(b, content(), { health: null })).rejects.toThrow('simulated');
    expect((await readLatest(b))!.pointer.version).toBe(2);
    expect(await maxStoredVersion(b)).toBe(3);
    const r = await publishCatalog(b, content(), { health: null });
    expect(r.version).toBe(4);
    await expect(rollback(b, 3)).rejects.toThrow('missing');
  });

  it('refuses to overwrite latest.json if someone else changed it meanwhile', async () => {
    const b = await bucketWithV2();
    const orig = b.read.bind(b);
    let first = true;
    b.read = async (p: string) => {
      const o = await orig(p);
      if (p === 'catalog/latest.json' && first) {
        first = false;
        await writeJson(b, 'catalog/latest.json', { version: 2, published_at: 'x', path: 'catalog/v2/' }); // concurrent writer
      }
      return o;
    };
    await expect(publishCatalog(b, content(), { health: null })).rejects.toThrow();
  });

  it('rollback CLI logic: defaults to the previous complete version, or --to N', async () => {
    const b = await bucketWithV2();
    await publishCatalog(b, content(), { health: null });
    expect(await rollback(b)).toEqual({ from: 3, to: 2 });
    expect((await readLatest(b))!.pointer).toMatchObject({ version: 2, path: 'catalog/v2/' });
    expect(await rollback(b, 1)).toEqual({ from: 2, to: 1 });
    await expect(rollback(b, 1)).rejects.toThrow('already points');
    await expect(rollback(b, 9)).rejects.toThrow('missing');
    expect(await rollback(b, 3)).toEqual({ from: 1, to: 3 });
  });

  it('healthCheck reports which check failed', async () => {
    const b = await bucketWithV2();
    const h = await healthCheck(2, { activities: 999, outings: 62 }, { siteUrl: 'https://site', fetchImpl: fakeSite(b), sleep: noSleep });
    expect(h.ok).toBe(false);
    expect(h.error).toContain('expected 999');
  });
});

describe('job health and digest', () => {
  it('counts consecutive failures, including a run that never finished', async () => {
    const b = new MemoryBucket();
    const t = new Date('2026-10-26T00:00:00Z');
    await jobStarted(b, 'weekly', t);
    await jobFinished(b, 'weekly', false, t, 'boom');
    expect((await readJobHealth(b)).weekly.consecutive_failures).toBe(1);
    await jobStarted(b, 'weekly', t); // crashes: never finishes
    const s = await jobStarted(b, 'weekly', t);
    expect(s.consecutive_failures).toBe(2);
    await jobFinished(b, 'weekly', true, t);
    expect((await readJobHealth(b)).weekly.consecutive_failures).toBe(0);
  });

  it('appendQuarantine merges entries written on the same day', async () => {
    const b = new MemoryBucket();
    const e = { candidate: actCandidate(), failures: [{ gate: 'G2' as const, reason: 'x', fixable: false }], quarantined_at: 'now', retry: false };
    await appendQuarantine(b, { date: '2026-10-26', run_id: 'a', entries: [e] });
    await appendQuarantine(b, { date: '2026-10-26', run_id: 'b', entries: [e, e] });
    expect((await readJson<{ entries: unknown[] }>(b, PATHS.quarantine('2026-10-26')))!.entries).toHaveLength(3);
  });

  it('digest entry has the counts and a bounded summary', () => {
    const r = {
      job: 'weekly', published: [], staged: Array.from({ length: 12 }, (_, i) => ({ title: `Activity ${i}`, kind: 'activity', source: 's', url: 'u' })),
      retired: [{ id: 'sg-event-x', reason: 'event ended' }], quarantined: 4, failures: ['extract x: 500'], est_cost_usd: 0.031,
    } as unknown as RunReport;
    const d = buildDigest([r], [], 2, '2026-10-26', false);
    expect(d).toMatchObject({ event: 'weekly_digest', published: 0, staged: 12, retired: 1, quarantined: 4, failures: 1, catalog_version: 2 });
    expect(d.summary).toContain('AUTO_PUBLISH is off');
    expect(d.summary).toContain('+6 more');
    expect(d.summary.length).toBeLessThanOrEqual(900);
  });
});
