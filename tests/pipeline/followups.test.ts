/**
 * Follow-ups approved 2026-10-19: digest visitor numbers (BigQuery), digest email template and
 * label extractors, the "What this email is" line, pipeline BigQuery grants, Montessori Academy disabled.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBigQuery, queryVisitStats, visitStatsSql, visitWindows, type VisitStats } from '../../pipeline/src/gcp/bigquery';
import { buildDigest, DIGEST_INTRO, partialReasons, visitorFields } from '../../pipeline/src/jobs/digest';
import { loadSourcesFile } from '../../pipeline/src/fetch/sources';
import { loadConfig } from '../../pipeline/src/config';
import type { RunReport } from '../../pipeline/src/types';

const root = join(__dirname, '..', '..');
const TABLE = 'dc-test2-489503.babysteps.visits';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('visit windows', () => {
  it('past 7 days = the 7 complete days before the run (Mon run -> previous Mon..Sun)', () => {
    expect(visitWindows('2026-10-26')).toEqual({
      cur_start: '2026-10-19', cur_end: '2026-10-25',
      prev_start: '2026-10-12', prev_end: '2026-10-18',
      month_start: '2026-10-01', today: '2026-10-26',
    });
  });
  it('month and year boundaries', () => {
    expect(visitWindows('2026-11-02')).toMatchObject({ cur_start: '2026-10-26', cur_end: '2026-11-01', month_start: '2026-11-01' });
    expect(visitWindows('2027-01-04')).toMatchObject({ cur_start: '2026-12-28', cur_end: '2027-01-03', prev_start: '2026-12-21', month_start: '2027-01-01' });
  });
});

describe('visitStatsSql', () => {
  const sql = visitStatsSql(TABLE);
  it('counts week_first, day_first and month_first rows in the right windows', () => {
    expect(sql).toContain('COUNTIF(week_first IS TRUE AND date BETWEEN @cur_start AND @cur_end) AS visitors_cur');
    expect(sql).toContain('COUNTIF(day_first IS TRUE AND date BETWEEN @cur_start AND @cur_end) AS visitor_days_cur');
    expect(sql).toContain('COUNTIF(week_first IS TRUE AND date BETWEEN @prev_start AND @prev_end) AS visitors_prev');
    expect(sql).toContain('COUNTIF(day_first IS TRUE AND date BETWEEN @prev_start AND @prev_end) AS visitor_days_prev');
    expect(sql).toContain('COUNTIF(month_first IS TRUE AND date BETWEEN @month_start AND @today) AS visitors_month');
    expect(sql).toContain('week_first IS NULL AND date BETWEEN @cur_start AND @cur_end');
    expect(sql).toContain('`dc-test2-489503.babysteps.visits`');
  });
  it('is read-only and prunes partitions', () => {
    expect(sql).toMatch(/^SELECT/);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP)\b/i);
    expect(sql).toContain('WHERE date BETWEEN LEAST(@prev_start, @month_start) AND @today');
  });
  it('rejects odd table names', () => {
    expect(() => visitStatsSql('x`; DROP TABLE y; --')).toThrow(/bad table/);
    expect(() => visitStatsSql('babysteps.visits')).toThrow(/bad table/);
  });
  it('the config points at the visits table in asia-southeast1', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.visitsTable).toBe(TABLE);
    expect(cfg.bqLocation).toBe('asia-southeast1');
  });
});

describe('createBigQuery', () => {
  it('sends a parameterised standard-SQL query to the regional endpoint and maps rows', async () => {
    const f = vi.fn().mockResolvedValue(json({ jobComplete: true, schema: { fields: [{ name: 'a' }, { name: 'b' }] }, rows: [{ f: [{ v: '3' }, { v: null }] }] }));
    const q = createBigQuery({ project: 'dc-test2-489503', location: 'asia-southeast1', fetchFn: f as unknown as typeof fetch, token: async () => 'tok' });
    expect(await q('SELECT 1', { d: '2026-10-26' })).toEqual([{ a: '3', b: null }]);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://bigquery.googleapis.com/bigquery/v2/projects/dc-test2-489503/queries');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer tok');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ query: 'SELECT 1', useLegacySql: false, location: 'asia-southeast1', parameterMode: 'NAMED' });
    expect(body.queryParameters).toEqual([{ name: 'd', parameterType: { type: 'DATE' }, parameterValue: { value: '2026-10-26' } }]);
  });
  it('polls until the job completes', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ jobComplete: false, jobReference: { jobId: 'j1', location: 'asia-southeast1' } }))
      .mockResolvedValueOnce(json({ jobComplete: true, schema: { fields: [{ name: 'n' }] }, rows: [{ f: [{ v: '7' }] }] }));
    const q = createBigQuery({ project: 'p', location: 'asia-southeast1', fetchFn: f as unknown as typeof fetch, token: async () => 't' });
    expect(await q('SELECT 7 AS n', {})).toEqual([{ n: '7' }]);
    expect(f.mock.calls[1][0]).toContain('/queries/j1?location=asia-southeast1');
  });
  it('throws on HTTP and query errors', async () => {
    const denied = vi.fn().mockResolvedValue(json({ error: { message: 'Access Denied' } }, 403));
    await expect(createBigQuery({ project: 'p', location: 'l', fetchFn: denied as unknown as typeof fetch, token: async () => 't' })('SELECT 1', {})).rejects.toThrow('bigquery query 403: Access Denied');
    const bad = vi.fn().mockResolvedValue(json({ jobComplete: true, errors: [{ message: 'Unrecognized name: week_first' }] }));
    await expect(createBigQuery({ project: 'p', location: 'l', fetchFn: bad as unknown as typeof fetch, token: async () => 't' })('SELECT 1', {})).rejects.toThrow('Unrecognized name');
  });
});

describe('queryVisitStats', () => {
  it('maps the single result row and passes the windows as parameters', async () => {
    const query = vi.fn().mockResolvedValue([{
      visitors_cur: '14', visitor_days_cur: '31', legacy_cur: '0', visitors_prev: '9', visitor_days_prev: '22', legacy_prev: '2',
      visitors_month: '40', week_first_since: '2026-10-19',
    }]);
    const s = await queryVisitStats(query, TABLE, '2026-11-09');
    expect(query.mock.calls[0][1]).toEqual(visitWindows('2026-11-09'));
    expect(s).toEqual({
      current: { start: '2026-11-02', end: '2026-11-08', visitors: 14, visitor_days: 31, legacy_rows: 0 },
      previous: { start: '2026-10-26', end: '2026-11-01', visitors: 9, visitor_days: 22, legacy_rows: 2 },
      month: { start: '2026-11-01', end: '2026-11-09', visitors: 40 },
      week_first_since: '2026-10-19',
    });
  });
  it('an empty table gives zeros and no weekly data', async () => {
    const s = await queryVisitStats(vi.fn().mockResolvedValue([{ visitors_cur: '0', week_first_since: null }]), TABLE, '2026-10-26');
    expect(s.current.visitors).toBe(0);
    expect(s.month.visitors).toBe(0);
    expect(s.week_first_since).toBeNull();
  });
});

const stats = (over: Partial<VisitStats> = {}): VisitStats => ({
  current: { start: '2026-10-19', end: '2026-10-25', visitors: 14, visitor_days: 31, legacy_rows: 0 },
  previous: { start: '2026-10-12', end: '2026-10-18', visitors: 0, visitor_days: 2, legacy_rows: 2 },
  month: { start: '2026-10-01', end: '2026-10-26', visitors: 40 },
  week_first_since: '2026-10-19',
  ...over,
});

describe('visitor numbers in the digest', () => {
  it('weekly count is partial until 7 full days of week_first data exist: shows visitor-days too, labelled', () => {
    const v = visitorFields(stats());
    expect(v).toMatchObject({ visitors_7d: 14, visitor_days_7d: 31, visitors_prev_7d: 0, visitor_days_prev_7d: 2, visitors_month: 40, visitors_complete: false });
    expect(v.visitors_past_text).toBe(
      'Past 7 days (2026-10-19 to 2026-10-25): 14 visitors (week_first: devices, each counted once per week; partial: weekly counting started 2026-10-19) and 31 visitor-days (day_first: devices, each counted once per day they visited).',
    );
    expect(v.visitors_prev_text).toContain('Previous 7 days (2026-10-12 to 2026-10-18): 0 visitors');
    expect(v.visitors_prev_text).toContain('2 visitor-days');
    expect(v.visitors_prev_text).toContain('2 pings from older app versions without the week flag');
    expect(v.visitors_month_text).toBe('This month (2026-10-01 to 2026-10-26): 40 visitors (month_first: devices, each counted once per month).');
  });
  it('once complete, the past-7-days line shows visitors only', () => {
    const v = visitorFields(stats({
      current: { start: '2026-10-26', end: '2026-11-01', visitors: 15, visitor_days: 33, legacy_rows: 0 },
      previous: { start: '2026-10-19', end: '2026-10-25', visitors: 14, visitor_days: 31, legacy_rows: 0 },
    }));
    expect(v.visitors_complete).toBe(true);
    expect(v.visitors_past_text).toBe('Past 7 days (2026-10-26 to 2026-11-01): 15 visitors (week_first: devices, each counted once per week).');
    expect(v.visitors_past_text).not.toContain('visitor-days');
    // the previous window started on the first day of weekly counting: still partial, still shows visitor-days
    expect(v.visitors_prev_text).toContain('31 visitor-days');
    expect(v.visitor_days_7d).toBe(33); // the structured entry always has both numbers
  });
  it('old-client pings in the window keep it partial', () => {
    expect(partialReasons({ start: '2026-10-26', visitors: 1, visitor_days: 1, legacy_rows: 1 }, '2026-10-19')).toEqual(['1 ping from older app versions without the week flag']);
    expect(partialReasons({ start: '2026-10-26', visitors: 1, visitor_days: 1, legacy_rows: 0 }, '2026-10-19')).toEqual([]);
    expect(partialReasons({ start: '2026-10-26', visitors: 0, visitor_days: 0, legacy_rows: 0 }, null)).toEqual(['weekly counting has no data yet']);
  });
  it('singular wording', () => {
    const v = visitorFields(stats({ current: { start: '2026-10-19', end: '2026-10-25', visitors: 1, visitor_days: 1, legacy_rows: 0 }, month: { start: '2026-10-01', end: '2026-10-26', visitors: 1 } }));
    expect(v.visitors_past_text).toContain(': 1 visitor (');
    expect(v.visitors_past_text).toContain('1 visitor-day (');
    expect(v.visitors_month_text).toContain(': 1 visitor (');
  });
  it('not configured / query failed', () => {
    expect(visitorFields(null)).toMatchObject({ visitors_7d: null, visitors_month: null, visitors_past_text: 'Visitor counts not configured.' });
    expect(visitorFields(new Error('bigquery query 403: denied')).visitors_past_text).toBe('Visitor counts unavailable (bigquery query 403: denied).');
  });
  it('buildDigest carries the visitor fields; a query error is listed under failures', () => {
    const r = { job: 'weekly', published: [], staged: [], retired: [], quarantined: 0, failures: [], est_cost_usd: 0 } as unknown as RunReport;
    const d = buildDigest([r], [], 2, '2026-10-26', false, stats());
    expect(d).toMatchObject({ event: 'weekly_digest', catalog_version: 2, visitors_7d: 14, visitor_days_7d: 31, visitors_month: 40, failures: 0 });
    const e = buildDigest([r], [], 2, '2026-10-26', false, new Error('boom'));
    expect(e.failures).toBe(1);
    expect(e.summary).toContain('visitor counts: boom');
    // old call signature still works
    expect(buildDigest([r], [], 2, '2026-10-26', false).visitors_past_text).toBe('Visitor counts not configured.');
  });
});

describe('digest email template and label extractors (pipeline/alerts)', () => {
  const template = readFileSync(join(root, 'pipeline/alerts/weekly_digest.md'), 'utf8');
  const labels: Record<string, string> = JSON.parse(readFileSync(join(root, 'pipeline/alerts/weekly_digest_labels.json'), 'utf8'));
  const r = { job: 'weekly', published: [], staged: [], retired: [], quarantined: 0, failures: [], est_cost_usd: 0 } as unknown as RunReport;
  const entry = buildDigest([r], [], 2, '2026-10-26', false, stats());

  it('starts with the "What this email is" line', () => {
    expect(template.split('\n')[0]).toBe(DIGEST_INTRO);
    expect(DIGEST_INTRO).toMatch(/^What this email is: /);
    for (const w of ['published', 'retired', 'quarantined', 'failures', 'catalog version', 'visitor counts', 'no action is needed']) expect(DIGEST_INTRO).toContain(w);
  });
  it('every placeholder has an extractor, and every extractor is used', () => {
    const used = [...template.matchAll(/\$\{log\.extracted_label\.([a-z0-9_]+)\}/g)].map((m) => m[1]);
    expect(new Set(used)).toEqual(new Set(Object.keys(labels)));
  });
  it('every extractor reads a field the digest entry actually has', () => {
    for (const [k, expr] of Object.entries(labels)) {
      const m = /^EXTRACT\(jsonPayload\.([a-z0-9_]+)\)$/.exec(expr);
      expect(m, k).not.toBeNull();
      expect(entry, `${k} -> ${m![1]}`).toHaveProperty(m![1]);
    }
  });
  it('includes the three visitor lines', () => {
    expect(labels).toMatchObject({
      visitors_past: 'EXTRACT(jsonPayload.visitors_past_text)',
      visitors_prev: 'EXTRACT(jsonPayload.visitors_prev_text)',
      visitors_month: 'EXTRACT(jsonPayload.visitors_month_text)',
    });
  });
  it('label values stay short enough for the notification', () => {
    for (const k of ['visitors_past_text', 'visitors_prev_text', 'visitors_month_text'] as const) expect(entry[k].length).toBeLessThan(400);
  });
});

describe('pipeline/deploy.sh', () => {
  const sh = readFileSync(join(root, 'pipeline/deploy.sh'), 'utf8');
  it('grants the pipeline SA BigQuery read + jobUser, and nothing to humans', () => {
    expect(sh).toMatch(/for role in roles\/aiplatform\.user roles\/logging\.logWriter roles\/bigquery\.jobUser; do/);
    expect(sh).toContain('{role: "READER", userByEmail: $sa}');
    expect(sh).not.toMatch(/--member\s+"?user:/);
    expect(sh).not.toContain('allUsers');
    expect(sh).not.toMatch(/keys create/);
  });
  it('reads the digest template and extractors from pipeline/alerts', () => {
    expect(sh).toContain('DOC_DIGEST=$(cat "$ROOT/pipeline/alerts/weekly_digest.md")');
    expect(sh).toContain('DIGEST_LABELS=$(jq -c . "$ROOT/pipeline/alerts/weekly_digest_labels.json")');
  });
  it('creates the /health uptime check every 5 min from Asia Pacific (Singapore) and other regions', () => {
    expect(sh).toContain('httpCheck: { path: "/health"');
    expect(sh).toContain('period: "300s"');
    expect(sh).toContain('selectedRegions: ["ASIA_PACIFIC", "USA_OREGON", "EUROPE"]');
  });
  it('keeps AUTO_PUBLISH as deployed unless set explicitly', () => {
    expect(sh).toContain('if [[ -z "${AUTO_PUBLISH:-}" ]]; then');
  });
});

describe('web deploy.sh: visits schema', () => {
  const sh = readFileSync(join(root, 'deploy/deploy.sh'), 'utf8');
  it('adds week_first as a NULLABLE BOOL in place, before the service deploy', () => {
    expect(sh).toContain('name: "week_first", type: "BOOL", mode: "NULLABLE"');
    expect(sh.indexOf('retry 3 ensure_week_first')).toBeGreaterThan(0);
    expect(sh.indexOf('retry 3 ensure_week_first')).toBeLessThan(sh.indexOf('gcloud run deploy'));
    expect(sh).not.toMatch(/DELETE\s+"\$\{BQ\}\/datasets\/\$\{DATASET\}\/tables/);
  });
});

describe('sources.yaml: Montessori Academy', () => {
  const sf = loadSourcesFile(join(root, 'pipeline/sources.yaml'));
  const raw = readFileSync(join(root, 'pipeline/sources.yaml'), 'utf8');
  it('is disabled, with the reason', () => {
    const s = sf.sources.find((x) => x.id === 'montessori-academy')!;
    expect(s.enabled).toBe(false);
    expect(s.notes).toMatch(/Disabled 2026-10-19: returns 403 to Cloud Run/);
    const block = raw.slice(raw.indexOf('- id: montessori-academy'), raw.indexOf('- id: montessori-from-the-heart'));
    expect(block).toMatch(/# Disabled 2026-10-19: the site returns HTTP 403 to requests from Cloud Run/);
  });
  it('other Montessori sources stay enabled', () => {
    expect(sf.sources.filter((x) => x.philosophy?.includes('montessori') && x.enabled !== false).length).toBeGreaterThan(0);
  });
});
