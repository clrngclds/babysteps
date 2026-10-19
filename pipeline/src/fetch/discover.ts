/**
 * Discovery (SDD §8.2, §8.3): find new URLs per source using feed / sitemap / listing diffs
 * against state/seen_urls.json, then fetch pages and resolve tier-2 items to official pages.
 */
import { addDays } from '../config';
import type {
  DiscoverResult,
  DiscoverStats,
  DiscoveredItem,
  Fetcher,
  PageContext,
  SeenState,
  SourceConfig,
  SourcesFile,
} from '../types';
import { extractLinks, htmlToText, parseFeed, parseSitemap, stripElements, toIso } from './parsers';
import { compilePatterns, hostOf, isOfficialUrl } from './sources';

export const DEFAULT_MAX_ITEMS = 15;
/** On later runs, dated items older than this are recorded as seen but not processed. */
export const STALE_DAYS = 30;
/** Upper bound on child sitemaps read per source per run (big sites have hundreds). */
export const MAX_CHILD_SITEMAPS = 20;
/** Feeds and sitemaps can be several MB (NLB ~3 MB, Sassy Mama ~4.6 MB). */
const LIST_MAX_BYTES = 15 * 1024 * 1024;

const FEED_ACCEPT = 'application/rss+xml,application/atom+xml,application/xml;q=0.9,text/xml;q=0.9,*/*;q=0.8';
const XML_ACCEPT = 'application/xml,text/xml;q=0.9,*/*;q=0.8';

export function emptySeen(): SeenState {
  return { version: 1, initialized: {}, urls: {} };
}

export interface DiscoverOptions {
  /** YYYY-MM-DD (SGT). */
  today: string;
  firstRunWindowDays: number;
  runFrequency: 'weekly' | 'monthly';
}

interface RawItem {
  url: string;
  title?: string;
  date?: string;
  summary?: string;
  lastmod?: string;
}

function emptyStats(sourceId: string): DiscoverStats {
  return { sourceId, listed: 0, new: 0, selected: 0, seededOnly: 0, overCap: 0, errors: [] };
}

/** URL identity for seen-state: no fragment and no utm_* tracking parameters. */
export function normUrl(u: string): string {
  const i = u.indexOf('#');
  const s = (i < 0 ? u : u.slice(0, i)).trim();
  if (!/[?&]utm_/i.test(s)) return s;
  try {
    const url = new URL(s);
    for (const k of [...url.searchParams.keys()]) if (/^utm_/i.test(k)) url.searchParams.delete(k);
    return url.href;
  } catch {
    return s;
  }
}

