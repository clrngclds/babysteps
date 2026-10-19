/**
 * Parsers for what discovery reads: RSS/Atom feeds, sitemaps, HTML listing pages and article text.
 * Regex-based HTML handling is deliberate: we only need links, visible text and a title, and
 * pulling in a DOM library for that is not worth the dependency.
 */
import { XMLParser } from 'fast-xml-parser';
import type { FeedItem, PageLink, PageText, ParsedSitemap, SitemapEntry } from '../types';

/* ---------------------------------------------------------------------------------------------
 * Entities and small helpers
 * ------------------------------------------------------------------------------------------- */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  hellip: '…', middot: '·', bull: '•', laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷', plusmn: '±', minus: '−',
  frac12: '½', frac14: '¼', frac34: '¾', euro: '€', pound: '£', cent: '¢', yen: '¥', sect: '§',
  para: '¶', dagger: '†', shy: '', zwj: '', zwnj: '', lrm: '', rlm: '',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', aacute: 'á', agrave: 'à', acirc: 'â', auml: 'ä',
  atilde: 'ã', aring: 'å', iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï', oacute: 'ó', ograve: 'ò',
  ocirc: 'ô', ouml: 'ö', otilde: 'õ', oslash: 'ø', uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü',
  ntilde: 'ñ', ccedil: 'ç', szlig: 'ß', aelig: 'æ', Eacute: 'É', Aacute: 'Á', Oacute: 'Ó', Uacute: 'Ú',
  Ntilde: 'Ñ', Ccedil: 'Ç', Ouml: 'Ö', Uuml: 'Ü', Auml: 'Ä', iexcl: '¡', iquest: '¿', ordm: 'º', ordf: 'ª',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      if (code === 0xa0) return ' ';
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const v = NAMED_ENTITIES[ent] ?? NAMED_ENTITIES[ent.toLowerCase()];
    return v ?? m;
  });
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Any date string -> ISO 8601, or undefined if unparseable. */
export function toIso(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.trim();
  if (!t) return undefined;
  // Bare dates are treated as UTC midnight so the calendar day is preserved.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(t) ? new Date(t + 'T00:00:00Z') : new Date(t);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Text of an XML node as produced by fast-xml-parser (string, number, or {#text}). */
function nodeText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return nodeText(v[0]);
  if (typeof v === 'object') {
    const t = (v as Record<string, unknown>)['#text'];
    return t == null ? '' : String(t);
  }
  return '';
}

/** Plain text from a field that may hold escaped HTML (RSS descriptions often do). */
function richText(v: unknown, maxLen = 500): string | undefined {
  const raw = nodeText(v);
  if (!raw) return undefined;
  let s = decodeEntities(raw);
  if (/<[a-z!/]/i.test(s)) s = htmlToText(s).text;
  s = collapse(s);
  if (!s) return undefined;
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}

const asArray = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

function xmlParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    processEntities: false, // we decode ourselves (numeric + HTML named entities)
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
  });
}

/* ---------------------------------------------------------------------------------------------
 * Feeds
 * ------------------------------------------------------------------------------------------- */

/** RSS 2.0, RSS 1.0 (RDF) and Atom. Returns [] for anything that is not a feed. */
export function parseFeed(xml: string): FeedItem[] {
  const items = parseFeedDoc(xml);
  if (items.length || !/<(item|entry)[\s>]/i.test(xml)) return items;
  // A body cut off at the size cap (or otherwise malformed at the end): keep the complete entries.
  const cut = Math.max(xml.lastIndexOf('</item>'), xml.lastIndexOf('</entry>'));
  if (cut < 0) return [];
  const isAtom = xml.lastIndexOf('</entry>') > xml.lastIndexOf('</item>');
  return parseFeedDoc(xml.slice(0, cut) + (isAtom ? '</entry></feed>' : '</item></channel></rss>'));
}

function parseFeedDoc(xml: string): FeedItem[] {
  let doc: Record<string, any>;
  try {
    doc = xmlParser().parse(xml);
  } catch {
    return [];
  }
  if (!doc || typeof doc !== 'object') return [];
  if (doc.feed) return parseAtom(doc.feed);
  const channelItems = doc.rss?.channel ? asArray(asArray(doc.rss.channel)[0]?.item) : [];
  const rdfItems = doc.RDF ? asArray(doc.RDF.item) : [];
  const items = channelItems.length ? channelItems : rdfItems;
  const out: FeedItem[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const url = rssLink(it);
    if (!url) continue;
    out.push(
      clean({
        url,
        title: richText(it.title, 300),
        published: toIso(nodeText(it.pubDate) || nodeText(it.date) || nodeText(it.published) || nodeText(it.updated)),
        summary: withTags(richText(it.description) ?? richText(it.encoded), [...asArray(it.category), ...asArray(it.audience)]),
      }),
    );
  }
  return out;
}

