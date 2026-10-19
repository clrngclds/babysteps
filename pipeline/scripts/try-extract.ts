/**
 * Live smoke test for the extract area (a handful of Vertex AI calls, cents).
 *   npx tsx pipeline/scripts/try-extract.ts [lovevery-post-url] [libcal-event-url]
 * Fetches one Lovevery post and one NLB LibCal storytime, extracts, reviews one candidate,
 * re-checks one venue, and checks each supporting_quote is verbatim in the page text.
 * Uses a crude local fetch + HTML strip; the real pipeline uses the fetch area's Fetcher.
 * STEPS=extract,review,venue selects steps; STRIP_ONLY=<url> prints the stripped text (no Vertex call).
 */
import { readFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import { estimateCost, sgtToday } from '../src/config';
import { extractCandidates } from '../src/extract/extract';
import { reviewCandidate, reviewPasses } from '../src/extract/review';
import { compareVenue } from '../src/extract/venue';
import { createVertexLlm } from '../src/extract/vertex';
import type { Llm, LlmUsage, MilestonesFile, Outing, PageContext, SourceConfig } from '../src/types';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '\u2019', lsquo: '\u2018',
  rdquo: '\u201d', ldquo: '\u201c', ndash: '\u2013', mdash: '\u2014', hellip: '\u2026',
};
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
function stripHtml(html: string): { title: string; text: string } {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim());
  let body = html.match(/<article[\s\S]*<\/article>/i)?.[0] ?? html.match(/<main[\s\S]*<\/main>/i)?.[0] ?? html;
  body = body
    .replace(/<(script|style|noscript|svg|nav|header|footer|form|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?(?:p|div|li|h[1-6]|br|tr|section|ul|ol)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, ' ')
    // Quoted attribute values may contain '>' (JSON props with escaped HTML), so skip over them.
    .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, '');
  return { title, text: decode(body).replace(/\s+/g, ' ').trim() };
}

async function get(url: string): Promise<{ finalUrl: string; body: string }> {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return { finalUrl: r.url, body: await r.text() };
}
async function page(url: string): Promise<PageContext> {
  const { finalUrl, body } = await get(url);
  const { title, text } = stripHtml(body);
  return { url, finalUrl, title, text, html: body, fetchedAt: new Date().toISOString() };
}
function rssLinks(xml: string): { title: string; link: string }[] {
  const doc = new XMLParser().parse(xml);
  const items = doc?.rss?.channel?.item ?? [];
  return (Array.isArray(items) ? items : [items]).map((i: { title: unknown; link: unknown }) => ({ title: String(i.title), link: String(i.link) }));
}

/** Longest run of consecutive words in `field` that also appears in `page` (the no-copying rule allows 8). */
function longestCopiedRun(field: string, page: string): number {
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
  const w = norm(field);
  const hay = ` ${norm(page).join(' ')} `;
  let best = 0;
  for (let i = 0; i < w.length; i++) {
    for (let j = i + best + 1; j <= w.length; j++) {
      if (hay.includes(` ${w.slice(i, j).join(' ')} `)) best = j - i;
      else break;
    }
  }
  return best;
}
const TEXT_FIELDS = ['title', 'name', 'summary', 'how_to', 'safety_notes', 'notes'];

function usageDelta(llm: Llm, before: Record<string, LlmUsage>, purpose: string): string {
  const a = llm.usage()[purpose];
  const b = before[purpose] ?? { calls: 0, promptTokens: 0, outputTokens: 0, thoughtsTokens: 0 };
  const d = { promptTokens: a.promptTokens - b.promptTokens, outputTokens: a.outputTokens - b.outputTokens, thoughtsTokens: a.thoughtsTokens - b.thoughtsTokens };
  return `in=${d.promptTokens} out=${d.outputTokens} thoughts=${d.thoughtsTokens} ~$${estimateCost(llm.model, d).toFixed(5)}`;
}