/** Blog permalinks like /2026/10/14/slug/ carry the publication date. */
export function dateFromUrl(u: string): string | undefined {
  const m = /\/(20\d{2})\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\//.exec(u);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}

/** Lowercase, with URL punctuation turned into spaces so "story-time" matches "story time". */
function normText(s: string): string {
  return s.toLowerCase().replace(/[-_/+.%]+/g, ' ').replace(/\s+/g, ' ');
}

function matchesKeywords(item: RawItem, keywords: string[]): boolean {
  if (!keywords.length) return true;
  let path = item.url;
  try {
    const u = new URL(item.url);
    path = decodeURIComponent(u.pathname + u.search);
  } catch {
    // keep raw
  }
  const hay = normText([item.title ?? '', item.summary ?? '', path].join(' '));
  return keywords.some((k) => hay.includes(normText(k)));
}

export function filterItems(source: SourceConfig, items: RawItem[]): RawItem[] {
  const include = compilePatterns(source.include);
  const exclude = compilePatterns(source.exclude);
  const keywords = source.keywords ?? [];
  const seen = new Set<string>();
  const out: RawItem[] = [];
  for (const it of items) {
    const url = normUrl(it.url);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    if (include.length && !include.some((r) => r.test(url))) continue;
    if (exclude.some((r) => r.test(url))) continue;
    if (!matchesKeywords(it, keywords)) continue;
    seen.add(url);
    out.push({ ...it, url });
  }
  return out;
}

async function listFeed(source: SourceConfig, fetcher: Fetcher, url: string, errors: string[]): Promise<RawItem[] | null> {
  const r = await fetcher.get(url, { accept: FEED_ACCEPT, maxBytes: LIST_MAX_BYTES });
  if (!r.ok) {
    errors.push(`${url}: ${r.error ?? `http_${r.status}`}`);
    return null;
  }
  const items = parseFeed(r.body);
  if (!items.length && !/<(rss|feed|rdf:RDF)\b/i.test(r.body.slice(0, 5000))) {
    errors.push(`${url}: not a feed (${r.contentType || 'unknown type'})`);
    return null;
  }
  return items.map((i) => ({ url: i.url, title: i.title, date: i.published, summary: i.summary }));
}

async function listSitemap(source: SourceConfig, fetcher: Fetcher, url: string, errors: string[]): Promise<RawItem[] | null> {
  const childFilters = compilePatterns(source.child_sitemaps);
  const out: RawItem[] = [];
  let childrenRead = 0;
  let anyOk = false;

  const read = async (smUrl: string, depth: number): Promise<void> => {
    const r = await fetcher.get(smUrl, { accept: XML_ACCEPT, maxBytes: LIST_MAX_BYTES });
    if (!r.ok) {
      errors.push(`${smUrl}: ${r.error ?? `http_${r.status}`}`);
      return;
    }
    if (!/<(?:[\w-]+:)?(urlset|sitemapindex)[\s>]/i.test(r.body)) {
      errors.push(`${smUrl}: not a sitemap (${r.contentType || 'unknown type'})`);
      return;
    }
    anyOk = true;
    const sm = parseSitemap(r.body);
    if (sm.type === 'urlset') {
      // Bulk-restamped lastmods say nothing about when an item appeared, so don't use them as dates.
      const useAsDate = source.track_lastmod !== false;
      for (const e of sm.entries) out.push({ url: e.loc, date: useAsDate ? e.lastmod : undefined, lastmod: e.lastmod });
      return;
    }
    if (depth >= 2) return; // index -> index -> urlset is the deepest we follow
    let children = sm.entries.filter((e) => !childFilters.length || childFilters.some((re) => re.test(e.loc)));
    // Newest first, so the cap keeps the children most likely to hold new URLs.
    children = [...children].sort((a, b) => (b.lastmod ?? '').localeCompare(a.lastmod ?? ''));
    for (const c of children) {
      // Not an error: a routine cap would otherwise trip the "errors 3 weeks running" alert.
      if (childrenRead >= MAX_CHILD_SITEMAPS) return;
      childrenRead++;
      await read(c.loc, depth + 1);
    }
  };

  await read(url, 0);
  return anyOk ? out : null;
}

async function listListing(source: SourceConfig, fetcher: Fetcher, url: string, errors: string[]): Promise<RawItem[] | null> {
  const r = await fetcher.get(url);
  if (!r.ok) {
    errors.push(`${url}: ${r.error ?? `http_${r.status}`}`);
    return null;
  }
  const pageHosts = new Set([hostOf(url), hostOf(r.finalUrl), ...source.domains]);
  const self = new Set([normUrl(url), normUrl(r.finalUrl)]);
  return extractLinks(r.body, r.finalUrl)
    .filter((l) => pageHosts.has(hostOf(l.url)) && !self.has(l.url))
    .map((l) => ({ url: l.url, title: l.text || undefined }));
}

/**
 * Read one source and return the items to process this run. Mutates `seen`. Never throws.
 * First run: everything is recorded; only items dated within firstRunWindowDays are returned.
 */
export async function discoverSource(
  source: SourceConfig,
  fetcher: Fetcher,
  seen: SeenState,
  opts: DiscoverOptions,
): Promise<DiscoverResult> {
  const stats = emptyStats(source.id);
  if (source.enabled === false) {
    stats.skipped = 'disabled';
    return { items: [], stats };
  }
  if ((source.frequency ?? 'weekly') === 'monthly' && opts.runFrequency === 'weekly') {
    stats.skipped = 'monthly source; read on the monthly run only';
    return { items: [], stats };
  }

  try {
    const raw: RawItem[] = [];
    let okUrls = 0;
    for (const url of source.urls) {
      const list =
        source.detection === 'feed'
          ? await listFeed(source, fetcher, url, stats.errors)
          : source.detection === 'sitemap'
            ? await listSitemap(source, fetcher, url, stats.errors)
            : await listListing(source, fetcher, url, stats.errors);
      if (list) {
        okUrls++;
        raw.push(...list);
      }
    }

    const items = filterItems(source, raw);
    stats.listed = items.length;
    // Nothing could be read: leave state alone so the source is seeded on a later, working run.
    if (okUrls === 0) return { items: [], stats };

    const firstRun = !seen.initialized[source.id];
    const trackLastmod = source.detection === 'sitemap' && source.track_lastmod !== false;
    const windowStart = addDays(opts.today, -(firstRun ? opts.firstRunWindowDays : STALE_DAYS));
    const candidates: DiscoveredItem[] = [];

    for (const it of items) {
      if (!it.date) it.date = dateFromUrl(it.url);
      const prev = seen.urls[it.url];
      const changed = trackLastmod && !!prev && !!prev.lastmod && !!it.lastmod && prev.lastmod !== it.lastmod;
      const isNew = !prev || changed;
      seen.urls[it.url] = {
        first_seen: prev?.first_seen ?? opts.today,
        source: prev?.source ?? source.id,
        ...((it.lastmod ?? prev?.lastmod) ? { lastmod: it.lastmod ?? prev?.lastmod } : {}),
      };
      if (!isNew) continue;
      stats.new++;

      const day = it.date ? toIso(it.date)?.slice(0, 10) : undefined;
      const recent = day !== undefined && day >= windowStart;
      // First run: only recent dated items. Later runs: undated items count as new; dated ones must not be stale.
      const toProcess = firstRun ? recent : day === undefined || recent;
      if (!toProcess) {
        stats.seededOnly++;
        continue;
      }
      candidates.push({
        url: it.url,
        sourceId: source.id,
        tier: source.tier,
        kind: source.kind,
        ...(it.title ? { title: it.title } : {}),
        ...(it.date ? { date: toIso(it.date) ?? it.date } : {}),
        ...(it.summary ? { summary: it.summary } : {}),
      });
    }

    candidates.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    const cap = source.max_items_per_run ?? DEFAULT_MAX_ITEMS;
    const selected = candidates.slice(0, cap);
    stats.overCap = candidates.length - selected.length;
    stats.selected = selected.length;
    if (firstRun) seen.initialized[source.id] = opts.today;
    return { items: selected, stats };
  } catch (e) {
    stats.errors.push(`internal: ${(e as Error)?.message ?? String(e)}`);
    return { items: [], stats };
  }
}

/** Fetch a page (robots and rate limit apply) and strip it to text. */
export async function fetchPage(
  fetcher: Fetcher,
  url: string,
  now: () => Date = () => new Date(),
): Promise<PageContext | { error: string; status: number }> {
  const r = await fetcher.get(url);
  if (!r.ok) return { error: r.error ?? `http_${r.status}`, status: r.status };
  const ct = r.contentType.toLowerCase();
  if (ct && !/html|xml|text\/plain/.test(ct)) return { error: `unsupported_content_type: ${ct.split(';')[0]}`, status: r.status };
  const { title, text } = htmlToText(r.body);
  if (!text.trim()) return { error: 'empty_page', status: r.status };
  return { url, finalUrl: r.finalUrl, title, text, html: r.body, fetchedAt: now().toISOString() };
}

/* ---------------------------------------------------------------------------------------------
 * Tier-2 resolution (SDD §8.3 step 3)
 * ------------------------------------------------------------------------------------------- */

const SOCIAL_OR_SHORTENER =
  /(^|\.)(facebook\.com|fb\.me|instagram\.com|twitter\.com|x\.com|t\.co|tiktok\.com|youtube\.com|youtu\.be|linkedin\.com|pinterest\.com|t\.me|telegram\.me|wa\.me|whatsapp\.com|bit\.ly|tinyurl\.com|linktr\.ee|ow\.ly|buff\.ly|goo\.gl|rebrand\.ly|shorturl\.at|lnkd\.in)$/;
const SHOP_OR_AFFILIATE =
  /\/(shop|store|cart|checkout|product|products|buy|tickets?\/checkout)(\/|$)|[?&](ref|aff|affiliate|affid|tag|irclickid|clickid)=|amzn\.|shopee\.|lazada\.|klook\.|pelago\.|trip\.com|sistic\.com\.sg|ticketmaster\./i;

const STOPWORDS = new Set(
  'the a an and or of in on at to for with from by is are be this that these those your our you we it its new best top guide things do what whats on happening singapore sg 2024 2025 2026 2027 2028 kids family families children child baby babies toddler toddlers parents weekend free more'.split(
    ' ',
  ),
);

export function titleKeywords(title: string): string[] {
  return [...new Set(normText(title).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/))].filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * Pick the official page an aggregator article points to: links to tier-1 or official domains,
 * excluding the aggregator itself, social media, shorteners (except go.gov.sg) and shop/affiliate
 * links; the best overlap between the item title and the link text/URL wins. Null if none.
 */
export function resolveOfficialUrl(page: PageContext, item: DiscoveredItem, sf: SourcesFile): string | null {
  const ownHosts = new Set([hostOf(page.url), hostOf(page.finalUrl), hostOf(item.url)]);
  const src = sf.sources.find((s) => s.id === item.sourceId);
  for (const d of src?.domains ?? []) ownHosts.add(d);

  // Prefer links in the article body; nav/header/footer/aside carry site-wide links.
  const articleMatch = /<article\b[\s\S]*?<\/article\s*>/i.exec(page.html);
  const body = stripElements(articleMatch ? articleMatch[0] : page.html, ['nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript', 'form']);
  const links = extractLinks(body, page.finalUrl);

  const keywords = titleKeywords(item.title ?? page.title ?? '');
  type Scored = { url: string; score: number; depth: number };
  const candidates = new Map<string, Scored>();
  for (const l of links) {
    const host = hostOf(l.url);
    if (!host || [...ownHosts].some((h) => host === h || host.endsWith('.' + h))) continue;
    if (host !== 'go.gov.sg' && SOCIAL_OR_SHORTENER.test(host)) continue;
    if (SHOP_OR_AFFILIATE.test(l.url)) continue;
    if (!isOfficialUrl(sf, l.url)) continue;
    let path = '';
    try {
      path = decodeURIComponent(new URL(l.url).pathname);
    } catch {
      path = l.url;
    }
    const hay = new Set(titleKeywords(`${l.text} ${path}`));
    // Run-together hosts ("indianheritage.gov.sg") still count as overlap.
    const compact = `${host}${path} ${l.text}`.toLowerCase().replace(/[^a-z0-9]/g, '');
    const score = keywords.filter((k) => hay.has(k) || (k.length >= 4 && compact.includes(k))).length;
    const depth = path.split('/').filter(Boolean).length;
    const prev = candidates.get(l.url);
    if (!prev || score > prev.score) candidates.set(l.url, { url: l.url, score, depth });
  }
  if (!candidates.size) return null;
  const ranked = [...candidates.values()].sort((a, b) => b.score - a.score || b.depth - a.depth);
  const best = ranked[0];
  // With no title overlap, only trust the link if it is the article's single official link.
  if (best.score === 0 && candidates.size > 1) return null;
  return best.url;
}
