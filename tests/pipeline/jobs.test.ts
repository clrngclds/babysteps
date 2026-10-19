/**
 * End-to-end job tests with no network: in-memory bucket, fake web (fetcher), fake Gemini, fake live site.
 * Covers the weekly flow (discovery -> extraction -> gates -> stage or publish -> link check -> digest),
 * the AUTO_PUBLISH kill switch, quarantine, and the daily event-expiry publish.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCatalog } from '../../scripts/catalog-lib';
import { MemoryBucket, readJson, writeJson } from '../../pipeline/src/gcp/storage';
import { loadContent, PATHS } from '../../pipeline/src/content/store';
import { readLatest } from '../../pipeline/src/publish/publish';
import { loadSafetyRules } from '../../pipeline/src/gates/safety';
import { runWeekly } from '../../pipeline/src/jobs/weekly';
import { runDaily } from '../../pipeline/src/jobs/daily-monthly';
import { setQuiet } from '../../pipeline/src/log';
import { loadConfig } from '../../pipeline/src/config';
import type { JobDeps } from '../../pipeline/src/jobs/common';
import type { Fetcher, FetchResult, Llm, LlmRequest, LlmUsage, QuarantineFile, SourcesFile, StagedFile } from '../../pipeline/src/types';
import { classifyStatus, expiredEvents, linkCheck, splitRetirements, thinCells, rankPagesForCell, type LinkHealth } from '../../pipeline/src/maintenance/maintenance';
import { retireRecords } from '../../pipeline/src/content/merge';

const root = join(__dirname, '..', '..');
const read = (f: string) => JSON.parse(readFileSync(join(root, 'data', f), 'utf8'));
const TODAY = '2026-10-26';

const FEED = 'https://montessori.example.sg/feed/';
const POST = 'https://montessori.example.sg/2026/10/peg-game/';
const OLD_POST = 'https://montessori.example.sg/2025/01/old-post/';
const PAGE_TEXT =
  'A clothes peg game for toddlers. Clip wooden clothes pegs around the rim of a sturdy bowl and let your toddler pull them off and push them back on. ' +
  'Squeezing a peg open builds the hand strength toddlers need for later drawing and dressing. Start with pegs that open easily. Stay close while they play.';
const feedXml = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>Peg game</title><link>${POST}</link><pubDate>Sat, 24 Oct 2026 08:00:00 GMT</pubDate></item>
<item><title>Old</title><link>${OLD_POST}</link><pubDate>Mon, 06 Jan 2025 08:00:00 GMT</pubDate></item>
</channel></rss>`;

const sources: SourcesFile = {
  version: 1,
  sources: [
    { id: 'test-montessori', name: 'Test Montessori', tier: 1, kind: 'activity', detection: 'feed', urls: [FEED], domains: ['montessori.example.sg'], philosophy: ['montessori'] },
  ],
};

function fakeWeb(overrides: Record<string, Partial<FetchResult>> = {}): Fetcher {
  return {
    async get(url) {
      const o = overrides[url];
      if (o) return { url, finalUrl: url, status: 200, ok: true, contentType: 'text/html', body: '', ...o };
      if (url === FEED) return { url, finalUrl: url, status: 200, ok: true, contentType: 'application/rss+xml', body: feedXml };
      if (url === POST)
        return { url, finalUrl: url, status: 200, ok: true, contentType: 'text/html', body: `<html><head><title>Peg game</title></head><body><p>${PAGE_TEXT}</p></body></html>` };
      return { url, finalUrl: url, status: 200, ok: true, contentType: 'text/html', body: '<html><body><p>ok</p></body></html>' };
    },
  };
}

const goodDraft = {
  title: 'Clothes peg rim game', month: 20, category: 'fine_motor', philosophy: ['montessori'], milestone_ids: ['fm-24-1'],
  summary: 'Your toddler squeezes pegs on and off a bowl edge to strengthen small hand muscles.',
  how_to: 'Clip a few easy pegs around a bowl. Show how to pinch one off. Let your toddler pull them off and try clipping them back.',
  materials: ['wooden clothes pegs', 'sturdy bowl'], setting: 'indoor', energy: 'calm', senses: ['touch', 'sight'], play_type: ['practical_life'],
  duration_min: 10, parent_role: 'alongside', safety_notes: 'Supervise so pegs stay out of mouths.', source_name: 'Test Montessori', source_url: POST, paid: false,
  supporting_quote: 'Clip wooden clothes pegs around the rim of a sturdy bowl and let your toddler pull them off',
};

function fakeLlm(extract: unknown[] = [goodDraft], reviewScore = 5): Llm & { calls: string[] } {
  const totals: Record<string, LlmUsage> = {};
  const calls: string[] = [];
  return {
    model: 'gemini-2.5-flash',
    calls,
    usage: () => totals,
    async generateJson<T>(req: LlmRequest) {
      calls.push(req.purpose);
      const u = (totals[req.purpose] ??= { calls: 0, promptTokens: 0, outputTokens: 0, thoughtsTokens: 0 });
      u.calls++;
      u.promptTokens += 4000;
      u.outputTokens += 400;
      const data =
        req.purpose === 'extract'
          ? { candidates: extract }
          : { notes: 'fine', age_appropriate: reviewScore, safety: 5, no_medical_claims: 5, not_product_only: 5 };
      return { data: data as T, usage: { calls: 1, promptTokens: 4000, outputTokens: 400, thoughtsTokens: 0 } };
    },
  };
}

function fakeSite(b: MemoryBucket): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/health') return new Response('ok');
    const o = await b.read(url.pathname.slice(1));
    return o ? new Response(o.body, { headers: { 'content-type': 'application/json' } }) : new Response('nf', { status: 404 });
  }) as typeof fetch;
}

async function liveBucket(outings = read('sg_outings.json')): Promise<MemoryBucket> {
  const b = new MemoryBucket();
  // v2 as it is live today: the pre-migration dataset (no lifecycle fields).
  const strip = <T extends object>(r: T) => {
    const { added_at: _a, status: _s, origin: _o, ...rest } = r as Record<string, unknown>;
    return rest;
  };
  const data = { activities: read('activities.json').map(strip), milestones: read('milestones.json'), outings: outings.map(strip) };
  const built = buildCatalog(data, 2, '2026-10-19T08:51:12.625Z');
  for (const [rel, v] of Object.entries(built.files)) await writeJson(b, `catalog/v2/${rel}`, v);
  await writeJson(b, PATHS.latest, built.latest);
  return b;
}

function deps(b: MemoryBucket, over: Partial<JobDeps> & { autoPublish?: boolean } = {}): JobDeps {
  const cfg = { ...loadConfig({} as NodeJS.ProcessEnv), autoPublish: over.autoPublish ?? false, hostDelayMs: 0 };
  return {
    cfg,
    bucket: b,
    fetcher: fakeWeb(),
    llm: fakeLlm(),
    sources,
    safety: loadSafetyRules(join(root, 'pipeline', 'safety_rules.yaml')),
    repoRoot: root,
    now: new Date(`${TODAY}T00:00:00+08:00`),
    runId: 'test-run',
    healthFetch: fakeSite(b),
    ...over,
  };
}

beforeEach(() => setQuiet(true));

describe('weekly job', () => {
  it('AUTO_PUBLISH=false: seeds content/, stages the candidate, publishes nothing, logs a digest', async () => {
    const b = await liveBucket();
    const log = vi.spyOn(console, 'log');
    setQuiet(false);
    const d = deps(b);
    const r = await runWeekly(d, TODAY);
    setQuiet(true);

    expect((await loadContent(b))!.activities).toHaveLength(620); // seeded, unchanged
    expect((await readLatest(b))!.pointer.version).toBe(2);
    expect(await b.list('catalog/v3/')).toEqual([]);
    expect(r.discovered[0]).toMatchObject({ sourceId: 'test-montessori', selected: 1 });
    expect(r.reached_gemini).toBe(1);
    expect(r.passed).toBe(1);
    expect(r.staged).toEqual([expect.objectContaining({ title: 'Clothes peg rim game', month: 20, category: 'fine_motor' })]);
    const staged = (await readJson<StagedFile>(b, PATHS.staged(TODAY)))!;
    expect(staged.activities[0]).toMatchObject({ id: expect.stringMatching(/^act-m20-fm-\d\d$/), origin: 'pipeline', added_at: TODAY, status: 'published', verified: true });
    expect(JSON.stringify(staged)).not.toContain('supporting_quote');
    // seen_urls: both feed items recorded, only the recent one processed (first run)
    const seen = (await readJson<{ urls: Record<string, unknown> }>(b, PATHS.seen))!;
    expect(Object.keys(seen.urls)).toEqual(expect.arrayContaining([POST, OLD_POST]));
    // digest
    const digest = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes('"weekly_digest"'));
    expect(JSON.parse(digest!)).toMatchObject({ event: 'weekly_digest', staged: 1, published: 0, auto_publish: false, catalog_version: 2 });
    log.mockRestore();
    // second run: nothing new
    const r2 = await runWeekly(deps(b), TODAY);
    expect(r2.reached_gemini).toBe(0);
  });

  it('AUTO_PUBLISH=true: publishes v3 with the migration and the new activity, health-checked', async () => {
    const b = await liveBucket();
    const r = await runWeekly(deps(b, { autoPublish: true }), TODAY);
    expect(r.failures).toEqual([]);
    expect(r.published_version).toBe(3);
    expect((await readLatest(b))!.pointer.version).toBe(3);
    const acts = (await readJson<{ id: string; origin?: string }[]>(b, 'catalog/v3/activities.json'))!;
    expect(acts).toHaveLength(621);
    expect(acts.every((a) => a.origin)).toBe(true);
    expect((await loadContent(b))!.activities).toHaveLength(621);
  });

  it('gate failures go to quarantine with reasons; a low AI review score blocks publishing', async () => {
    const b = await liveBucket();
    const bad = { ...goodDraft, title: 'Honey tasting', month: 8, milestone_ids: [], how_to: 'Offer a little honey on a spoon. Watch their face.', supporting_quote: 'made up words that are not on the page at all anywhere' };
    const r = await runWeekly(deps(b, { llm: fakeLlm([bad, goodDraft], 3) }), TODAY);
    expect(r.passed).toBe(0);
    expect(r.gate_failures.G2).toBe(1);
    expect(r.gate_failures.G4).toBe(1);
    expect(r.gate_failures.G5).toBe(1);
    const q = (await readJson<QuarantineFile>(b, PATHS.quarantine(TODAY)))!;
    expect(q.entries).toHaveLength(2);
    expect(q.entries.flatMap((e) => e.failures.map((f) => f.gate))).toEqual(expect.arrayContaining(['G2', 'G4', 'G5']));
  });

  it('a link that fails two weekly runs in a row retires the item (when coverage allows)', async () => {
    const b = await liveBucket();
    const acts = read('activities.json');
    const victim = acts.find((a: { source_url: string }) => acts.filter((x: { source_url: string }) => x.source_url === a.source_url).length === 1);
    const web = fakeWeb({ [victim.source_url]: { status: 404, ok: false, error: 'http_404' } });
    await runWeekly(deps(b, { fetcher: web, autoPublish: true }), '2026-10-19');
    let health = (await readJson<LinkHealth>(b, PATHS.linkHealth))!;
    expect(health.urls[victim.source_url].fails).toBe(1);
    const r = await runWeekly(deps(b, { fetcher: web, autoPublish: true }), TODAY);
    health = (await readJson<LinkHealth>(b, PATHS.linkHealth))!;
    expect(health.urls[victim.source_url].fails).toBe(2);
    const content = (await loadContent(b))!;
    const v = content.activities.find((a) => a.id === victim.id)!;
    const deferred = (r.maintenance as { retire_deferred: string[] }).retire_deferred;
    if (deferred.includes(victim.id)) expect(v.status).toBe('published');
    else expect(v.status).toBe('retired');
  });
});

describe('daily job (event expiry)', () => {
  it('retires ended events and publishes when AUTO_PUBLISH=true', async () => {
    const outs = read('sg_outings.json');
    const b = await liveBucket(outs);
    const r = await runDaily(deps(b, { autoPublish: true }), '2026-11-02');
    const expired = (r.maintenance as { expired: string[] }).expired;
    expect(expired).toEqual(expect.arrayContaining(['sg-event-nlb-tamil-vidhaigal']));
    expect(r.published_version).toBe(3);
    const v3 = (await readJson<{ id: string }[]>(b, 'catalog/v3/outings.json'))!;
    expect(v3.some((o) => o.id === 'sg-event-nlb-tamil-vidhaigal')).toBe(false);
    expect(v3).toHaveLength(62 - expired.length);
  });

  it('AUTO_PUBLISH=false stages the migration instead of publishing', async () => {
    const b = await liveBucket();
    const r = await runDaily(deps(b), '2026-10-19');
    expect((r.maintenance as { expired: string[] }).expired).toEqual([]);
    expect(r.published_version).toBeNull();
    expect((await readLatest(b))!.pointer.version).toBe(2);
    expect(await readJson<StagedFile>(b, PATHS.staged('2026-10-19'))).not.toBeNull();
  });
});

describe('maintenance helpers', () => {
  it('classifies link results conservatively', () => {
    expect(classifyStatus(200)).toBe('ok');
    expect(classifyStatus(404, 'http_404')).toBe('fail');
    expect(classifyStatus(0, 'timeout')).toBe('fail');
    expect(classifyStatus(403, 'http_403')).toBe('inconclusive');
    expect(classifyStatus(202, 'bot_challenge')).toBe('inconclusive');
    expect(classifyStatus(0, 'robots_disallowed')).toBe('inconclusive');
  });

  it('counts at most one link failure per day', async () => {
    const c = { activities: read('activities.json').slice(0, 2), milestones: read('milestones.json'), outings: [] };
    const web = fakeWeb({ [c.activities[0].source_url]: { status: 410, ok: false } });
    const h: LinkHealth = { urls: {} };
    await linkCheck(c, web, h, TODAY);
    const r = await linkCheck(c, web, h, TODAY);
    expect(h.urls[c.activities[0].source_url].fails).toBe(1);
    expect(r.retire).toEqual([]);
  });

  it('expiry uses end_date, or start_date for one-day events', () => {
    const o = read('sg_outings.json');
    const single = { ...o[0], id: 'one-day', type: 'event', start_date: '2026-10-20', end_date: null };
    const ids = expiredEvents([...o, single], '2026-11-02').map((x) => x.id);
    expect(ids).toContain('one-day');
    expect(ids).toContain('sg-event-nlb-musical-stories-swimmy');
    expect(ids).not.toContain('sg-event-river-hongbao-2027');
  });

  it('defers retirements that would drop a cell below 2; the coverage guard sees the thin cell', () => {
    const c = { activities: read('activities.json'), milestones: read('milestones.json'), outings: read('sg_outings.json') };
    const cell = c.activities.filter((a: { month: number; category: string }) => a.month === 4 && a.category === 'language');
    const all = cell.map((a: { id: string }) => ({ id: a.id, reason: 'dead link' }));
    const s = splitRetirements(c, all);
    expect(s.now).toHaveLength(cell.length - 2);
    expect(s.deferred).toHaveLength(2);
    expect(thinCells(retireRecords(c, new Set(cell.map((a: { id: string }) => a.id))).activities)).toEqual(
      expect.arrayContaining([{ month: 4, category: 'language', count: 0 }]),
    );
  });

  it('ranks known pages for a coverage cell by category words', () => {
    const urls = rankPagesForCell(
      [{ url: 'https://x/blog/language-games-for-babies' }, { url: 'https://x/blog/crawling-tips' }, { url: 'https://x/shop/sale' }],
      { month: 4, category: 'language' },
    );
    expect(urls[0]).toContain('language');
    expect(urls).not.toContain('https://x/shop/sale');
  });
});

describe('weekly job: visitor numbers and disabled sources (follow-ups 2026-10-19)', () => {
  const stats = {
    current: { start: '2026-10-19', end: '2026-10-25', visitors: 14, visitor_days: 31, legacy_rows: 3 },
    previous: { start: '2026-10-12', end: '2026-10-18', visitors: 0, visitor_days: 0, legacy_rows: 0 },
    month: { start: '2026-10-01', end: '2026-10-26', visitors: 20 },
    week_first_since: '2026-10-19',
  };
  const digestOf = (log: { mock: { calls: unknown[][] } }) =>
    JSON.parse(log.mock.calls.map((c) => String(c[0])).find((l) => l.includes('"weekly_digest"'))!);

  it('puts the visitor numbers in the digest log entry', async () => {
    const b = await liveBucket();
    const seen: string[] = [];
    const log = vi.spyOn(console, 'log');
    setQuiet(false);
    await runWeekly(deps(b, { visitStats: async (day) => (seen.push(day), stats) }), TODAY);
    setQuiet(true);
    const d = digestOf(log);
    log.mockRestore();
    expect(seen).toEqual([TODAY]);
    expect(d).toMatchObject({ visitors_7d: 14, visitor_days_7d: 31, visitors_prev_7d: 0, visitor_days_prev_7d: 0, visitors_month: 20, visitors_complete: false });
    expect(d.visitors_past_text).toContain('14 visitors');
    expect(d.visitors_past_text).toContain('31 visitor-days');
    expect(d.visitors_month_text).toContain('20 visitors');
  });

  it('a failed visitor query does not fail the job; the digest says why', async () => {
    const b = await liveBucket();
    const log = vi.spyOn(console, 'log');
    setQuiet(false);
    const r = await runWeekly(deps(b, { visitStats: async () => { throw new Error('bigquery query 403: Access Denied'); } }), TODAY);
    setQuiet(true);
    const d = digestOf(log);
    log.mockRestore();
    expect(r.staged).toHaveLength(1);
    expect(d.visitors_7d).toBeNull();
    expect(d.visitors_past_text).toContain('Visitor counts unavailable (bigquery query 403');
    expect(d.summary).toContain('visitor counts: bigquery query 403');
  });

  it('a disabled source is not fetched and never counts towards source_failing', async () => {
    const b = await liveBucket();
    const blocked = 'https://blocked.example.au/sitemap_index.xml';
    const calls: string[] = [];
    const web = fakeWeb({ [blocked]: { status: 403, ok: false } });
    const fetcher: Fetcher = { get: (url, o) => (calls.push(url), web.get(url, o)) };
    const withDisabled: SourcesFile = {
      ...sources,
      sources: [...sources.sources, { id: 'blocked', name: 'Blocked', tier: 1, kind: 'activity', detection: 'sitemap', urls: [blocked], domains: ['blocked.example.au'], enabled: false, notes: 'Disabled: 403 to Cloud Run' }],
    };
    await writeJson(b, PATHS.sourceHealth, { blocked: { error_weeks: 2, last_error: '403', last_run: '2026-10-19' } });
    const warn = vi.spyOn(console, 'error');
    setQuiet(false);
    const r = await runWeekly(deps(b, { fetcher, sources: withDisabled }), TODAY);
    setQuiet(true);
    const failing = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"source_failing"'));
    warn.mockRestore();
    expect(calls.some((u) => u.includes('blocked.example.au'))).toBe(false);
    expect(r.discovered.map((s) => s.sourceId)).not.toContain('blocked');
    expect(failing).toEqual([]);
    expect((await readJson<Record<string, { error_weeks: number }>>(b, PATHS.sourceHealth))!.blocked.error_weeks).toBe(2);
  });
});