async function main() {
  if (process.env.STRIP_ONLY) {
    const p = await page(process.env.STRIP_ONLY);
    console.log(p.text.length, p.text.slice(0, 3000));
    return;
  }
  const milestones = JSON.parse(readFileSync('data/milestones.json', 'utf8')) as MilestonesFile;
  const outings = JSON.parse(readFileSync('data/sg_outings.json', 'utf8')) as Outing[];
  const today = sgtToday();
  const llm = createVertexLlm({ project: process.env.GCP_PROJECT || 'dc-test2-489503', location: 'asia-southeast1', model: 'gemini-2.5-flash', thinkingBudget: 0 });

  const lovevery: SourceConfig = { id: 'lovevery-blog', name: 'Lovevery', tier: 1, kind: 'activity', detection: 'feed', urls: ['https://blog.lovevery.com/feed/'], domains: ['blog.lovevery.com'], philosophy: ['lovevery'] };
  const nlb: SourceConfig = { id: 'nlb-libcal', name: 'NLB GoLibrary', tier: 1, kind: 'outing', detection: 'feed', urls: ['https://nlb.libcal.com/rss.php?cid=11498&m=month'], domains: ['nlb.libcal.com'] };

  // STEPS=venue runs only the venue re-check (saves calls when iterating).
  const steps = (process.env.STEPS || 'extract,review,venue').split(',');
  let actUrl = process.argv[2];
  if (!actUrl && steps.includes('extract')) {
    const feed = rssLinks((await get(lovevery.urls[0])).body);
    actUrl = feed[0].link;
    console.log(`Lovevery feed: picked "${feed[0].title}"`);
    await sleep(3000);
  }
  let evUrl = process.argv[3];
  if (!evUrl && steps.includes('extract')) {
    const items = rssLinks((await get(nlb.urls[0])).body);
    const pick = items.find((i) => /baby|lapsit|toddler|little ones/i.test(i.title)) ?? items.find((i) => /story/i.test(i.title));
    if (!pick) throw new Error('no baby/toddler item in LibCal feed');
    evUrl = pick.link;
    console.log(`LibCal feed (${items.length} items): picked "${pick.title}"`);
  }

  const results: { label: string; p: PageContext; src: SourceConfig }[] = [];
  for (const [label, url, src] of steps.includes('extract') ? ([['activity', actUrl, lovevery], ['outing', evUrl, nlb]] as const) : []) {
    await sleep(3000);
    const p = await page(url);
    console.log(`\n=== ${label}: ${p.finalUrl}\n    title: ${p.title} | text ${p.text.length} chars`);
    results.push({ label, p, src });
  }

  let firstCand: { c: Awaited<ReturnType<typeof extractCandidates>>['candidates'][number]; p: PageContext } | undefined;
  for (const { label, p, src } of results) {
    const before = llm.usage();
    const t0 = Date.now();
    const r = await extractCandidates(llm, p, src, { milestones, today });
    console.log(`\n--- extract ${label} (${Date.now() - t0} ms) ${usageDelta(llm, before, 'extract')}${r.blocked ? ` BLOCKED ${r.blocked}` : ''}`);
    for (const c of r.candidates) {
      const verbatim = p.text.includes(c.supporting_quote);
      console.log(JSON.stringify(c.draft, null, 1));
      console.log(`quote verbatim: ${verbatim ? 'YES' : 'NO'} | "${c.supporting_quote}"`);
      const d = c.draft as unknown as Record<string, unknown>;
      const runs = TEXT_FIELDS.filter((k) => typeof d[k] === 'string' && d[k]).map((k) => `${k}=${longestCopiedRun(d[k] as string, p.text)}`);
      console.log(`longest copied word run: ${runs.join(' ')}`);
      if (!firstCand) firstCand = { c, p };
    }
    if (r.candidates.length === 0) console.log('(no candidates)');
  }

  if (firstCand && steps.includes('review')) {
    const before = llm.usage();
    const s = await reviewCandidate(llm, firstCand.c, firstCand.p);
    console.log(`\n--- review "${'title' in firstCand.c.draft ? firstCand.c.draft.title : ''}" ${usageDelta(llm, before, 'review')}`);
    console.log(JSON.stringify(s), 'passes:', reviewPasses(s));
  }

  const venue = outings.find((o) => o.id === 'sg-venue-singapore-oceanarium');
  if (venue && steps.includes('venue')) {
    await sleep(2000);
    const vp = await page(venue.url);
    const before = llm.usage();
    const v = await compareVenue(llm, venue, vp, today);
    console.log(`\n--- venue ${venue.id} (${vp.text.length} chars) ${usageDelta(llm, before, 'venue')}`);
    console.log(JSON.stringify(v, null, 1), v.supporting_quote ? `quote verbatim: ${vp.text.includes(v.supporting_quote) ? 'YES' : 'NO'}` : '');
  }

  console.log('\nusage by purpose:', JSON.stringify(llm.usage()));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
