/**
 * Automated gates G1-G9 (SDD §8.4). A candidate is published only if every gate passes.
 * Gates return GateFailure[] (empty = pass) so the quarantine log can show every reason at once.
 */
import {
  REGION,
  checkpointFor,
  nextCheckpoint,
  publishedActivities,
  validate,
  validateActivity,
  validateOuting,
  type RawData,
} from '../../../scripts/catalog-lib';
import type {
  Activity,
  ActivityDraft,
  Candidate,
  ContentSet,
  GateContext,
  GateFailure,
  GateId,
  GateOutcome,
  Outing,
  OutingDraft,
  PageContext,
  QuotaLimits,
  ReviewScores,
  SafetyRulesFile,
  SourcesFile,
} from '../types';
import { DEFAULT_QUOTAS, MAX_ATTEMPTS } from '../types';
import { checkSafety } from './safety';
import { keywords, normalizeText, similarity, stem, tokens } from './text';

/** G2: a supporting quote shorter than this proves little (a phrase like "tummy time" is on every page). */
export const MIN_QUOTE_WORDS = 8;
/**
 * G2 own-words rule: this many consecutive words identical to the page = copied text. Short stock
 * phrases ("put a few toys just out of reach") stay well under 12 words; a run of 12 is a copied sentence.
 */
export const COPY_RUN_WORDS = 12;
/** G5: every reviewer score must be at least this (out of 5). */
export const REVIEW_MIN_SCORE = 4;
/** G6: title or summary similarity at or above this = duplicate. */
export const DUP_SIMILARITY = 0.8;
/** G6: a lower bar when the item comes from the same page as an existing one. */
export const SAME_URL_TITLE_SIMILARITY = 0.6;
/** G6: activities are compared with existing ones within this many months either side. */
export const DEDUPE_MONTH_WINDOW = 2;
/** G8: tag-balance threshold (SDD §8.8). */
export const LOVEVERY_SHARE_LIMIT = 0.6;

const TEMP_ID = 'candidate';
const fail = (gate: GateId, reason: string, fixable = false): GateFailure => ({ gate, reason, fixable });
const act = (c: Candidate) => c.draft as ActivityDraft;
const out = (c: Candidate) => c.draft as OutingDraft;
const titleOf = (c: Candidate): string => (c.kind === 'activity' ? act(c).title : out(c).name) ?? '';

/* ---------------------------------------------------------------------------------------------- */
/* G1 Schema                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/** The record as it will be merged (SDD §8.5): temp id, verified, added_at today, published, pipeline. */
export function toRecord(c: Candidate, today: string): Activity | Outing {
  if (c.kind === 'activity') {
    return { ...act(c), id: TEMP_ID, verified: true, added_at: today, status: 'published', origin: 'pipeline' };
  }
  return { ...out(c), id: TEMP_ID, added_at: today, last_verified: today, status: 'published', origin: 'pipeline' };
}

const ABBREVIATIONS = new Set(['dr', 'mr', 'mrs', 'ms', 'st', 'mt', 'no', 'vs', 'approx', 'etc', 'eg', 'ie', 'ave', 'blk']);

/**
 * Sentence count for "one sentence" / "1-5 sentences" checks. Quoted speech ("Where is your nose?
 * Your elbow?") and abbreviations ("S.E.A. Aquarium", "e.g. a spoon") don't end a sentence.
 */