/**
 * Categories and LibCal audiences ("Toddlers (1-3 yo)") are appended to the summary so source
 * keyword filters can match them.
 */
function withTags(summary: string | undefined, tags: unknown[]): string | undefined {
  const t = [...new Set(tags.map((x) => collapse(decodeEntities(nodeText(x)))).filter(Boolean))];
  if (!t.length) return summary;
  return [summary, `[Tags: ${t.join('; ')}]`].filter(Boolean).join(' ');
}

function rssLink(it: Record<string, any>): string | undefined {
  // <link> may appear next to <atom:link> (both become "link" once namespaces are stripped).
  for (const l of asArray(it.link)) {
    if (typeof l === 'string' && /^https?:\/\//i.test(l.trim())) return decodeEntities(l.trim());
    if (l && typeof l === 'object') {
      const href = l['@_href'] ?? l['#text'];
      if (typeof href === 'string' && /^https?:\/\//i.test(href.trim())) return decodeEntities(href.trim());
    }
  }
  const guid = it.guid;
  const g = nodeText(guid).trim();
  const permalink = typeof guid !== 'object' || guid?.['@_isPermaLink'] !== 'false';
  if (permalink && /^https?:\/\//i.test(g)) return decodeEntities(g);
  return undefined;
}

function parseAtom(feed: Record<string, any>): FeedItem[] {
  const out: FeedItem[] = [];
  for (const e of asArray(feed.entry)) {
    if (!e || typeof e !== 'object') continue;
    const links = asArray(e.link).filter((l: any) => l && typeof l === 'object' && l['@_href']);
    const alt =
      links.find((l: any) => (l['@_rel'] ?? 'alternate') === 'alternate' && (!l['@_type'] || /html/i.test(l['@_type']))) ??
      links.find((l: any) => (l['@_rel'] ?? 'alternate') === 'alternate');
    if (!alt) continue;
    out.push(
      clean({
        url: decodeEntities(String(alt['@_href']).trim()),
        title: richText(e.title, 300),
        published: toIso(nodeText(e.published) || nodeText(e.updated) || nodeText(e.issued)),
        summary: richText(e.summary) ?? richText(e.content),
      }),
    );
  }
  return out;
}

function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

/* ---------------------------------------------------------------------------------------------
 * Sitemaps
 * ------------------------------------------------------------------------------------------- */

/**
 * <urlset> and <sitemapindex>. Uses a tolerant regex scan rather than a strict XML parse:
 * real sitemaps come with odd namespaces, BOMs, stray whitespace and the occasional bad entity.
 */
export function parseSitemap(xml: string): ParsedSitemap {
  const isIndex = /<(?:[\w-]+:)?sitemapindex[\s>]/i.test(xml);
  const tag = isIndex ? 'sitemap' : 'url';
  const entries: SitemapEntry[] = [];
  const seen = new Set<string>();
  const blockRe = new RegExp(`<(?:[\\w-]+:)?${tag}[\\s>]([\\s\\S]*?)</(?:[\\w-]+:)?${tag}\\s*>`, 'gi');
  for (const m of xml.matchAll(blockRe)) {
    const block = m[1];
    const loc = tagValue(block, 'loc');
    if (!loc || !/^https?:\/\//i.test(loc) || seen.has(loc)) continue;
    seen.add(loc);
    const lastmod = toIso(tagValue(block, 'lastmod'));
    entries.push(lastmod ? { loc, lastmod } : { loc });
  }
  return { type: isIndex ? 'index' : 'urlset', entries };
}

function tagValue(block: string, name: string): string | undefined {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}\\s*>`, 'i').exec(block);
  if (!m) return undefined;
  const v = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
  return decodeEntities(v.trim()) || undefined;
}

/* ---------------------------------------------------------------------------------------------
 * HTML
 * ------------------------------------------------------------------------------------------- */

const SKIP_PROTOCOL = /^(mailto|javascript|tel|sms|data|file|ftp|whatsapp|intent):/i;

/** Absolute http(s) links with their anchor text; fragments dropped, deduplicated (first non-empty text kept). */
export function extractLinks(html: string, baseUrl: string): PageLink[] {
  const baseTag = /<base\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(html);
  let base: URL;
  try {
    base = new URL(baseTag ? decodeEntities(baseTag[1]) : baseUrl, baseUrl);
  } catch {
    return [];
  }
  const page = stripHash(base.href);
  const byUrl = new Map<string, PageLink>();
  const re = /<a\b([^>]*?)>([\s\S]*?)<\/a\s*>/gi;
  for (const m of html.matchAll(re)) {
    const attrs = m[1];
    const hm = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
    if (!hm) continue;
    const href = decodeEntities((hm[1] ?? hm[2] ?? hm[3] ?? '').trim());
    // "{{link}}" = unrendered client-side template, not a real link.
    if (!href || href.startsWith('#') || SKIP_PROTOCOL.test(href) || href.includes('{{')) continue;
    let abs: URL;
    try {
      abs = new URL(href, base);
    } catch {
      continue;
    }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;
    const url = stripHash(abs.href);
    if (url === page && href.includes('#')) continue; // in-page anchor written as full URL
    const text = collapse(decodeEntities(m[2].replace(/<[^>]*>/g, ' ')));
    const titleAttr = /\b(?:title|aria-label)\s*=\s*"([^"]*)"/i.exec(attrs);
    const label = text || (titleAttr ? collapse(decodeEntities(titleAttr[1])) : '');
    const prev = byUrl.get(url);
    if (!prev) byUrl.set(url, { url, text: label });
    else if (!prev.text && label) prev.text = label;
  }
  return [...byUrl.values()];
}

function stripHash(u: string): string {
  const i = u.indexOf('#');
  return i < 0 ? u : u.slice(0, i);
}

const DROP_ELEMENTS = ['script', 'style', 'noscript', 'svg', 'nav', 'header', 'footer', 'form', 'template', 'iframe', 'head', 'button', 'select'];
const BLOCK_TAGS =
  /<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|section|article|aside|main|blockquote|dd|dt|dl|figcaption|figure|hr|pre|time|address|summary|details)\b[^>]*>/gi;

/** Remove whole elements (with content). Repeats so simple nesting of the same tag is handled. */
export function stripElements(html: string, names: string[]): string {
  let out = html;
  for (const name of names) {
    const re = new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}\\s*>`, 'gi');
    for (let i = 0; i < 5; i++) {
      const next = out.replace(re, ' ');
      if (next === out) break;
      out = next;
    }
    out = out.replace(new RegExp(`<${name}\\b[^>]*\\/>`, 'gi'), ' ');
  }
  return out;
}

/**
 * Visible text, one line per block element, spaces collapsed within lines.
 * Title preference: og:title, then <title>, then the first <h1>.
 */
export function htmlToText(html: string): PageText {
  const title = pageTitle(html);
  let s = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ');
  s = stripElements(s, DROP_ELEMENTS);
  // Inline tags vanish (as in a browser) so "via <a>SISTIC</a>." stays "via SISTIC." for quote matching.
  s = s.replace(BLOCK_TAGS, '\n').replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  const text = s
    .split('\n')
    .map((l) => l.replace(/[\s\u200b]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return { title, text };
}

function metaContent(html: string, key: string): string | undefined {
  const re = /<meta\b[^>]*>/gi;
  for (const m of html.matchAll(re)) {
    const tag = m[0];
    const k = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!k || k[1].toLowerCase() !== key) continue;
    const c = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if (c) return collapse(decodeEntities(c[1] ?? c[2] ?? ''));
  }
  return undefined;
}

function pageTitle(html: string): string {
  const og = metaContent(html, 'og:title');
  if (og) return og;
  const t = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (t) {
    const v = collapse(decodeEntities(t[1].replace(/<[^>]*>/g, ' ')));
    if (v) return v;
  }
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html);
  return h1 ? collapse(decodeEntities(h1[1].replace(/<[^>]*>/g, ' '))) : '';
}

/* ---------------------------------------------------------------------------------------------
 * Dates on event pages
 * ------------------------------------------------------------------------------------------- */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
];
// Capitalised or upper case only, so "may" in running text is not read as a month.
const MONTH_RE = (() => {
  const alts: string[] = [];
  for (const full of MONTH_NAMES) {
    const short = full.slice(0, 3);
    const forms = [full, short, full.toUpperCase(), short.toUpperCase()];
    if (full === 'September') forms.push('Sept', 'SEPT');
    alts.push(...forms);
  }
  // Longest first so "September" wins over "Sep".
  return '(' + [...new Set(alts)].sort((a, b) => b.length - a.length).join('|') + ')\\.?(?![A-Za-z])';
})();
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?';
const YEAR = '(20\\d{2})';
const DASH = '\\s*(?:-|–|—|to|until|till)\\s*';
const WEEKDAY = '(?:(?:Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)(?:day|sday|nesday|rsday|urday)?\\.?,?\\s+)?';

