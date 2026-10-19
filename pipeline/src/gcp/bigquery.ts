/**
 * Read-only BigQuery access for the weekly digest's visitor numbers (SDD §9.1).
 * REST `jobs.query` with named DATE parameters; token from the metadata server (no keys).
 * Needs roles/bigquery.dataViewer on dataset `babysteps` and roles/bigquery.jobUser on the project.
 */
import { addDays } from '../config';
import { getAccessToken } from './auth';

export type QueryRow = Record<string, string | null>;
/** Runs a standard-SQL query with DATE parameters and returns rows as {column: string|null}. */
export type BqQuery = (sql: string, dateParams: Record<string, string>) => Promise<QueryRow[]>;

interface QueryResponse {
  jobComplete?: boolean;
  jobReference?: { jobId: string; location?: string };
  schema?: { fields: { name: string }[] };
  rows?: { f: { v: string | null }[] }[];
  errors?: { message: string }[];
  error?: { message: string };
}

export function createBigQuery(opts: { project: string; location: string; fetchFn?: typeof fetch; token?: () => Promise<string> }): BqQuery {
  const f = opts.fetchFn ?? fetch;
  const token = opts.token ?? getAccessToken;
  const base = `https://bigquery.googleapis.com/bigquery/v2/projects/${opts.project}`;
  return async (sql, dateParams) => {
    const headers = { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' };
    const body = {
      query: sql,
      useLegacySql: false,
      location: opts.location,
      timeoutMs: 30_000,
      parameterMode: 'NAMED',
      queryParameters: Object.entries(dateParams).map(([name, value]) => ({ name, parameterType: { type: 'DATE' }, parameterValue: { value } })),
    };
    let r = await f(`${base}/queries`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    let j = (await r.json()) as QueryResponse;
    for (let i = 0; r.ok && j.jobComplete === false && j.jobReference && i < 10; i++) {
      const loc = encodeURIComponent(j.jobReference.location ?? opts.location);
      r = await f(`${base}/queries/${j.jobReference.jobId}?location=${loc}&timeoutMs=10000`, { headers, signal: AbortSignal.timeout(30_000) });
      j = (await r.json()) as QueryResponse;
    }
    if (!r.ok || j.error) throw new Error(`bigquery query ${r.status}: ${j.error?.message ?? ''}`.trim());
    if (j.errors?.length) throw new Error(`bigquery query: ${j.errors[0].message}`);
    if (j.jobComplete === false) throw new Error('bigquery query: timed out');
    const names = (j.schema?.fields ?? []).map((x) => x.name);
    return (j.rows ?? []).map((row) => Object.fromEntries(names.map((n, i) => [n, row.f[i]?.v ?? null])));
  };
}

/** Raw visitor counts for the digest. */
export interface VisitCounts {
  /** rows with week_first = true in the window */
  visitors: number;
  /** rows with day_first = true in the window */
  visitor_days: number;
  /** rows in the window with week_first NULL (old clients that don't report the week) */
  legacy_rows: number;
}

export interface VisitStats {
  /** the 7 complete days before the run date (on Mondays: the previous ISO week, Mon–Sun) */
  current: VisitCounts & { start: string; end: string };
  /** the 7 days before that */
  previous: VisitCounts & { start: string; end: string };
  /** month_first = true rows from the 1st of the run date's month (SGT) up to the run date */
  month: { visitors: number; start: string; end: string };
  /** earliest date with a non-NULL week_first, or null if there is none yet */
  week_first_since: string | null;
}

/** The date windows for a digest run on `today` (YYYY-MM-DD, Singapore). */
export function visitWindows(today: string) {
  return {
    cur_start: addDays(today, -7),
    cur_end: addDays(today, -1),
    prev_start: addDays(today, -14),
    prev_end: addDays(today, -8),
    month_start: `${today.slice(0, 7)}-01`,
    today,
  };
}

/** One query, one row. `table` is `project.dataset.table`. */
export function visitStatsSql(table: string): string {
  if (!/^[a-z0-9-]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(table)) throw new Error(`bad table name: ${table}`);
  const t = `\`${table}\``;
  return `SELECT
  COUNTIF(week_first IS TRUE AND date BETWEEN @cur_start AND @cur_end) AS visitors_cur,
  COUNTIF(day_first IS TRUE AND date BETWEEN @cur_start AND @cur_end) AS visitor_days_cur,
  COUNTIF(week_first IS NULL AND date BETWEEN @cur_start AND @cur_end) AS legacy_cur,
  COUNTIF(week_first IS TRUE AND date BETWEEN @prev_start AND @prev_end) AS visitors_prev,
  COUNTIF(day_first IS TRUE AND date BETWEEN @prev_start AND @prev_end) AS visitor_days_prev,
  COUNTIF(week_first IS NULL AND date BETWEEN @prev_start AND @prev_end) AS legacy_prev,
  COUNTIF(month_first IS TRUE AND date BETWEEN @month_start AND @today) AS visitors_month,
  (SELECT MIN(date) FROM ${t} WHERE week_first IS NOT NULL AND date <= @today) AS week_first_since
FROM ${t}
WHERE date BETWEEN LEAST(@prev_start, @month_start) AND @today`;
}

export async function queryVisitStats(query: BqQuery, table: string, today: string): Promise<VisitStats> {
  const w = visitWindows(today);
  const rows = await query(visitStatsSql(table), w);
  const r = rows[0] ?? {};
  const n = (k: string) => Number(r[k] ?? 0);
  return {
    current: { start: w.cur_start, end: w.cur_end, visitors: n('visitors_cur'), visitor_days: n('visitor_days_cur'), legacy_rows: n('legacy_cur') },
    previous: { start: w.prev_start, end: w.prev_end, visitors: n('visitors_prev'), visitor_days: n('visitor_days_prev'), legacy_rows: n('legacy_prev') },
    month: { start: w.month_start, end: today, visitors: n('visitors_month') },
    week_first_since: r.week_first_since ?? null,
  };
}