export function countSentences(s: string): number {
  const t = (s ?? '')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/"[^"]*"/g, 'Q')
    .replace(/(^|[\s(])'[^']*'(?=[\s.,!?;:)]|$)/g, '$1Q');
  if (!t) return 0;
  let n = 1;
  const re = /[.!?]+(?=\s+["'(]?[A-Z0-9])/g;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const before = t.slice(0, m.index + 1);
    const word = /([A-Za-z.]+)\.$/.exec(before)?.[1] ?? '';
    if (/^([A-Za-z]\.)*[A-Za-z]$/.test(word) || ABBREVIATIONS.has(word.replace(/\./g, '').toLowerCase())) continue;
    n++;
  }
  return n;
}

/** Checkpoints an activity's milestones may come from: its current and next (CDC) checkpoint. */
export function allowedMilestoneMonths(month: number, checkpoints: number[]): number[] {
  const cp = checkpointFor(month, checkpoints);
  const next = nextCheckpoint(cp, checkpoints);
  if (next !== null) return [cp, next];
  // Last band (31-36 months): there is no next checkpoint; the dataset links these to the
  // previous (30-month) checkpoint, so allow that too.
  const prev = [...checkpoints].sort((a, b) => a - b).filter((c) => c < cp).pop();
  return prev === undefined ? [cp] : [cp, prev];
}

/** G1: schema, allowed values, milestones resolve and fit the age; title/summary/how-to shape. Non-fixable. */
export function g1Schema(c: Candidate, ctx: Pick<GateContext, 'content' | 'today'>): GateFailure[] {
  const errs: string[] = [];
  if (!c.draft || typeof c.draft !== 'object') return [fail('G1', 'draft is missing')];
  const rec = toRecord(c, ctx.today);
  const ms = ctx.content.milestones;
  const strip = (e: string) => e.replace(new RegExp(`^${TEMP_ID}:\\s*`), '');
  if (c.kind === 'activity') {
    const a = rec as Activity;
    const msById = new Map(ms.milestones.map((m) => [m.id, m]));
    errs.push(...validateActivity(a, new Set(msById.keys())).errors.map(strip));
    if (Number.isInteger(a.month) && Array.isArray(a.milestone_ids)) {
      const allowed = allowedMilestoneMonths(a.month, ms.checkpoints_months);
      for (const id of a.milestone_ids) {
        const m = msById.get(id);
        if (m && !allowed.includes(m.month))
          errs.push(`milestone ${id} is from the ${m.month}-month checkpoint; month ${a.month} activities link to ${allowed.join(' or ')}-month milestones`);
      }
    }
    checkTitle(a.title, 80, errs);
    if (typeof a.summary === 'string' && a.summary.trim() && countSentences(a.summary) !== 1)
      errs.push(`summary must be one sentence (has ${countSentences(a.summary)})`);
    if (typeof a.how_to === 'string' && a.how_to.trim()) {
      const n = countSentences(a.how_to);
      if (n < 1 || n > 5) errs.push(`how_to must be 1-5 sentences (has ${n})`);
    }
  } else {
    const o = rec as Outing;
    // "event without start_date" is G7's job: it is fixable (dates are often posted later).
    errs.push(...validateOuting(o).errors.map(strip).filter((e) => !/event without start_date/.test(e)));
    checkTitle(o.name, 120, errs);
    if (typeof o.summary === 'string' && o.summary.trim() && countSentences(o.summary) !== 1)
      errs.push(`summary must be one sentence (has ${countSentences(o.summary)})`);
    if (typeof o.dates_confirmed !== 'boolean') errs.push('dates_confirmed must be boolean');
  }
  return errs.map((e) => fail('G1', e));
}

function checkTitle(t: unknown, maxLen: number, errs: string[]) {
  if (typeof t !== 'string' || !t.trim()) return; // validate*() already reports empty titles
  const s = t.trim();
  if (s.length < 3 || s.length > maxLen) errs.push(`title length ${s.length} (want 3-${maxLen} characters)`);
  if (/[\r\n]/.test(s)) errs.push('title contains a line break');
}

/* ---------------------------------------------------------------------------------------------- */
/* G2 Grounding                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

/**
 * G2: the supporting quote appears word-for-word on the page (case, quote style, punctuation and
 * spacing ignored), at least half the title keywords appear on the page, and no field copies a run of
 * COPY_RUN_WORDS words from the page (own-words rule, SDD §8.8). Only "page text empty" is fixable.
 */
export function g2Grounding(c: Candidate, page: PageContext): GateFailure[] {
  const pageTokens = tokens(page?.text ?? '');
  if (!pageTokens.length) return [fail('G2', 'page text empty (page may not have loaded)', true)];
  const fails: GateFailure[] = [];
  const pageJoined = ` ${pageTokens.join(' ')} `;

  const q = tokens(c.supporting_quote ?? '');
  if (q.length < MIN_QUOTE_WORDS) fails.push(fail('G2', `supporting quote has ${q.length} words (need at least ${MIN_QUOTE_WORDS})`));
  else if (!pageJoined.includes(` ${q.join(' ')} `)) fails.push(fail('G2', 'supporting quote not found word-for-word on the page'));

  const kw = keywords(titleOf(c));
  const pageStems = new Set(pageTokens.map(stem));
  const found = kw.filter((k) => pageStems.has(stem(k)));
  const need = Math.max(1, Math.ceil(kw.length / 2));
  if (!kw.length) fails.push(fail('G2', 'title has no keywords to check against the page'));
  else if (found.length < need) {
    const missing = kw.filter((k) => !found.includes(k));
    fails.push(fail('G2', `title keywords not on the page: ${missing.join(', ')} (${found.length}/${kw.length} found, need ${need})`));
  }

  const grams = new Set<string>();
  for (let i = 0; i + COPY_RUN_WORDS <= pageTokens.length; i++) grams.add(pageTokens.slice(i, i + COPY_RUN_WORDS).join(' '));
  const fields: [string, unknown][] =
    c.kind === 'activity'
      ? [['title', act(c).title], ['summary', act(c).summary], ['how_to', act(c).how_to]]
      : [['name', out(c).name], ['summary', out(c).summary]];
  for (const [name, v] of fields) {
    const t = tokens(typeof v === 'string' ? v : '');
    for (let i = 0; i + COPY_RUN_WORDS <= t.length; i++) {
      const g = t.slice(i, i + COPY_RUN_WORDS).join(' ');
      if (grams.has(g)) {
        fails.push(fail('G2', `${name} copies ${COPY_RUN_WORDS}+ words from the page ("${g}"); must be in our own words`));
        break;
      }
    }
  }
  return fails;
}

/* ---------------------------------------------------------------------------------------------- */
/* G3 Source allow-list                                                                            */
/* ---------------------------------------------------------------------------------------------- */

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** host equals the domain or is a subdomain of it; "www." ignored on both. */
function hostMatches(host: string, domain: string): boolean {
  const d = domain.toLowerCase().trim().replace(/^\*\./, '').replace(/^www\./, '');
  return !!d && (host === d || host.endsWith(`.${d}`));
}

/** Domains that may be published: every tier-1 source's domains plus sources.yaml official_domains. */
export function publishableDomains(sources: SourcesFile): string[] {
  return [...sources.sources.filter((s) => s.tier === 1).flatMap((s) => s.domains ?? []), ...(sources.official_domains ?? [])];
}

/**
 * G3: the page the candidate came from and its source link must be on a tier-1 domain.
 * official_domains also count: sources.yaml lists them precisely as the official/organiser pages
 * tier-2 discoveries resolve to (SDD §8.3 step 3). Tier-2 (aggregator) hosts are never publishable.
 */
export function g3AllowList(c: Candidate, sources: SourcesFile): GateFailure[] {
  const allowed = publishableDomains(sources);
  const link = c.kind === 'activity' ? act(c).source_url : out(c).url;
  const fails: GateFailure[] = [];
  for (const [what, url] of [['page_url', c.page_url], [c.kind === 'activity' ? 'source_url' : 'url', link]] as const) {
    const host = hostOf(url ?? '');
    if (!host) fails.push(fail('G3', `${what} is not a valid URL`));
    else if (!allowed.some((d) => hostMatches(host, d))) fails.push(fail('G3', `${what} host ${host} is not a tier-1 source`));
  }
  return fails;
}

/* ---------------------------------------------------------------------------------------------- */
/* G4 Safety, G5 AI review                                                                         */
/* ---------------------------------------------------------------------------------------------- */

export function g4Safety(c: Candidate, rules: SafetyRulesFile): GateFailure[] {
  return checkSafety(c, rules);
}

const SCORE_KEYS = ['age_appropriate', 'safety', 'no_medical_claims', 'not_product_only'] as const;

/** G5: AI reviewer; every score >= 4. Stores scores on c.review. A reviewer error is fixable (retried). */
export async function g5Review(c: Candidate, ctx: Pick<GateContext, 'review' | 'page'>): Promise<GateFailure[]> {
  let s: ReviewScores;
  try {
    s = await ctx.review(c, ctx.page);
  } catch (e) {
    return [fail('G5', `AI review failed: ${(e as Error)?.message ?? String(e)}`, true)];
  }
  if (!s || SCORE_KEYS.some((k) => typeof s[k] !== 'number' || Number.isNaN(s[k])))
    return [fail('G5', 'AI review returned incomplete scores', true)];
  c.review = s;
  const low = SCORE_KEYS.filter((k) => s[k] < REVIEW_MIN_SCORE);
  if (!low.length) return [];
  const notes = s.notes?.trim() ? ` Notes: ${s.notes.trim()}` : '';
  return [fail('G5', `AI review below ${REVIEW_MIN_SCORE}/5: ${low.map((k) => `${k} ${s[k]}`).join(', ')}.${notes}`)];
}

/* ---------------------------------------------------------------------------------------------- */
/* G6 Duplicates                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

/** URL identity for "same source page": lowercase host, no www, no fragment, no utm_*, no trailing slash. */
export function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = '';
    for (const k of [...url.searchParams.keys()]) if (/^utm_/i.test(k)) url.searchParams.delete(k);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '');
    return `${host}${path}${url.search}`;
  } catch {
    return (u ?? '').trim().toLowerCase();
  }
}