const pad = (n: number) => String(n).padStart(2, '0');

function validYmd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Next occurrence of month/day on or after refDate (YYYY-MM-DD). */
function inferYear(m: number, d: number, refDate: string): string | null {
  const refY = Number(refDate.slice(0, 4));
  const same = validYmd(refY, m, d);
  if (same && same >= refDate) return same;
  return validYmd(refY + 1, m, d) ?? same;
}

function monthNum(name: string): number {
  const n = name.toLowerCase().replace('.', '');
  return MONTHS[n.startsWith('sept') ? 'sept' : n.slice(0, 3)] ?? 0;
}

/**
 * Explicit dates in page text -> sorted unique YYYY-MM-DD. Day-first (Singapore) for numeric
 * dates unless that is impossible. Ranges contribute their start and end dates.
 */
export function extractDates(text: string, refDate: string): string[] {
  const found = new Set<string>();
  let s = text;
  const add = (v: string | null) => {
    if (v) found.add(v);
  };
  const ymd = (y: string | undefined, m: number, d: number) => (y ? validYmd(Number(y), m, d) : inferYear(m, d, refDate));
  /** Run a pattern, then blank out its matches so later patterns don't re-read them. */
  const scan = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    s = s.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      fn(m);
      return ' '.repeat(String(args[0]).length);
    });
  };

  // ISO 2026-11-14
  scan(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g, (m) => add(validYmd(+m[1], +m[2], +m[3])));
  // Numeric 14/11/2026 or 14.11.2026 (day first unless impossible)
  scan(/\b(\d{1,2})[/.](\d{1,2})[/.](20\d{2})\b/g, (m) => {
    const a = +m[1], b = +m[2], y = +m[3];
    add(validYmd(y, b, a) ?? validYmd(y, a, b));
  });
  // 17 October to 8 November 2026 (the start takes the end's year, or the year before if it wraps)
  scan(new RegExp(`\\b${WEEKDAY}${DAY}\\s+${MONTH_RE}${DASH}${WEEKDAY}${DAY}\\s+${MONTH_RE},?\\s+${YEAR}(?!\\d)`, 'g'), (m) => {
    const m1 = monthNum(m[2]), m2 = monthNum(m[4]), y = +m[5];
    add(validYmd(m1 > m2 ? y - 1 : y, m1, +m[1]));
    add(validYmd(y, m2, +m[3]));
  });
  // October 17 – November 8, 2026
  scan(new RegExp(`\\b${MONTH_RE}\\s+${DAY}${DASH}${MONTH_RE}\\s+${DAY},?\\s+${YEAR}(?!\\d)`, 'g'), (m) => {
    const m1 = monthNum(m[1]), m2 = monthNum(m[3]), y = +m[5];
    add(validYmd(m1 > m2 ? y - 1 : y, m1, +m[2]));
    add(validYmd(y, m2, +m[4]));
  });
  // 14–16 Nov 2026 / Sat 14 - Sun 16 November
  scan(new RegExp(`\\b${WEEKDAY}${DAY}${DASH}${WEEKDAY}${DAY}\\s+${MONTH_RE}(?:,?\\s+${YEAR})?(?!\\d)`, 'g'), (m) => {
    const mo = monthNum(m[3]);
    add(ymd(m[4], mo, +m[1]));
    add(ymd(m[4], mo, +m[2]));
  });
  // Nov 14–16, 2026
  scan(new RegExp(`\\b${MONTH_RE}\\s+${DAY}${DASH}${DAY}(?!\\d)(?:,?\\s+${YEAR})?(?![\\d:])`, 'g'), (m) => {
    const mo = monthNum(m[1]);
    add(ymd(m[4], mo, +m[2]));
    add(ymd(m[4], mo, +m[3]));
  });
  // Sat, 14 November [2026] / 12 Nov 2026
  scan(new RegExp(`\\b${WEEKDAY}${DAY}\\s+(?:of\\s+)?${MONTH_RE}(?:,?\\s+${YEAR})?(?!\\d)`, 'g'), (m) => {
    add(ymd(m[3], monthNum(m[2]), +m[1]));
  });
  // November 14[, 2026]
  scan(new RegExp(`\\b${MONTH_RE}\\s+${DAY}(?![\\d:])(?:,?\\s+${YEAR})?(?!\\d)`, 'g'), (m) => {
    add(ymd(m[3], monthNum(m[1]), +m[2]));
  });
  return [...found].sort();
}
