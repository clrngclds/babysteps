import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_UA, createFetcher, isBotChallenge } from '../../pipeline/src/fetch/http';
import { extractDates, extractLinks, htmlToText, parseFeed, parseSitemap } from '../../pipeline/src/fetch/parsers';
import { isAllowed, parseRobots } from '../../pipeline/src/fetch/robots';
import { hostOf, isOfficialUrl, loadSourcesFile, parseSources, sourceForUrl, tier1Domains } from '../../pipeline/src/fetch/sources';
import { dateFromUrl, discoverSource, emptySeen, fetchPage, normUrl, resolveOfficialUrl } from '../../pipeline/src/fetch/discover';
import type { DiscoveredItem, FetchResult, Fetcher, PageContext, SourceConfig } from '../../pipeline/src/types';

const fx = (name: string) => readFileSync(resolve(__dirname, 'fixtures/fetch', name), 'utf8');

/* ---------------------------------------------------------------------------------------------
 * Test doubles
 * ------------------------------------------------------------------------------------------- */

interface FakeResp {
  status?: number;
  body?: string;
  contentType?: string;
  /** Final URL after redirects. */
  url?: string;
}

/** fetch() stand-in: routes by exact URL; unknown URLs are 404. Records each call. */
function fakeFetch(routes: Record<string, FakeResp | FakeResp[] | (() => FakeResp | Promise<FakeResp>)>) {
  const calls: { url: string; method: string; at: number; headers: Record<string, string> }[] = [];
  const counters: Record<string, number> = {};
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', at: Date.now(), headers: (init?.headers ?? {}) as Record<string, string> });
    const route = routes[url];
    let r: FakeResp;
    if (typeof route === 'function') r = await route();
    else if (Array.isArray(route)) {
      const n = counters[url] ?? 0;
      counters[url] = n + 1;
      r = route[Math.min(n, route.length - 1)];
    } else r = route ?? { status: 404, body: 'not found' };
    if (r.status === -1) throw new TypeError('fetch failed');
    const res = new Response(r.body ?? '', {
      status: r.status ?? 200,
      headers: { 'content-type': r.contentType ?? 'text/html; charset=utf-8' },
    });
    Object.defineProperty(res, 'url', { value: r.url ?? url });
    return res;
  }) as typeof fetch;
  return { impl, calls };
}

/** Fetcher stub for discovery tests (no robots/rate limit; those are tested on createFetcher). */
function stubFetcher(routes: Record<string, string | FakeResp>): Fetcher & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async get(url: string): Promise<FetchResult> {
      urls.push(url);
      const r = routes[url];
      if (r === undefined) return { url, finalUrl: url, status: 404, ok: false, contentType: 'text/html', body: '', error: 'http_404' };
      const resp: FakeResp = typeof r === 'string' ? { body: r } : r;
      const status = resp.status ?? 200;
      return {
        url,
        finalUrl: resp.url ?? url,
        status,
        ok: status >= 200 && status < 300,
        contentType: resp.contentType ?? 'text/xml',
        body: resp.body ?? '',
        ...(status >= 200 && status < 300 ? {} : { error: `http_${status}` }),
      };
    },
  };
}

const src = (over: Partial<SourceConfig>): SourceConfig => ({
  id: 'test-source',
  name: 'Test source',
  tier: 1,
  kind: 'activity',
  detection: 'feed',
  urls: ['https://example.com/feed/'],
  domains: ['example.com'],
  ...over,
});

const quickFetcher = (impl: typeof fetch) =>
  createFetcher({ fetchImpl: impl, hostDelayMs: 0, sleep: async () => undefined });

afterEach(() => {
  vi.useRealTimers();
});

/* ---------------------------------------------------------------------------------------------
 * Feeds
 * ------------------------------------------------------------------------------------------- */