const isLive = (r: { status?: string; verified?: boolean }) => (r.status === undefined || r.status === 'published') && r.verified !== false;

/** Date range of an outing; no dates = always open (venues, undated programmes). */
function range(o: Pick<Outing, 'start_date' | 'end_date'>): [string, string] {
  if (!o.start_date) return ['0000-00-00', '9999-12-31'];
  return [o.start_date, o.end_date ?? o.start_date];
}

/**
 * G6: duplicates of existing content or of candidates already accepted this run. Non-fixable.
 * Retired items count only for the same-page check, so a closed venue or a dead-link activity isn't
 * re-added from the same page; they are ignored for the similarity check, because users no longer
 * see them and a fresh item may legitimately take their place. A venue update (replaces_id) is not
 * compared with the record it replaces.
 *  - Activities: same source_url + title similarity >= 0.6 (any month), or title/summary
 *    similarity >= 0.8 to a live activity within +-2 months.
 *  - Outings: name similarity >= 0.8 (>= 0.6 on the same url) AND date ranges overlap, where an
 *    outing without dates (venue) overlaps everything. So a new edition of an annual event is
 *    allowed when its dates differ.
 */
export function g6Dedupe(c: Candidate, content: Pick<ContentSet, 'activities' | 'outings'>, acceptedSoFar: Candidate[] = []): GateFailure[] {
  const accepted = acceptedSoFar.filter((x) => x.kind === c.kind).map((x) => toRecord(x, '0000-00-00'));
  if (c.kind === 'activity') {
    const a = act(c);
    const pool = [...content.activities, ...(accepted as Activity[])].filter((e) => !c.replaces_id || e.id !== c.replaces_id);
    const url = normalizeUrl(a.source_url ?? '');
    for (const e of pool) {
      const ts = similarity(a.title ?? '', e.title ?? '');
      if (url && normalizeUrl(e.source_url ?? '') === url && ts >= SAME_URL_TITLE_SIMILARITY)
        return [fail('G6', `same source page and similar title as ${label(e.id, e.title)} (similarity ${ts.toFixed(2)})`)];
    }
    for (const e of pool) {
      if (!isLive(e) || Math.abs((e.month ?? -99) - (a.month ?? 99)) > DEDUPE_MONTH_WINDOW) continue;
      const ts = similarity(a.title ?? '', e.title ?? '');
      const ss = similarity(a.summary ?? '', e.summary ?? '');
      if (ts >= DUP_SIMILARITY || ss >= DUP_SIMILARITY)
        return [fail('G6', `too similar to ${label(e.id, e.title)} at month ${e.month} (title ${ts.toFixed(2)}, summary ${ss.toFixed(2)})`)];
    }
    return [];
  }
  const o = out(c);
  const pool = [...content.outings, ...(accepted as Outing[])].filter((e) => !c.replaces_id || e.id !== c.replaces_id);
  const url = normalizeUrl(o.url ?? '');
  const [s1, e1] = range(o);
  for (const e of pool) {
    const sameUrl = !!url && normalizeUrl(e.url ?? '') === url;
    if (!sameUrl && !isLive(e)) continue;
    const ns = similarity(o.name ?? '', e.name ?? '');
    if (ns < (sameUrl ? SAME_URL_TITLE_SIMILARITY : DUP_SIMILARITY)) continue;
    const [s2, e2] = range(e);
    if (s1 <= e2 && s2 <= e1)
      return [fail('G6', `duplicate of ${label(e.id, e.name)} (name similarity ${ns.toFixed(2)}${sameUrl ? ', same url' : ''}, dates overlap)`)];
  }
  return [];
}

