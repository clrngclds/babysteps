/**
 * Maintenance jobs (SDD §8.6): link check, event expiry, date confirmation, venue re-check, coverage guard.
 * Each returns proposed changes; the job runner decides whether they are published or staged.
 */
import { CATEGORY_IDS, publishedActivities } from '../../../scripts/catalog-lib';
import type { Activity, ContentSet, Fetcher, Outing, PageContext } from '../types';
import { extractDates } from '../fetch/parsers';
import { fetchPage } from '../fetch/discover';

/* ------------------------------------------------------------------ link check (weekly) */

export interface LinkHealth {
  /** url -> consecutive weekly failures */
  urls: Record<string, { fails: number; last_status: number; last_error?: string; last_checked: string }>;
}

/**
 * 404/410, 5xx and network errors count as failures. 401/403/429, bot challenges (e.g. AWS WAF
 * returning 202 with no content) and robots blocks are inconclusive: they never retire an item.
 */
export function classifyStatus(status: number, error?: string): 'ok' | 'fail' | 'inconclusive' {
  if (error === 'robots_disallowed' || error === 'bot_challenge') return 'inconclusive';
  if (status >= 200 && status < 400) return 'ok';
  if (status === 401 || status === 403 || status === 429) return 'inconclusive';
  return 'fail';
}

export interface LinkCheckResult {
  checked: number;
  failing: { url: string; fails: number; status: number; error?: string }[];
  /** Records whose URL failed 2 weeks in a row. */
  retire: { id: string; reason: string }[];
}

/** Every published activity source_url and outing url, deduplicated, with the record ids using it. */
export function linkTargets(c: ContentSet): Map<string, string[]> {
  const m = new Map<string, string[]>();
  const add = (url: string, id: string) => m.set(url, [...(m.get(url) ?? []), id]);
  for (const a of publishedActivities(c.activities)) if (a.source_url) add(a.source_url, a.id);
  for (const o of c.outings) if (!o.status || o.status === 'published') add(o.url, o.id);
  return m;
}

export async function linkCheck(
  c: ContentSet,
  fetcher: Fetcher,
  health: LinkHealth,
  today: string,
  failWeeks = 2,
): Promise<LinkCheckResult> {
  const targets = linkTargets(c);
  const failing: LinkCheckResult['failing'] = [];
  const retire: LinkCheckResult['retire'] = [];
  await Promise.all(
    [...targets.keys()].map(async (url) => {
      let r = await fetcher.get(url, { method: 'HEAD' });
      // Many sites reject HEAD; confirm with GET before counting a failure.
      if (classifyStatus(r.status, r.error) !== 'ok' && r.error !== 'robots_disallowed') r = await fetcher.get(url, { maxBytes: 64 * 1024 });
      const verdict = classifyStatus(r.status, r.error);
      const prev = health.urls[url];
      // Only count one failure per day, so a manual re-run doesn't speed up retirement.
      const sameDay = prev?.last_checked === today;
      if (verdict === 'ok') health.urls[url] = { fails: 0, last_status: r.status, last_checked: today };
      else if (verdict === 'fail') {
        const fails = sameDay ? prev.fails : (prev?.fails ?? 0) + 1;
        health.urls[url] = { fails, last_status: r.status, last_error: r.error, last_checked: today };
        failing.push({ url, fails, status: r.status, error: r.error });
        if (fails >= failWeeks)
          for (const id of targets.get(url) ?? [])
            retire.push({ id, reason: `link failed ${fails} weeks in a row (${r.status || r.error})` });
      } else {
        health.urls[url] = { fails: prev?.fails ?? 0, last_status: r.status, last_error: r.error, last_checked: today };
      }
    }),
  );
  // Forget URLs that are no longer referenced.
  for (const url of Object.keys(health.urls)) if (!targets.has(url)) delete health.urls[url];
  return { checked: targets.size, failing, retire };
}

/* ------------------------------------------------------------------ event expiry (daily) */

/** Published events whose end date (or start date when there is no end) is before today. */
export function expiredEvents(outings: Outing[], today: string): { id: string; reason: string }[] {
  return outings
    .filter((o) => o.type === 'event' && (!o.status || o.status === 'published'))
    .filter((o) => {
      const end = o.end_date ?? o.start_date;
      return !!end && end < today;
    })
    .map((o) => ({ id: o.id, reason: `event ended ${o.end_date ?? o.start_date}` }));
}

/* ------------------------------------------------------------------ date confirmation (weekly) */

export interface DateCheck {
  id: string;
  result: 'confirmed' | 'not_found' | 'fetch_failed';
  patch?: Partial<Outing>;
  page?: PageContext;
}

/** True when every stored date of the outing appears on the page. */
export function datesOnPage(o: Outing, text: string, today: string): boolean {
  const found = new Set(extractDates(text, today));
  const want = [o.start_date, o.end_date].filter((d): d is string => !!d);
  return want.length > 0 && want.every((d) => found.has(d));
}