describe('parseFeed', () => {
  it('reads Lovevery RSS 2.0 (CDATA titles, RFC 822 dates)', () => {
    const items = parseFeed(fx('lovevery_feed.xml'));
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      url: 'https://blog.lovevery.com/learning-cognitive-skills/how-toddler-art-helps-build-fine-motor-skills-for-handwriting/',
      title: 'How toddler art helps build fine motor skills for handwriting',
      published: '2026-09-29T04:06:42.000Z',
    });
    expect(items[2].title).toBe('Getting started with sensory play: Easy ideas for toddlers, preschoolers & up');
    expect(items[0].summary).toMatch(/^Long before your toddler picks up a pencil/);
    expect(items[0].summary).not.toMatch(/<|&#/);
  });

  it('reads Blogger Atom using the rel=alternate link', () => {
    const items = parseFeed(fx('kavanaugh_atom.xml'));
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      url: 'http://www.thekavanaughreport.com/2025/06/outdoor-montessori-work-for-summer.html',
      title: 'Outdoor Montessori Work for the Summer',
      published: '2025-06-09T12:57:00.002Z',
    });
    // Not the comments feed or the edit link.
    expect(items.every((i) => !/feeds|comment/.test(i.url))).toBe(true);
  });

  it('reads NLB LibCal RSS: event date and audience tags end up in the item', () => {
    const items = parseFeed(fx('libcal_rss.xml'));
    expect(items.map((i) => i.title)).toEqual([
      'Baby Lapsit',
      'Jiggle, Read & Rhyme',
      'Tai Chi For Healthy Longevity',
      'Storytime at Punggol Library',
      'Board Games B.F.F.',
    ]);
    expect(items[0].published).toBe('2026-10-31T00:00:00.000Z');
    expect(items[0].summary).toContain('Babies (<1 yo)');
    expect(items[1].summary).toContain('Toddlers (1-3 yo)');
    expect(items[0].summary).toContain('suitable for children aged 0–1');
  });

  it('handles minimal RSS, guid permalinks, and RSS 1.0', () => {
    const rss = `<rss version="2.0"><channel><item><title>A &amp; B &#8217;s</title><guid>https://x.sg/a</guid><pubDate>Mon, 12 Oct 2026 08:00:00 +0800</pubDate></item>
      <item><title>No link</title><guid isPermaLink="false">abc</guid></item></channel></rss>`;
    expect(parseFeed(rss)).toEqual([{ url: 'https://x.sg/a', title: 'A & B ’s', published: '2026-10-12T00:00:00.000Z' }]);
    const rdf = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <item rdf:about="https://y.sg/1"><title>One</title><link>https://y.sg/1</link><dc:date>2026-10-01</dc:date></item></rdf:RDF>`;
    expect(parseFeed(rdf)).toEqual([{ url: 'https://y.sg/1', title: 'One', published: '2026-10-01T00:00:00.000Z' }]);
  });

  it('keeps complete items from a feed cut off at the size cap', () => {
    const xml = fx('libcal_rss.xml');
    const cut = xml.slice(0, xml.indexOf('<title>Storytime at Punggol Library') + 40);
    const items = parseFeed(cut);
    expect(items.map((i) => i.title)).toEqual(['Baby Lapsit', 'Jiggle, Read & Rhyme', 'Tai Chi For Healthy Longevity']);
  });

  it('returns [] for non-feeds', () => {
    expect(parseFeed('<html><body>hi</body></html>')).toEqual([]);
    expect(parseFeed('')).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------------------------
 * Sitemaps
 * ------------------------------------------------------------------------------------------- */

describe('parseSitemap', () => {
  it('reads a sitemap index', () => {
    const sm = parseSitemap(fx('sitemap_index.xml'));
    expect(sm.type).toBe('index');
    expect(sm.entries.map((e) => e.loc)).toEqual([
      'https://montessorifromtheheart.com/sitemap-1.xml',
      'https://montessorifromtheheart.com/image-sitemap-index-1.xml',
      'https://montessorifromtheheart.com/video-sitemap-1.xml',
    ]);
    expect(sm.entries[0].lastmod).toBe('2026-10-14T04:30:11.000Z');
  });

  it('reads a urlset, trimming whitespace and ignoring image:loc', () => {
    const sm = parseSitemap(fx('sitemap_urlset.xml'));
    expect(sm.type).toBe('urlset');
    expect(sm.entries).toHaveLength(7);
    expect(sm.entries[2]).toEqual({
      loc: 'https://montessorifromtheheart.com/2026/10/12/diy-fall-color-matching-activity-for-toddlers-pumpkin-play/',
      lastmod: '2026-10-12T09:00:59.000Z',
    });
    expect(sm.entries.some((e) => e.loc.endsWith('.jpg'))).toBe(false);
    expect(sm.entries[6]).toEqual({ loc: 'https://montessorifromtheheart.com/category/toddler/' });
  });

  it('tolerates prefixed namespaces, CDATA and entities', () => {
    const xml = `<?xml version="1.0"?><ns:urlset xmlns:ns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <ns:url><ns:loc><![CDATA[https://a.sg/x?a=1&b=2]]></ns:loc><ns:lastmod>2026-10-01</ns:lastmod></ns:url>
      <ns:url><ns:loc>https://a.sg/y?a=1&amp;b=2</ns:loc></ns:url></ns:urlset>`;
    expect(parseSitemap(xml).entries).toEqual([
      { loc: 'https://a.sg/x?a=1&b=2', lastmod: '2026-10-01T00:00:00.000Z' },
      { loc: 'https://a.sg/y?a=1&b=2' },
    ]);
  });
});

/* ---------------------------------------------------------------------------------------------
 * HTML
 * ------------------------------------------------------------------------------------------- */

describe('extractLinks', () => {
  const base = 'https://www.changiairport.com/en/happenings/events-directory.html';

  it('resolves relative links, drops fragments/mailto/javascript, dedupes', () => {
    const links = extractLinks(fx('listing.html'), base);
    const urls = links.map((l) => l.url);
    expect(urls).toContain('https://www.changiairport.com/en/happenings/events-directory/changi-childrens-day.html');
    expect(urls).toContain('https://www.changiairport.com/en/happenings/events-directory/race-season-2026.html');
    expect(urls.filter((u) => u.endsWith('changi-after-dark.html'))).toHaveLength(1);
    expect(urls.some((u) => /mailto:|javascript:|#/.test(u))).toBe(false);
    expect(links.find((l) => l.url.endsWith('changi-childrens-day.html'))?.text).toBe('Celebrate Children’s Day at Changi Airport');
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('honours <base href> and skips unrendered templates', () => {
    const html = '<base href="https://cdn.sg/root/"><a href="a.html">A</a><a href="{{link}}">T</a><a href="tel:123">Call</a>';
    expect(extractLinks(html, 'https://site.sg/page')).toEqual([{ url: 'https://cdn.sg/root/a.html', text: 'A' }]);
  });
});

describe('htmlToText', () => {
  it('strips chrome, scripts and decodes entities; title from og:title', () => {
    const t = htmlToText(fx('aggregator_article.html'));
    expect(t.title).toBe('Indian Heritage Centre Deepavali Open House 2026: House of Memories');
    expect(t.text).toContain('When: 17 October to 8 November 2026');
    expect(t.text).toContain('Tickets for workshops via SISTIC.');
    expect(t.text).not.toMatch(/Subscribe|Instagram|@type|<|&nbsp;/);
  });

  it('does not end a tag at a > inside a quoted attribute (embedded JSON) and drops the doctype', () => {
    const t = htmlToText(`<!DOCTYPE html><div data-json='{"a":"<b>1 > 2</b>"}' class="x">Hello <b>world</b> 3 < 5</div>`);
    expect(t.text).toBe('Hello world 3 < 5');
  });

  it('falls back to <title> then <h1>; handles numeric entities and hidden elements', () => {
    expect(htmlToText('<html><head><title> Hi &amp; bye </title></head><body>x</body></html>').title).toBe('Hi & bye');
    const t = htmlToText(
      '<body><h1>Main &#x2019;s &#8211; title</h1><noscript>enable js</noscript><svg><text>logo</text></svg><form><label>Email</label></form><p>Play&nbsp;time</p><style>p{}</style></body>',
    );
    expect(t.title).toBe('Main ’s – title');
    expect(t.text).toBe('Main ’s – title\nPlay time');
  });
});

describe('extractDates', () => {
  const ref = '2026-10-19';
  it('finds the documented formats', () => {
    expect(extractDates('Date: 12 Nov 2026', ref)).toEqual(['2026-11-12']);
    expect(extractDates('Sat, 14 November, 10am', ref)).toEqual(['2026-11-14']);
    expect(extractDates('Runs 14–16 Nov 2026', ref)).toEqual(['2026-11-14', '2026-11-16']);
    expect(extractDates('ISO 2026-11-14 here', ref)).toEqual(['2026-11-14']);
    expect(extractDates('On 14/11/2026 only', ref)).toEqual(['2026-11-14']);
    expect(extractDates('November 20-22, 2026', ref)).toEqual(['2026-11-20', '2026-11-22']);
    expect(extractDates('When: 17 October to 8 November 2026', ref)).toEqual(['2026-10-17', '2026-11-08']);
    expect(extractDates('Saturday, October 31, 2026', ref)).toEqual(['2026-10-31']);
  });

  it('infers the next occurrence for dates without a year', () => {
    expect(extractDates('Every 3 Jan', ref)).toEqual(['2027-01-03']);
    expect(extractDates('19 Oct', ref)).toEqual(['2026-10-19']);
    expect(extractDates('Dec 5', ref)).toEqual(['2026-12-05']);
  });

  it('ignores lookalikes', () => {
    expect(extractDates('You may 2 go. Meet at 14 Marina Bay. 31 Feb 2026. Nov 2026.', ref)).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------------------------
 * robots.txt
 * ------------------------------------------------------------------------------------------- */

describe('robots', () => {
  const rules = parseRobots(fx('robots.txt'));

  it('uses the * group for a browser UA and applies longest match', () => {
    expect(isAllowed(rules, '/', BROWSER_UA)).toBe(true);
    expect(isAllowed(rules, '/search.html', BROWSER_UA)).toBe(false);
    expect(isAllowed(rules, '/api/data', BROWSER_UA)).toBe(false);
    expect(isAllowed(rules, '/api/ui-extensions/x.js', BROWSER_UA)).toBe(true); // longer Allow wins
    expect(isAllowed(rules, '/content/nationalgallerysg/en.html', BROWSER_UA)).toBe(false);
  });

  it('supports * and $ wildcards', () => {
    expect(isAllowed(rules, '/en/things/?i_cid=abc', BROWSER_UA)).toBe(false);
    expect(isAllowed(rules, '/en/things/?x=1', BROWSER_UA)).toBe(true);
    expect(isAllowed(rules, '/account', BROWSER_UA)).toBe(false);
    expect(isAllowed(rules, '/account/settings', BROWSER_UA)).toBe(true); // $ anchors the end
    expect(isAllowed(rules, '/files/guide.pdf', BROWSER_UA)).toBe(false);
    expect(isAllowed(rules, '/files/guide.pdf?v=2', BROWSER_UA)).toBe(true);
  });

  it('applies named groups (shared by consecutive User-agent lines) to matching agents only', () => {
    expect(isAllowed(rules, '/', 'GPTBot/1.1')).toBe(false);
    expect(isAllowed(rules, '/', 'CCBot/2.0')).toBe(false);
    expect(isAllowed(rules, '/', 'Nutch')).toBe(false);
    expect(rules.sitemaps).toEqual(['https://www.example.sg/sitemap.xml']);
  });

  it('treats empty Disallow as allow-all and ties as allow', () => {
    const r = parseRobots('User-agent: *\nDisallow:\n');
    expect(isAllowed(r, '/anything', BROWSER_UA)).toBe(true);
    const tie = parseRobots('User-agent: *\nDisallow: /page\nAllow: /page\n');
    expect(isAllowed(tie, '/page', BROWSER_UA)).toBe(true);
  });
});

/* ---------------------------------------------------------------------------------------------
 * HTTP fetcher
 * ------------------------------------------------------------------------------------------- */

describe('createFetcher', () => {
  it('sends a browser UA and en-SG headers, follows redirects into finalUrl', async () => {
    const { impl, calls } = fakeFetch({
      'https://a.sg/robots.txt': { status: 404 },
      'https://a.sg/page': { body: '<p>hi</p>', url: 'https://a.sg/page/' },
    });
    const r = await quickFetcher(impl).get('https://a.sg/page');
    expect(r).toMatchObject({ ok: true, status: 200, finalUrl: 'https://a.sg/page/', body: '<p>hi</p>' });
    const h = calls[1].headers;
    expect(h['User-Agent']).toBe(BROWSER_UA);
    expect(BROWSER_UA).toMatch(/Chrome\/\d{3}\.0\.0\.0 Safari\/537\.36$/);
    expect(h['Accept-Language']).toMatch(/^en-SG,en/);
    expect(h.Accept).toMatch(/text\/html/);
  });

  it('never fetches a robots-disallowed URL and caches robots per host', async () => {
    const { impl, calls } = fakeFetch({
      'https://b.sg/robots.txt': { body: fx('robots.txt'), contentType: 'text/plain' },
      'https://b.sg/ok': { body: 'fine' },
    });
    const f = quickFetcher(impl);
    const denied = await f.get('https://b.sg/search.html');
    expect(denied).toMatchObject({ status: 0, ok: false, error: 'robots_disallowed' });
    expect((await f.get('https://b.sg/ok')).ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(['https://b.sg/robots.txt', 'https://b.sg/ok']);
    expect(f.robotsInfo('https://b.sg/x')?.status).toBe(200);
  });

  it('allows everything when robots.txt is missing or broken, remembering the error', async () => {
    const { impl } = fakeFetch({
      'https://c.sg/robots.txt': { status: 503 },
      'https://c.sg/p': { body: 'ok' },
    });
    const f = quickFetcher(impl);
    expect((await f.get('https://c.sg/p')).ok).toBe(true);
    expect(f.robotsInfo('https://c.sg/')).toMatchObject({ rules: null, status: 503, error: 'http_503' });
  });

  it('skipRobots bypasses robots.txt entirely', async () => {
    const { impl, calls } = fakeFetch({ 'https://d.sg/health': { body: 'ok' } });
    await quickFetcher(impl).get('https://d.sg/health', { skipRobots: true });
    expect(calls.map((c) => c.url)).toEqual(['https://d.sg/health']);
  });

  it('spaces requests to one host by >= 2 s (robots included) while other hosts run concurrently', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { impl, calls } = fakeFetch({
      'https://one.sg/robots.txt': { status: 404 },
      'https://two.sg/robots.txt': { status: 404 },
      'https://one.sg/a': { body: 'a' },
      'https://one.sg/b': { body: 'b' },
      'https://two.sg/a': { body: 'a' },
    });
    const f = createFetcher({ fetchImpl: impl }); // real defaults: 2000 ms, setTimeout sleep, Date.now
    const all = Promise.all([f.get('https://one.sg/a'), f.get('https://one.sg/b'), f.get('https://two.sg/a')]);
    await vi.runAllTimersAsync();
    const results = await all;
    expect(results.every((r) => r.ok)).toBe(true);
    const at = (u: string) => calls.find((c) => c.url === u)!.at;
    const oneTimes = calls.filter((c) => c.url.startsWith('https://one.sg/')).map((c) => c.at);
    for (let i = 1; i < oneTimes.length; i++) expect(oneTimes[i] - oneTimes[i - 1]).toBeGreaterThanOrEqual(2000);
    expect(oneTimes).toEqual([0, 2000, 4000]);
    // two.sg is not held up by one.sg's queue.
    expect(at('https://two.sg/robots.txt')).toBe(0);
    expect(at('https://two.sg/a')).toBe(2000);
  });

  it('works with an injected clock and sleep', async () => {
    let t = 1_000_000;
    const slept: number[] = [];
    const { impl } = fakeFetch({ 'https://e.sg/robots.txt': { status: 404 }, 'https://e.sg/x': { body: 'x' } });
    const f = createFetcher({
      fetchImpl: impl,
      now: () => t,
      sleep: async (ms) => {
        slept.push(ms);
        t += ms;
      },
    });
    await f.get('https://e.sg/x');
    await f.get('https://e.sg/x');
    expect(slept).toEqual([2000, 2000]);
  });

  it('retries once after a 5xx / 429 / network error, waiting the host delay', async () => {
    const slept: number[] = [];
    let t = 0;
    const { impl, calls } = fakeFetch({
      'https://f.sg/robots.txt': { status: 404 },
      'https://f.sg/flaky': [{ status: 503 }, { body: 'second time lucky' }],
      'https://f.sg/down': [{ status: -1 }, { status: -1 }, { body: 'never reached' }],
      'https://f.sg/busy': [{ status: 429 }, { status: 429 }],
    });
    const f = createFetcher({ fetchImpl: impl, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
    const ok = await f.get('https://f.sg/flaky');
    expect(ok).toMatchObject({ ok: true, body: 'second time lucky' });
    const down = await f.get('https://f.sg/down');
    expect(down).toMatchObject({ ok: false, status: 0 });
    expect(down.error).toMatch(/^network: fetch failed/);
    const busy = await f.get('https://f.sg/busy');
    expect(busy).toMatchObject({ ok: false, status: 429, error: 'http_429' });
    expect(calls.filter((c) => c.url === 'https://f.sg/down')).toHaveLength(2);
    expect(slept.every((ms) => ms === 2000)).toBe(true);
  });

  it('does not retry 404', async () => {
    const { impl, calls } = fakeFetch({ 'https://g.sg/robots.txt': { status: 404 }, 'https://g.sg/missing': { status: 404 } });
    const r = await quickFetcher(impl).get('https://g.sg/missing');
    expect(r).toMatchObject({ ok: false, status: 404, error: 'http_404' });
    expect(calls.filter((c) => c.url === 'https://g.sg/missing')).toHaveLength(1);
  });

  it('times out slow responses without throwing', async () => {
    const slowImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/robots.txt')) return new Response('', { status: 404 });
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as typeof fetch;
    const f = createFetcher({ fetchImpl: slowImpl, hostDelayMs: 0, sleep: async () => undefined, timeoutMs: 20 });
    const r = await f.get('https://slow.sg/x');
    expect(r).toMatchObject({ ok: false, status: 0, error: 'timeout' });
  });

  it('caps the body size', async () => {
    const { impl } = fakeFetch({ 'https://h.sg/robots.txt': { status: 404 }, 'https://h.sg/big': { body: 'x'.repeat(10_000) } });
    const f = createFetcher({ fetchImpl: impl, hostDelayMs: 0, sleep: async () => undefined, maxBytes: 1000 });
    expect((await f.get('https://h.sg/big')).body).toHaveLength(1000);
    expect((await f.get('https://h.sg/big', { maxBytes: 5000 })).body).toHaveLength(5000);
  });

  it('HEAD falls back to GET on 405/403', async () => {
    const { impl, calls } = fakeFetch({
      'https://i.sg/robots.txt': { status: 404 },
      'https://i.sg/page': () => ({ status: calls[calls.length - 1].method === 'HEAD' ? 405 : 200, body: 'page' }),
    });
    const r = await quickFetcher(impl).get('https://i.sg/page', { method: 'HEAD' });
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(calls.filter((c) => c.url === 'https://i.sg/page').map((c) => c.method)).toEqual(['HEAD', 'GET']);
  });

  it('reports bot challenges and invalid URLs instead of throwing', async () => {
    const waf = '<html><head><script>window.awsWafCookieDomainList = []; window.gokuProps = {}</script></head></html>';
    expect(isBotChallenge(202, waf)).toBe(true);
    expect(isBotChallenge(200, '<html><title>Events</title></html>')).toBe(false);
    const { impl } = fakeFetch({ 'https://j.sg/robots.txt': { status: 202, body: waf }, 'https://j.sg/x': { status: 202, body: waf } });
    const f = quickFetcher(impl);
    expect(await f.get('https://j.sg/x')).toMatchObject({ ok: false, status: 202, error: 'bot_challenge' });
    expect(f.robotsInfo('https://j.sg/')).toMatchObject({ rules: null, error: 'bot_challenge' });
    expect(await f.get('not a url')).toMatchObject({ ok: false, status: 0 });
    expect(await f.get('ftp://k.sg/file')).toMatchObject({ ok: false, status: 0 });
  });
});

/* ---------------------------------------------------------------------------------------------
 * sources.yaml
 * ------------------------------------------------------------------------------------------- */

describe('sources', () => {
  const sf = loadSourcesFile();

  it('the real sources.yaml parses and validates', () => {
    expect(sf.version).toBe(1);
    expect(sf.sources.length).toBeGreaterThanOrEqual(25);
    const ids = sf.sources.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['lovevery-blog', 'kavanaugh-report', 'montessori-notebook', 'nlb-libcal', 'onepa', 'esplanade', 'honeykids-asia', 'sassy-mama-sg', 'little-day-out', 'theasianparent-sg']) {
      expect(ids).toContain(id);
    }
    const byId = Object.fromEntries(sf.sources.map((s) => [s.id, s]));
    expect(byId['lovevery-blog']).toMatchObject({ tier: 1, kind: 'activity', detection: 'feed', urls: ['https://blog.lovevery.com/feed/'], philosophy: ['lovevery'] });
    expect(byId['kavanaugh-report'].urls).toEqual(['https://www.thekavanaughreport.com/feeds/posts/default']);
    expect(byId['montessori-notebook'].detection).toBe('sitemap');
    expect(byId['nlb-libcal'].urls).toEqual(['https://nlb.libcal.com/rss.php?cid=11498&m=month']);
    expect(byId['onepa'].urls).toEqual(['https://www.onepa.gov.sg/sitemap.xml']);
    expect(byId['onepa'].max_items_per_run).toBeLessThanOrEqual(10);
    for (const id of ['honeykids-asia', 'sassy-mama-sg', 'little-day-out', 'theasianparent-sg']) {
      expect(byId[id]).toMatchObject({ tier: 2, detection: 'feed' });
    }
    for (const id of ['river-hongbao', 'chinatown-festivals', 'orchard-road', 'christmas-wonderland']) expect(byId[id].frequency).toBe('monthly');
    // Disabled sources must say why.
    for (const s of sf.sources.filter((x) => x.enabled === false)) expect(s.notes).toMatch(/Disabled/);
    expect(sf.sources.filter((s) => s.kind === 'activity' && s.philosophy?.includes('reggio_emilia')).length).toBeGreaterThanOrEqual(1);
  });

  it('rejects bad files with a clear message', () => {
    const bad = `version: 1
sources:
  - id: Bad Id
    name: ''
    tier: 3
    kind: event
    detection: rss
    urls: [notaurl]
    domains: []
    include: ['(unclosed']
    philosophy: [waldorf]
    max_items_per_run: 0
    colour: blue
  - id: dup
    name: A
    tier: 1
    kind: outing
    detection: feed
    urls: [https://a.sg/feed]
    domains: [a.sg]
  - id: dup
    name: B
    tier: 1
    kind: outing
    detection: feed
    urls: [https://b.sg/feed]
    domains: [b.sg]
`;
    let msg = '';
    try {
      parseSources(bad);
    } catch (e) {
      msg = (e as Error).message;
    }
    for (const part of ['id must be', 'name is required', 'tier must be 1 or 2', 'kind must be', 'detection must be', 'invalid url "notaurl"', 'domains must be', 'bad regex', 'philosophy "waldorf"', 'max_items_per_run', 'unknown field "colour"', 'duplicate id "dup"']) {
      expect(msg).toContain(part);
    }
    expect(() => parseSources('version: 1\nsources: []\n')).toThrow(/non-empty/);
    expect(() => parseSources('{{{')).toThrow(/sources\.yaml/);
  });

  it('maps URLs to sources and official domains', () => {
    expect(hostOf('https://WWW.Esplanade.com/whats-on')).toBe('esplanade.com');
    expect(hostOf('nope')).toBe('');
    expect(tier1Domains(sf)).toEqual(expect.arrayContaining(['blog.lovevery.com', 'nlb.libcal.com', 'onepa.gov.sg', 'esplanade.com']));
    expect(tier1Domains(sf)).not.toContain('honeykidsasia.com');
    expect(sourceForUrl(sf, 'https://www.esplanade.com/whats-on/2026/x')?.id).toBe('esplanade');
    expect(sourceForUrl(sf, 'https://blog.lovevery.com/post/')?.id).toBe('lovevery-blog');
    expect(sourceForUrl(sf, 'https://honeykidsasia.com/a/')).toBeUndefined(); // tier 2
    expect(isOfficialUrl(sf, 'https://www.nparks.gov.sg/visit/events')).toBe(true);
    expect(isOfficialUrl(sf, 'http://indianheritage.gov.sg')).toBe(true); // gov.sg catch-all
    expect(isOfficialUrl(sf, 'https://go.gov.sg/abc')).toBe(true);
    expect(isOfficialUrl(sf, 'https://www.sassymamasg.com/x')).toBe(false);
    expect(isOfficialUrl(sf, 'https://notgov.sg.example.com/')).toBe(false);
  });
});

/* ---------------------------------------------------------------------------------------------
 * Discovery
 * ------------------------------------------------------------------------------------------- */

const opts = { today: '2026-10-19', firstRunWindowDays: 30, runFrequency: 'weekly' as const };

describe('discoverSource', () => {
  it('first run on a feed: returns only last-30-day items, seeds the rest', async () => {
    const f = stubFetcher({ 'https://example.com/feed/': fx('kavanaugh_atom.xml').replace('2025-06-09', '2026-10-10') });
    const seen = emptySeen();
    const r = await discoverSource(src({}), f, seen, opts);
    expect(r.items.map((i) => i.url)).toEqual(['http://www.thekavanaughreport.com/2025/06/outdoor-montessori-work-for-summer.html']);
    expect(r.items[0]).toMatchObject({ sourceId: 'test-source', tier: 1, kind: 'activity', title: 'Outdoor Montessori Work for the Summer' });
    expect(r.stats).toMatchObject({ listed: 2, new: 2, selected: 1, seededOnly: 1, overCap: 0, errors: [] });
    expect(seen.initialized['test-source']).toBe('2026-10-19');
    expect(Object.keys(seen.urls)).toHaveLength(2);
    expect(seen.urls['http://www.thekavanaughreport.com/2025/04/montessori-friendly-easter-baskets-2025.html']).toEqual({
      first_seen: '2026-10-19',
      source: 'test-source',
    });
  });

  it('later runs: only unseen URLs; stale dated items are only recorded', async () => {
    const seen = emptySeen();
    const lovevery = fx('lovevery_feed.xml');
    const first = await discoverSource(src({}), stubFetcher({ 'https://example.com/feed/': lovevery }), seen, opts);
    expect(first.stats.selected).toBe(3); // all three are from 2026-09-29, within 30 days

    // Next week: one brand-new post, one new-to-us but old post, the three already seen.
    const extra = `<item><title>Brand new</title><link>https://blog.lovevery.com/new-post/</link><pubDate>Mon, 26 Oct 2026 01:00:00 +0000</pubDate></item>
      <item><title>Old but unseen</title><link>https://blog.lovevery.com/old-post/</link><pubDate>Mon, 01 Jun 2026 01:00:00 +0000</pubDate></item>`;
    const next = lovevery.replace('<item>', extra + '<item>');
    const r = await discoverSource(src({}), stubFetcher({ 'https://example.com/feed/': next }), seen, { ...opts, today: '2026-10-26' });
    expect(r.items.map((i) => i.title)).toEqual(['Brand new']);
    expect(r.stats).toMatchObject({ listed: 5, new: 2, selected: 1, seededOnly: 1 });
    expect(seen.urls['https://blog.lovevery.com/old-post/'].first_seen).toBe('2026-10-26');
  });

  it('NLB keyword filter keeps baby/toddler/storytime items (incl. audience tags)', async () => {
    const f = stubFetcher({ 'https://nlb.libcal.com/rss.php?cid=11498&m=month': fx('libcal_rss.xml') });
    const nlb = src({
      id: 'nlb-libcal',
      kind: 'outing',
      urls: ['https://nlb.libcal.com/rss.php?cid=11498&m=month'],
      domains: ['nlb.libcal.com'],
      keywords: ['baby', 'babies', 'toddler', 'toddlers', 'storytime', 'story time', 'Early READ'],
    });
    const r = await discoverSource(nlb, f, emptySeen(), opts);
    expect(r.stats.listed).toBe(3);
    // Newest (latest event date) first.
    expect(r.items.map((i) => i.title)).toEqual(['Storytime at Punggol Library', 'Baby Lapsit', 'Jiggle, Read & Rhyme']);
  });

  it('caps at max_items_per_run; over-cap items are still marked seen', async () => {
    const items = Array.from({ length: 6 }, (_, i) => `<item><title>Post ${i}</title><link>https://example.com/p${i}</link><pubDate>Mon, ${10 + i} Oct 2026 00:00:00 +0000</pubDate></item>`).join('');
    const feed = `<rss version="2.0"><channel>${items}</channel></rss>`;
    const seen = emptySeen();
    const r = await discoverSource(src({ max_items_per_run: 2 }), stubFetcher({ 'https://example.com/feed/': feed }), seen, opts);
    expect(r.items.map((i) => i.title)).toEqual(['Post 5', 'Post 4']);
    expect(r.stats).toMatchObject({ listed: 6, new: 6, selected: 2, overCap: 4 });
    expect(Object.keys(seen.urls)).toHaveLength(6);
    const again = await discoverSource(src({ max_items_per_run: 2 }), stubFetcher({ 'https://example.com/feed/': feed }), seen, opts);
    expect(again.items).toEqual([]);
    expect(again.stats.new).toBe(0);
  });

  it('sitemap: follows filtered index children, applies include, detects lastmod changes', async () => {
    const routes = {
      'https://montessorifromtheheart.com/sitemap.xml': fx('sitemap_index.xml'),
      'https://montessorifromtheheart.com/sitemap-1.xml': fx('sitemap_urlset.xml'),
    };
    const mfth = src({
      id: 'mfth',
      detection: 'sitemap',
      urls: ['https://montessorifromtheheart.com/sitemap.xml'],
      domains: ['montessorifromtheheart.com'],
      child_sitemaps: ['/sitemap(-index)?-\\d+\\.xml$'],
      include: ['montessorifromtheheart\\.com/\\d{4}/\\d{2}/\\d{2}/'],
    });
    const seen = emptySeen();
    const f = stubFetcher(routes);
    const first = await discoverSource(mfth, f, seen, opts);
    // image/video sitemaps were not requested
    expect(f.urls).toEqual(['https://montessorifromtheheart.com/sitemap.xml', 'https://montessorifromtheheart.com/sitemap-1.xml']);
    expect(first.stats.listed).toBe(5);
    // lastmod within 30 days: 2026-10-14, 2026-10-13 (old post, refreshed), 2026-10-12. 2026-09-02 and 2024 are seeded.
    expect(first.items.map((i) => i.url.replace('https://montessorifromtheheart.com', ''))).toEqual([
      '/2026/10/14/nature-mandalas-for-kids-beautiful-outdoor-art-activities/',
      '/2022/11/10/turkey-color-match-toddler-activity/',
      '/2026/10/12/diy-fall-color-matching-activity-for-toddlers-pumpkin-play/',
    ]);
    expect(first.stats.seededOnly).toBe(2);

    // A week later the 2016 post's lastmod changes -> new; an untouched URL is not.
    const changed = fx('sitemap_urlset.xml').replace('2024-01-05T07:13:58+00:00', '2026-10-20T07:00:00+00:00');
    const r = await discoverSource(mfth, stubFetcher({ ...routes, 'https://montessorifromtheheart.com/sitemap-1.xml': changed }), seen, { ...opts, today: '2026-10-26' });
    expect(r.items.map((i) => i.url)).toEqual(['https://montessorifromtheheart.com/2016/10/20/fall-inspired-sensory-bin/']);
    expect(seen.urls['https://montessorifromtheheart.com/2016/10/20/fall-inspired-sensory-bin/'].lastmod).toBe('2026-10-20T07:00:00.000Z');

    // track_lastmod: false ignores the change and dates items from their permalink instead.
    const seen2 = emptySeen();
    const noLm = { ...mfth, track_lastmod: false };
    const a = await discoverSource(noLm, stubFetcher(routes), seen2, opts);
    expect(a.items.map((i) => i.date)).toEqual(['2026-10-14T00:00:00.000Z', '2026-10-12T00:00:00.000Z']); // the refreshed 2022 post is not "recent"
    const b = await discoverSource(noLm, stubFetcher({ ...routes, 'https://montessorifromtheheart.com/sitemap-1.xml': changed }), seen2, { ...opts, today: '2026-10-26' });
    expect(b.items).toEqual([]);
  });

  it('listing: diffs same-host item links filtered by include', async () => {
    const url = 'https://www.changiairport.com/en/happenings/events-directory.html';
    const changi = src({
      id: 'changi',
      kind: 'outing',
      detection: 'listing',
      urls: [url],
      domains: ['changiairport.com'],
      include: ['changiairport\\.com/en/happenings/events-directory/.+\\.html'],
    });
    const seen = emptySeen();
    const first = await discoverSource(changi, stubFetcher({ [url]: { body: fx('listing.html'), contentType: 'text/html' } }), seen, opts);
    // Undated listing links are seeded on the first run.
    expect(first.items).toEqual([]);
    expect(first.stats).toMatchObject({ listed: 3, new: 3, seededOnly: 3 });

    const html = fx('listing.html').replace(
      '<div class="card-list">',
      '<div class="card-list"><div class="card"><a href="/en/happenings/events-directory/christmas-2026.html">Christmas at Changi</a></div>',
    );
    const r = await discoverSource(changi, stubFetcher({ [url]: { body: html, contentType: 'text/html' } }), seen, opts);
    expect(r.items).toEqual([
      { url: 'https://www.changiairport.com/en/happenings/events-directory/christmas-2026.html', sourceId: 'changi', tier: 1, kind: 'outing', title: 'Christmas at Changi' },
    ]);
  });

  it('skips monthly sources on weekly runs and disabled sources', async () => {
    const f = stubFetcher({});
    const monthly = await discoverSource(src({ frequency: 'monthly' }), f, emptySeen(), opts);
    expect(monthly.items).toEqual([]);
    expect(monthly.stats.skipped).toMatch(/monthly/);
    const disabled = await discoverSource(src({ enabled: false }), f, emptySeen(), opts);
    expect(disabled.stats.skipped).toBe('disabled');
    expect(f.urls).toEqual([]);
    const readMonthly = await discoverSource(src({ frequency: 'monthly' }), stubFetcher({ 'https://example.com/feed/': fx('lovevery_feed.xml') }), emptySeen(), { ...opts, runFrequency: 'monthly' });
    expect(readMonthly.stats.listed).toBe(3);
  });

  it('records errors without throwing and does not seed a source it could not read', async () => {
    const seen = emptySeen();
    const r = await discoverSource(src({}), stubFetcher({ 'https://example.com/feed/': { status: 500 } }), seen, opts);
    expect(r.items).toEqual([]);
    expect(r.stats.errors).toEqual(['https://example.com/feed/: http_500']);
    expect(seen.initialized['test-source']).toBeUndefined();
    const notFeed = await discoverSource(src({}), stubFetcher({ 'https://example.com/feed/': { body: '<html>oops</html>', contentType: 'text/html' } }), seen, opts);
    expect(notFeed.stats.errors[0]).toMatch(/not a feed/);
    const throwing: Fetcher = { get: async () => { throw new Error('boom'); } };
    const t = await discoverSource(src({}), throwing, seen, opts);
    expect(t.stats.errors[0]).toMatch(/boom/);
  });

  it('normalises URLs (fragments, utm parameters) and reads dates from permalinks', () => {
    expect(normUrl('https://sg.theasianparent.com/a?utm_source=rss-feed&utm_medium=rss&id=2#top')).toBe('https://sg.theasianparent.com/a?id=2');
    expect(dateFromUrl('https://x.com/2026/10/14/slug/')).toBe('2026-10-14');
    expect(dateFromUrl('https://x.com/2026/13/14/slug/')).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------------------------
 * Pages and tier-2 resolution
 * ------------------------------------------------------------------------------------------- */

describe('fetchPage', () => {
  it('returns text, title and raw HTML', async () => {
    const url = 'https://www.littledayout.com/indian-heritage-centre-deepavali-open-house/';
    const f = stubFetcher({ [url]: { body: fx('aggregator_article.html'), contentType: 'text/html; charset=UTF-8' } });
    const p = await fetchPage(f, url, () => new Date('2026-10-19T00:00:00Z'));
    expect(p).toMatchObject({ url, finalUrl: url, title: 'Indian Heritage Centre Deepavali Open House 2026: House of Memories', fetchedAt: '2026-10-19T00:00:00.000Z' });
    expect((p as PageContext).text).toContain('When: 17 October to 8 November 2026');
    expect((p as PageContext).html).toContain('<article');
  });

  it('reports HTTP errors and non-HTML content', async () => {
    const f = stubFetcher({ 'https://a.sg/x': { status: 404 }, 'https://a.sg/pdf': { body: '%PDF', contentType: 'application/pdf' } });
    expect(await fetchPage(f, 'https://a.sg/x')).toEqual({ error: 'http_404', status: 404 });
    expect(await fetchPage(f, 'https://a.sg/pdf')).toEqual({ error: 'unsupported_content_type: application/pdf', status: 200 });
  });
});

describe('resolveOfficialUrl', () => {
  const sf = loadSourcesFile();
  const url = 'https://www.littledayout.com/indian-heritage-centre-deepavali-open-house/';
  const page = (html: string): PageContext => ({ url, finalUrl: url, title: 'IHC Deepavali Open House', text: '', html, fetchedAt: '2026-10-19T00:00:00Z' });
  const item: DiscoveredItem = {
    url,
    sourceId: 'little-day-out',
    tier: 2,
    kind: 'outing',
    title: 'Indian Heritage Centre Deepavali Open House 2026: House of Memories',
  };

  it('picks the official link in the article, best title overlap first', () => {
    // Candidates: indianheritage.gov.sg (title words "indian heritage") and nhb.gov.sg ("national heritage board").
    // Not: the aggregator itself, Facebook, bit.ly, SISTIC (ticketing), the aside/nav links.
    expect(resolveOfficialUrl(page(fx('aggregator_article.html')), item, sf)).toBe('http://indianheritage.gov.sg/');
  });

  it('prefers a deep link with matching words over a generic home page', () => {
    const html = `<article><a href="https://www.esplanade.com/">Esplanade</a>
      <a href="https://www.esplanade.com/whats-on/festivals-and-series/playtime/2026/the-amazing-sarong">The Amazing Sarong</a></article>`;
    const it2 = { ...item, title: 'PLAYtime! The Amazing Sarong at Esplanade for toddlers' };
    expect(resolveOfficialUrl(page(html), it2, sf)).toBe('https://www.esplanade.com/whats-on/festivals-and-series/playtime/2026/the-amazing-sarong');
  });

  it('accepts go.gov.sg short links but not other shorteners or social media', () => {
    const html = `<article><a href="https://bit.ly/abc">Register</a><a href="https://www.instagram.com/nlbsg">IG</a>
      <a href="https://go.gov.sg/early-read-fiesta">Early READ Fiesta registration</a></article>`;
    expect(resolveOfficialUrl(page(html), { ...item, title: 'Early READ Fiesta 2026' }, sf)).toBe('https://go.gov.sg/early-read-fiesta');
  });

  it('returns null when there is no official link, or only unrelated ones', () => {
    expect(resolveOfficialUrl(page('<article><a href="https://shop.example.com/x">Buy</a></article>'), item, sf)).toBeNull();
    const unrelated = `<article><a href="https://www.mandai.com/en/singapore-zoo.html">Zoo</a><a href="https://www.sentosa.com.sg/en/">Sentosa</a></article>`;
    expect(resolveOfficialUrl(page(unrelated), item, sf)).toBeNull();
    // A lone official link is trusted even without title overlap.
    expect(resolveOfficialUrl(page('<article><a href="https://www.nparks.gov.sg/visit/parks/x">Park page</a></article>'), item, sf)).toBe(
      'https://www.nparks.gov.sg/visit/parks/x',
    );
  });

  it('ignores links back to the aggregator and other tier-2 hosts', () => {
    const html = `<article><a href="https://www.littledayout.com/other/">Indian Heritage Centre guide</a>
      <a href="https://www.sassymamasg.com/deepavali/">Indian Heritage Centre Deepavali</a></article>`;
    expect(resolveOfficialUrl(page(html), item, sf)).toBeNull();
  });
});