const label = (id: string, title: string) => (id && id !== TEMP_ID ? `${id} "${title}"` : `"${title}" (accepted earlier this run)`);

/* ---------------------------------------------------------------------------------------------- */
/* G7 Events                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const ORD = '(?:st|nd|rd|th)?';
const RANGE = '\\s*(?:-|to|until|till|&|and)\\s*';

function iso(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * Dates written on a page, as YYYY-MM-DD. Understands "13 Nov 2026", "13-14 November", "Nov 13, 2026",
 * "Nov 28 - Dec 3", "Friday, November 13, 2026", "2026-11-13" and "13/11/2026" (day first, as in
 * Singapore). A date without a year is returned for the reference year and the next one, which is
 * enough to answer "does the draft's date appear on the page". (The fetch area's extractDates may
 * replace this at integration.)
 */
function findDatesOnPage(text: string, refDate: string): string[] {
  const t = normalizeText(text);
  const refYear = Number(refDate.slice(0, 4)) || new Date().getUTCFullYear();
  const found = new Set<string>();
  const add = (y: string | undefined, m: number, d: number) => {
    const years = y ? [Number(y)] : [refYear, refYear + 1];
    for (const yr of years) {
      const v = iso(yr, m, d);
      if (v) found.add(v);
    }
  };
  const mon = (s: string) => MONTHS[s.slice(0, 3)];
  for (const m of t.matchAll(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g)) add(m[1], Number(m[2]), Number(m[3]));
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/g)) add(m[3], Number(m[2]), Number(m[1]));
  // Day first: "13 nov 2026", "13-14 nov", "13th of november"
  const dayFirst = new RegExp(`\\b(\\d{1,2})${ORD}(?:${RANGE}(\\d{1,2})${ORD})?\\s+(?:of\\s+)?${MON}\\.?(?:,?\\s+(20\\d{2}))?\\b`, 'g');
  for (const m of t.matchAll(dayFirst)) {
    add(m[4], mon(m[3]), Number(m[1]));
    if (m[2]) add(m[4], mon(m[3]), Number(m[2]));
  }
  // Month first: "nov 13, 2026", "nov 13-14, 2026", "nov 28 - dec 3, 2026"
  const monthFirst = new RegExp(`\\b${MON}\\.?\\s+(\\d{1,2})${ORD}(?:${RANGE}(?:${MON}\\.?\\s+)?(\\d{1,2})${ORD})?(?:,?\\s+(20\\d{2}))?\\b`, 'g');
  for (const m of t.matchAll(monthFirst)) {
    add(m[5], mon(m[1]), Number(m[2]));
    if (m[4]) add(m[5], mon(m[3] ?? m[1]), Number(m[4]));
  }
  return [...found].sort();
}