/**
 * Re-checks published events with dates_confirmed: false against their page. When the stored dates
 * now appear, the outing is confirmed. Otherwise the page is returned so the caller can re-extract.
 */
export async function confirmDates(c: ContentSet, fetcher: Fetcher, today: string): Promise<DateCheck[]> {
  const todo = c.outings.filter((o) => o.dates_confirmed === false && (!o.status || o.status === 'published'));
  return Promise.all(
    todo.map(async (o): Promise<DateCheck> => {
      const p = await fetchPage(fetcher, o.url);
      if ('error' in p) return { id: o.id, result: 'fetch_failed' };
      if (datesOnPage(o, p.text, today)) return { id: o.id, result: 'confirmed', patch: { dates_confirmed: true, last_verified: today } };
      return { id: o.id, result: 'not_found', page: p };
    }),
  );
}

/* ------------------------------------------------------------------ coverage guard (weekly) */

export interface Cell {
  month: number;
  category: string;
  count: number;
}

export function coverageCounts(acts: Activity[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of publishedActivities(acts)) m.set(`${a.month}|${a.category}`, (m.get(`${a.month}|${a.category}`) ?? 0) + 1);
  return m;
}

/** Month x category cells with fewer than `min` published activities. */
export function thinCells(acts: Activity[], min = 2): Cell[] {
  const counts = coverageCounts(acts);
  const out: Cell[] = [];
  for (let month = 0; month <= 36; month++)
    for (const category of CATEGORY_IDS) {
      const count = counts.get(`${month}|${category}`) ?? 0;
      if (count < min) out.push({ month, category, count });
    }
  return out;
}

/**
 * Splits proposed activity retirements into those that keep every cell at >= min and those that
 * would break coverage. Deferred ones stay published until the coverage guard fills the cell, so a
 * dead link never blocks the whole publish (G9 would otherwise reject the run).
 */
export function splitRetirements(
  c: ContentSet,
  retire: { id: string; reason: string }[],
  min = 2,
): { now: { id: string; reason: string }[]; deferred: { id: string; reason: string; month: number; category: string }[] } {
  const counts = coverageCounts(c.activities);
  const byId = new Map(c.activities.map((a) => [a.id, a]));
  const now: { id: string; reason: string }[] = [];
  const deferred: { id: string; reason: string; month: number; category: string }[] = [];
  const seen = new Set<string>();
  for (const r of retire) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const a = byId.get(r.id);
    if (!a) {
      now.push(r); // outing: no coverage rule
      continue;
    }
    const key = `${a.month}|${a.category}`;
    const n = counts.get(key) ?? 0;
    if (n - 1 >= min) {
      counts.set(key, n - 1);
      now.push(r);
    } else deferred.push({ ...r, month: a.month, category: a.category });
  }
  return { now, deferred };
}

/** Category words used to pick likely source pages for a coverage cell. */
export const CATEGORY_HINTS: Record<string, string[]> = {
  gross_motor: ['crawl', 'walk', 'tummy', 'climb', 'balance', 'motor', 'move', 'roll', 'sit', 'stand', 'ball', 'jump'],
  fine_motor: ['grasp', 'fine', 'pincer', 'stack', 'hand', 'finger', 'pour', 'thread', 'puzzle', 'draw', 'scribble'],
  language: ['language', 'talk', 'word', 'book', 'read', 'song', 'speech', 'sign', 'story', 'babble'],
  social_emotional: ['social', 'emotion', 'feel', 'friend', 'share', 'mirror', 'peekaboo', 'independence', 'separation'],
  cognitive: ['cognitive', 'object', 'permanence', 'sort', 'match', 'problem', 'cause', 'puzzle', 'color', 'count'],
  other: ['practical', 'routine', 'nature', 'music', 'sensory', 'water', 'garden', 'kitchen', 'outdoor', 'care'],
};

/** Ranks known article URLs for a cell: category hint words in the URL/title, newest first. */
export function rankPagesForCell(
  pages: { url: string; title?: string; date?: string }[],
  cell: { month: number; category: string },
  limit = 3,
): string[] {
  const hints = CATEGORY_HINTS[cell.category] ?? [];
  const score = (p: { url: string; title?: string }) => {
    const s = `${p.url} ${p.title ?? ''}`.toLowerCase();
    let n = hints.filter((h) => s.includes(h)).length;
    if (/\b(month|months|mo)\b|\d+-month/.test(s)) n += 1;
    if (s.includes(`${cell.month}-month`) || s.includes(`${cell.month} month`)) n += 2;
    return n;
  };
  return pages
    .map((p) => ({ p, s: score(p) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (b.p.date ?? '').localeCompare(a.p.date ?? ''))
    .slice(0, limit)
    .map((x) => x.p.url);
}