/** Hosts that are Singapore organisers by definition: outing sources and official domains in sources.yaml. */
export function singaporeHosts(sources: SourcesFile): string[] {
  return [...sources.sources.filter((s) => s.kind === 'outing').flatMap((s) => s.domains ?? []), ...(sources.official_domains ?? [])];
}

/**
 * G7 (outings only): Singapore location, not already over, age range overlaps 0-36, dates on the page.
 * Sets draft.dates_confirmed: true only when the start (and end) date appear on the page; false means
 * the app shows "check dates" and the item still passes. An event with no start date yet is a fixable
 * failure (retried next week). Venues and undated programmes skip the date checks.
 * Mutates c.draft (dates_confirmed); runCandidateGates passes it a copy.
 */
export function g7Events(c: Candidate, page: PageContext, today: string, sgHosts: string[] = []): GateFailure[] {
  if (c.kind !== 'outing') return [];
  const o = out(c);
  const fails: GateFailure[] = [];
  const location = typeof o.location === 'string' ? o.location.trim() : '';
  if (!REGION.includes(o.region) || !location) fails.push(fail('G7', 'no Singapore region/location'));
  else {
    const hosts = [o.url, page?.finalUrl, page?.url, c.page_url].map((u) => hostOf(u ?? '')).filter((h): h is string => !!h);
    const mentions = /\bsingapore\b/.test(normalizeText(`${location} ${page?.text ?? ''}`));
    const sgHost = hosts.some((h) => h.endsWith('.sg') || sgHosts.some((d) => hostMatches(h, d)));
    if (!mentions && !sgHost) fails.push(fail('G7', 'location not shown to be in Singapore (no mention on the page, not a Singapore site)'));
  }
  const min = o.min_age_months;
  const max = o.max_age_months;
  if (!(typeof min === 'number' && typeof max === 'number' && min <= 36 && max >= 0 && min <= max))
    fails.push(fail('G7', `age range ${min}-${max} months does not overlap 0-36`));

  if (!o.start_date) {
    if (o.type === 'event') fails.push(fail('G7', 'no dates found yet', true));
    return fails;
  }
  const last = o.end_date ?? o.start_date;
  if (last < today) fails.push(fail('G7', `already ended (${last})`));
  const dates = findDatesOnPage(page?.text ?? '', today);
  o.dates_confirmed = dates.includes(o.start_date) && (!o.end_date || dates.includes(o.end_date));
  return fails;
}

/* ---------------------------------------------------------------------------------------------- */
/* G8 Quotas, G9 Catalog                                                                           */
/* ---------------------------------------------------------------------------------------------- */

const isMontessoriOrReggio = (c: Candidate) => {
  const p = c.kind === 'activity' ? act(c).philosophy ?? [] : [];
  return (p.includes('montessori') || p.includes('reggio_emilia')) && !p.includes('lovevery');
};

/**
 * G8: at most maxActivities new activities and maxOutings new outings per run, and at most
 * maxActivitiesPerSource activities per source. When over quota, priority is:
 *  1. coverage-guard candidates (they keep every month x category at >= 2, without which G9 fails
 *     and nothing publishes),
 *  2. Montessori/Reggio activities (not also tagged Lovevery) when the published mix is over 60%
 *     Lovevery (SDD §8.8),
 *  3. the order given (source order).
 * Venue updates (purpose "venue-update") are not new items and don't count. Rejected candidates
 * are fixable, so they are retried next week.
 */
export function g8Quotas(
  passed: Candidate[],
  limits: QuotaLimits = DEFAULT_QUOTAS,
  mix: { loveveryShare: number } = { loveveryShare: 0 },
): { accepted: Candidate[]; rejected: GateOutcome[] } {
  const balance = mix.loveveryShare > LOVEVERY_SHARE_LIMIT;
  const order = passed
    .map((c, i) => ({ c, i, k: [c.purpose === 'coverage' ? 0 : 1, balance && isMontessoriOrReggio(c) ? 0 : 1, i] }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2]);
  let nAct = 0;
  let nOut = 0;
  const perSource = new Map<string, number>();
  const keep = new Set<number>();
  const rejected: GateOutcome[] = [];
  for (const { c, i } of order) {
    let reason: string | null = null;
    if (c.purpose === 'venue-update') {
      keep.add(i);
      continue;
    }
    if (c.kind === 'activity') {
      const n = perSource.get(c.source_id) ?? 0;
      if (nAct >= limits.maxActivities) reason = `quota: already ${limits.maxActivities} new activities this run`;
      else if (n >= limits.maxActivitiesPerSource) reason = `quota: already ${limits.maxActivitiesPerSource} new activities from ${c.source_id} this run`;
      else {
        nAct++;
        perSource.set(c.source_id, n + 1);
      }
    } else if (nOut >= limits.maxOutings) reason = `quota: already ${limits.maxOutings} new outings this run`;
    else nOut++;
    if (reason) rejected.push({ candidate: c, failures: [fail('G8', reason, true)] });
    else keep.add(i);
  }
  return { accepted: passed.filter((_, i) => keep.has(i)), rejected };
}

/** G9: full validation of the merged catalog, published-set coverage strict. Not ok = publish nothing. */
export function g9Catalog(merged: RawData): { ok: boolean; errors: string[]; warnings: string[] } {
  const r = validate(merged, { strictPublishedCoverage: true });
  return { ok: r.errors.length === 0, errors: r.errors, warnings: r.warnings };
}

/* ---------------------------------------------------------------------------------------------- */
/* Runner                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/** Runs one gate; a crash (malformed draft) becomes a non-fixable failure instead of stopping the run. */
function guard(gate: GateId, fn: () => GateFailure[]): GateFailure[] {
  try {
    return fn();
  } catch (e) {
    return [fail(gate, `gate error: ${(e as Error)?.message ?? String(e)}`)];
  }
}

/**
 * Per-candidate gates. Deterministic gates run in order G1, G3, G2, G4, G6, G7 and all failures are
 * collected (the quarantine log shows every reason). G5 (a Gemini call) runs only if they all pass.
 * G8 and G9 run on the whole batch (g8Quotas, g9Catalog). The input candidate is not modified; the
 * outcome carries a copy with G5 scores and G7's dates_confirmed.
 */
export async function runCandidateGates(c: Candidate, ctx: GateContext, acceptedSoFar: Candidate[] = []): Promise<GateOutcome> {
  const cand = structuredClone(c);
  const failures = [
    ...guard('G1', () => g1Schema(cand, ctx)),
    ...guard('G3', () => g3AllowList(cand, ctx.sources)),
    ...guard('G2', () => g2Grounding(cand, ctx.page)),
    ...guard('G4', () => g4Safety(cand, ctx.safety)),
    ...guard('G6', () => g6Dedupe(cand, ctx.content, acceptedSoFar)),
    ...guard('G7', () => g7Events(cand, ctx.page, ctx.today, singaporeHosts(ctx.sources))),
  ];
  if (!failures.length) failures.push(...(await g5Review(cand, ctx)));
  return { candidate: cand, failures };
}

/** Retry next week only if every failure is fixable and attempts remain. */
export function isRetryable(outcome: GateOutcome, maxAttempts: number = MAX_ATTEMPTS): boolean {
  return outcome.failures.length > 0 && outcome.failures.every((f) => f.fixable) && (outcome.candidate.attempts ?? 1) < maxAttempts;
}

/** Share (0-1) of published activities tagged Lovevery. */
export function loveveryShare(activities: Activity[]): number {
  const pub = publishedActivities(activities);
  if (!pub.length) return 0;
  return pub.filter((a) => (a.philosophy ?? []).includes('lovevery')).length / pub.length;
}
