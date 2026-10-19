import { describe, expect, it, vi } from 'vitest';
import activitiesJson from '../../data/activities.json';
import milestonesJson from '../../data/milestones.json';
import outingsJson from '../../data/sg_outings.json';
import {
  allowedMilestoneMonths,
  countSentences,
  g1Schema,
  g2Grounding,
  g3AllowList,
  g5Review,
  g6Dedupe,
  g7Events,
  g8Quotas,
  g9Catalog,
  isRetryable,
  loveveryShare,
  normalizeUrl,
  runCandidateGates,
} from '../../pipeline/src/gates/gates';
import { loadSafetyRules } from '../../pipeline/src/gates/safety';
import { keywords, normalizeText, similarity, tokens } from '../../pipeline/src/gates/text';
import type {
  Activity,
  ActivityDraft,
  Candidate,
  ContentSet,
  GateContext,
  MilestonesFile,
  Outing,
  OutingDraft,
  PageContext,
  ReviewScores,
  SourcesFile,
} from '../../pipeline/src/types';
import { DEFAULT_QUOTAS } from '../../pipeline/src/types';

const activities = activitiesJson as Activity[];
const outings = outingsJson as Outing[];
const milestones = milestonesJson as MilestonesFile;
const TODAY = '2026-10-19';
const SAFETY = loadSafetyRules();

const SOURCES: SourcesFile = {
  version: 1,
  official_domains: ['go.gov.sg'],
  sources: [
    { id: 'lovevery-blog', name: 'Lovevery blog', tier: 1, kind: 'activity', detection: 'feed', urls: ['https://blog.lovevery.com/feed/'], domains: ['blog.lovevery.com'], philosophy: ['lovevery'] },
    { id: 'kavanaugh', name: 'The Kavanaugh Report', tier: 1, kind: 'activity', detection: 'feed', urls: ['https://www.thekavanaughreport.com/feeds/posts/default'], domains: ['thekavanaughreport.com'], philosophy: ['montessori'] },
    { id: 'nlb-events', name: 'NLB events', tier: 1, kind: 'outing', detection: 'feed', urls: ['https://nlb.libcal.com/rss.php?cid=11498&m=month'], domains: ['nlb.libcal.com', 'nlb.gov.sg'] },
    { id: 'sassy-mama', name: 'Sassy Mama', tier: 2, kind: 'outing', detection: 'listing', urls: ['https://www.sassymamasg.com/'], domains: ['sassymamasg.com'] },
  ],
};

const strip = <T extends { id: string }>(r: T) => {
  const { id: _i, verified: _v, added_at: _a, status: _s, origin: _o, last_verified: _l, ...draft } = r as T & Record<string, unknown>;
  return draft;
};

/* Activity base: act-m06-gm-01 "Laundry basket sleigh ride" (Lovevery), treated as new. */
const SLEIGH = activities.find((a) => a.id === 'act-m06-gm-01')!;
const ACT_PAGE: PageContext = {
  url: SLEIGH.source_url,
  finalUrl: SLEIGH.source_url,
  title: 'Activities for 6-month-olds from a child development expert',
  text:
    'Activities for 6-month-olds from a child development expert. At six months many babies are starting to sit with support. ' +
    'A laundry basket sleigh ride is a fun way to practise balance: pop your baby in a basket with a few cushions for support ' +
    "and pull them slowly around the room while you talk about what you see. Changes of direction give your baby\u2019s core " +
    'muscles a gentle workout.',
  html: '',
  fetchedAt: `${TODAY}T00:00:00Z`,
};

function actCandidate(over: Partial<ActivityDraft> = {}, extra: Partial<Candidate> = {}): Candidate {
  return {
    kind: 'activity',
    draft: { ...(strip(SLEIGH) as ActivityDraft), ...over },
    supporting_quote: 'pull them slowly around the room while you talk about what you see',
    source_id: 'lovevery-blog',
    page_url: SLEIGH.source_url,
    extracted_at: `${TODAY}T00:00:00Z`,
    attempts: 1,
    ...extra,
  };
}

/* Outing base: the Early READ Fiesta event at Woodlands (NLB), treated as new. */
const FIESTA = outings.find((o) => o.id === 'sg-event-early-read-fiesta-woodlands')!;
const OUT_PAGE: PageContext = {
  url: FIESTA.url,
  finalUrl: FIESTA.url,
  title: 'Early READ Fiesta at Woodlands Library',
  text:
    'Early READ Fiesta at Woodlands Library. Friday, November 13, 2026 \u2013 Saturday, November 14, 2026, 10:00am - 5:00pm. ' +
    'Woodlands Regional Library. Join us for storytelling, interactive stations and activity booths for children aged 0 to 6 ' +
    'and their parents and caregivers.',
  html: '',
  fetchedAt: `${TODAY}T00:00:00Z`,
};

function outCandidate(over: Partial<OutingDraft> = {}, page: Partial<Candidate> = {}): Candidate {
  return {
    kind: 'outing',
    draft: { ...(strip(FIESTA) as OutingDraft), ...over },
    supporting_quote: 'join us for storytelling, interactive stations and activity booths for children aged 0 to 6',
    source_id: 'nlb-events',
    page_url: FIESTA.url,
    extracted_at: `${TODAY}T00:00:00Z`,
    attempts: 1,
    ...page,
  };
}

/** Content without the base records, so the bases are "new". */
const CONTENT: ContentSet = {
  activities: activities.filter((a) => a.id !== SLEIGH.id),
  outings: outings.filter((o) => o.id !== FIESTA.id),
  milestones,
};

const GOOD: ReviewScores = { age_appropriate: 5, safety: 5, no_medical_claims: 5, not_product_only: 4, notes: '' };

function ctx(page: PageContext, over: Partial<GateContext> = {}): GateContext {
  return { content: CONTENT, sources: SOURCES, safety: SAFETY, page, today: TODAY, review: async () => GOOD, ...over };
}

/* ---------------------------------------------------------------------------------------------- */

describe('text helpers', () => {
  it('normalizeText folds quotes, dashes, ellipsis, nbsp, zero-width and case', () => {
    expect(normalizeText('\u201cBaby\u2019s\u00a0 First\u2014Toy\u2026\u201d\u200b')).toBe('"baby\'s first-toy..."');
    expect(normalizeText('  Pur\u00e9e\n\tTime ')).toBe('puree time');
  });
  it('tokens drops punctuation, keeps inner apostrophes', () => {
    expect(tokens('Child\u2019s toilet-roll tube, (big)!')).toEqual(["child's", 'toilet', 'roll', 'tube', 'big']);
  });
  it('keywords drops stopwords, generic words and short words', () => {
    expect(keywords('Laundry basket sleigh ride')).toEqual(['laundry', 'basket', 'sleigh', 'ride']);
    expect(keywords('Copy your baby\u2019s coos')).toEqual(['copy', 'coos']);
    expect(keywords('Up we go')).toEqual([]);
  });

  // Pairs from the real dataset (data/activities.json) and obvious rewordings of them.
  it.each([
    ['Laundry basket sleigh ride', 'Sleigh ride in a laundry basket'],
    ['Open cup sips', 'First sips from an open cup'],
    ['Bell on a ribbon', 'Bells on ribbons'],
    ['Tummy time on a beach ball', 'Beach ball tummy time'],
    ['Just out of reach', 'Ball just out of reach'],
    ['Early READ Fiesta at Woodlands Library', 'Early READ Fiesta at Woodlands Regional Library'],
  ])('rewording scores >= 0.8: %s / %s', (a, b) => {
    expect(similarity(a, b)).toBeGreaterThanOrEqual(0.8);
  });
  it.each([
    ['Metal treasure basket', 'Heuristic treasure basket'],
    ['Treasure basket of kitchen items', 'Treasure basket of natural items'],
    ['Egg and cup', 'Peg and cup'],
    ['Scoop and sort by colour', 'Sort by colour only'],
    ['Mirror tummy time', 'Airplane tummy time'],
    ['Laundry basket sleigh ride', 'Laundry basket peekaboo'],
    ['Early READ Fiesta at Woodlands Library', 'Early READ Fiesta at Punggol Regional Library'],
  ])('different activities sharing a theme score < 0.8: %s / %s', (a, b) => {
    expect(similarity(a, b)).toBeLessThan(0.8);
  });
  it('similarity edge cases', () => {
    expect(similarity('Same', 'same')).toBe(1);
    expect(similarity('', 'x')).toBe(0);
  });
});

describe('countSentences', () => {
  it('counts sentences but not quotes or abbreviations', () => {
    expect(countSentences('One. Two! Three?')).toBe(3);
    expect(countSentences("You put dot stickers on body parts and play 'Where is your nose? Your elbow?'")).toBe(1);
    expect(countSentences('A finding game: "Where is Nana? There she is!"')).toBe(1);
    expect(countSentences("Resorts World Sentosa's aquarium, which replaced S.E.A. Aquarium in July 2026, with 22 zones.")).toBe(1);
    expect(countSentences('Use household items, e.g. A spoon.')).toBe(1);
  });
});

/* ---------------------------------------------------------------------------------------------- */

describe('G1 schema', () => {
  it('passes the real activity and outing as new candidates', () => {
    expect(g1Schema(actCandidate(), ctx(ACT_PAGE))).toEqual([]);
    expect(g1Schema(outCandidate(), ctx(OUT_PAGE))).toEqual([]);
  });
  it('fails a bad enum value', () => {
    const f = g1Schema(actCandidate({ energy: 'wild' as ActivityDraft['energy'] }), ctx(ACT_PAGE));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ gate: 'G1', fixable: false });
    expect(f[0].reason).toMatch(/bad energy wild/);
  });
  it('fails a milestone that does not exist', () => {
    expect(g1Schema(actCandidate({ milestone_ids: ['gm-99-9'] }), ctx(ACT_PAGE))[0].reason).toMatch(/gm-99-9 does not resolve/);
  });
  it('fails a milestone from the wrong checkpoint', () => {
    const f = g1Schema(actCandidate({ milestone_ids: ['gm-06-3', 'gm-24-1'] }), ctx(ACT_PAGE));
    expect(f).toHaveLength(1);
    expect(f[0].reason).toMatch(/gm-24-1 is from the 24-month checkpoint/);
  });
  it('allows current and next checkpoint, and 30 for the last band', () => {
    const cps = milestones.checkpoints_months;
    expect(allowedMilestoneMonths(6, cps)).toEqual([6, 9]);
    expect(allowedMilestoneMonths(7, cps)).toEqual([9, 12]);
    expect(allowedMilestoneMonths(33, cps)).toEqual([36, 30]);
    const m33 = activities.find((a) => a.id === 'act-m33-gm-02')!;
    expect(g1Schema(actCandidate(strip(m33) as ActivityDraft), ctx(ACT_PAGE))).toEqual([]);
  });
  it('fails a two-sentence summary, a 6-sentence how_to and a silly title', () => {
    const f = g1Schema(
      actCandidate({ summary: 'Pull them. They balance.', how_to: 'Sit them in the basket. Pull slowly. Turn left. Turn right. Stop and smile. Go again.', title: 'x'.repeat(90) }),
      ctx(ACT_PAGE),
    ).map((x) => x.reason);
    expect(f.some((r) => /summary must be one sentence/.test(r))).toBe(true);
    expect(f.some((r) => /how_to must be 1-5 sentences \(has 6\)/.test(r))).toBe(true);
    expect(f.some((r) => /title length 90/.test(r))).toBe(true);
  });
  it('fails a bad outing region; leaves a missing event date to G7', () => {
    expect(g1Schema(outCandidate({ region: 'south' as Outing['region'] }), ctx(OUT_PAGE))[0].reason).toMatch(/bad region south/);
    expect(g1Schema(outCandidate({ start_date: null, end_date: null }), ctx(OUT_PAGE))).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------------------------- */

describe('G2 grounding', () => {
  it('passes a verbatim quote despite curly vs straight quotes and whitespace', () => {
    const c = actCandidate({}, { supporting_quote: "  Changes of direction give your baby's\n core   muscles a gentle workout. " });
    expect(g2Grounding(c, ACT_PAGE)).toEqual([]);
    const page = { ...ACT_PAGE, text: ACT_PAGE.text.replace('talk about', 'talk\u00a0 \u201cabout\u201d') };
    expect(g2Grounding(actCandidate(), page)).toEqual([]);
  });
  it('fails a paraphrased quote', () => {
    const f = g2Grounding(actCandidate({}, { supporting_quote: 'pull them gently around the room and talk about the things you see' }), ACT_PAGE);
    expect(f).toEqual([{ gate: 'G2', fixable: false, reason: 'supporting quote not found word-for-word on the page' }]);
  });
  it('fails a quote under 8 words', () => {
    expect(g2Grounding(actCandidate({}, { supporting_quote: 'a laundry basket sleigh ride' }), ACT_PAGE)[0].reason).toMatch(/5 words \(need at least 8\)/);
  });
  it('fails when title keywords are missing from the page', () => {
    const f = g2Grounding(actCandidate({ title: 'Rocket ship blast off' }), ACT_PAGE);
    expect(f).toHaveLength(1);
    expect(f[0].reason).toMatch(/title keywords not on the page: rocket, ship, blast/);
    // Half the keywords is enough.
    expect(g2Grounding(actCandidate({ title: 'Laundry basket rocket ship' }), ACT_PAGE)).toEqual([]);
  });
  it('fails a copied run of 12 words (own-words rule)', () => {
    const copied = 'Pop your baby in a basket with a few cushions for support and pull them slowly.';
    const f = g2Grounding(actCandidate({ summary: copied }), ACT_PAGE);
    expect(f).toHaveLength(1);
    expect(f[0].reason).toMatch(/summary copies 12\+ words/);
    // 11 copied words in a row is still allowed.
    const eleven = 'Pop your baby in a basket with a few cushions for comfort, then go.';
    expect(g2Grounding(actCandidate({ summary: eleven }), ACT_PAGE)).toEqual([]);
  });
  it('empty page text is fixable', () => {
    expect(g2Grounding(actCandidate(), { ...ACT_PAGE, text: '  ' })).toEqual([
      { gate: 'G2', fixable: true, reason: 'page text empty (page may not have loaded)' },
    ]);
  });
});

/* ---------------------------------------------------------------------------------------------- */

describe('G3 allow-list', () => {
  it('passes tier-1 hosts, subdomains, www and official domains', () => {
    expect(g3AllowList(actCandidate(), SOURCES)).toEqual([]);
    const k = 'https://www.thekavanaughreport.com/2026/10/post.html';
    expect(g3AllowList(actCandidate({ source_url: k }, { page_url: k }), SOURCES)).toEqual([]);
    expect(g3AllowList(outCandidate({ url: 'https://go.gov.sg/jbcg' }, { page_url: 'https://go.gov.sg/jbcg' }), SOURCES)).toEqual([]);
    expect(g3AllowList(outCandidate({ url: 'https://events.nlb.gov.sg/x' }, { page_url: 'https://events.nlb.gov.sg/x' }), SOURCES)).toEqual([]);
  });
  it('rejects a tier-2 host and a look-alike host', () => {
    const t2 = 'https://www.sassymamasg.com/things-to-do-with-kids/';
    const f = g3AllowList(outCandidate({ url: t2 }, { page_url: t2 }), SOURCES);
    expect(f).toHaveLength(2);
    expect(f[0]).toMatchObject({ gate: 'G3', fixable: false });
    expect(f[0].reason).toMatch(/sassymamasg\.com is not a tier-1 source/);
    expect(g3AllowList(actCandidate({ source_url: 'https://notblog.lovevery.com.evil.io/x' }), SOURCES)[0].reason).toMatch(/source_url/);
  });
  it('rejects an invalid URL', () => {
    expect(g3AllowList(actCandidate({}, { page_url: 'not a url' }), SOURCES)[0].reason).toBe('page_url is not a valid URL');
  });
});

/* ---------------------------------------------------------------------------------------------- */

describe('G5 AI review', () => {
  it('passes when every score >= 4 and stores the scores', async () => {
    const c = actCandidate();
    expect(await g5Review(c, ctx(ACT_PAGE))).toEqual([]);
    expect(c.review).toEqual(GOOD);
  });
  it('fails on a score of 3, listing the low scores and notes', async () => {
    const c = actCandidate();
    const f = await g5Review(c, ctx(ACT_PAGE, { review: async () => ({ ...GOOD, safety: 3, notes: 'Basket could tip.' }) }));
    expect(f).toEqual([{ gate: 'G5', fixable: false, reason: 'AI review below 4/5: safety 3. Notes: Basket could tip.' }]);
    expect(c.review?.safety).toBe(3);
  });
  it('a reviewer error or incomplete scores is fixable', async () => {
    const thrown = await g5Review(actCandidate(), ctx(ACT_PAGE, { review: async () => { throw new Error('429 quota'); } }));
    expect(thrown[0]).toMatchObject({ gate: 'G5', fixable: true });
    expect(thrown[0].reason).toMatch(/429 quota/);
    const partial = await g5Review(actCandidate(), ctx(ACT_PAGE, { review: async () => ({ safety: 5 }) as unknown as ReviewScores }));
    expect(partial[0]).toMatchObject({ gate: 'G5', fixable: true });
  });
});

/* ---------------------------------------------------------------------------------------------- */

describe('G6 duplicates', () => {
  const OTHER_URL = 'https://www.thekavanaughreport.com/2026/10/sleigh.html';
  const content = (acts: Activity[] = activities, outs: Outing[] = outings) => ({ activities: acts, outings: outs });

  it('passes a new activity', () => {
    expect(g6Dedupe(actCandidate(), CONTENT)).toEqual([]);
  });
  it('fails a reworded duplicate within 2 months; passes 3 months away', () => {
    const c = (month: number) => actCandidate({ title: 'Sleigh ride in a laundry basket', month, source_url: OTHER_URL });
    expect(g6Dedupe(c(8), content())[0].reason).toMatch(/too similar to act-m06-gm-01/);
    expect(g6Dedupe(c(4), content())).toHaveLength(1);
    expect(g6Dedupe(c(9), content())).toEqual([]);
    expect(g6Dedupe(c(3), content())).toEqual([]);
  });
  it('fails same source URL + similar title at any month', () => {
    const f = g6Dedupe(actCandidate({ title: 'Laundry basket sleigh', month: 20 }), content());
    expect(f[0]).toMatchObject({ gate: 'G6', fixable: false });
    expect(f[0].reason).toMatch(/same source page and similar title as act-m06-gm-01/);
  });
  it('retired items count for the same-page check only', () => {
    const retired = activities.map((a) => (a.id === SLEIGH.id ? { ...a, status: 'retired' } : a));
    expect(g6Dedupe(actCandidate(), content(retired))).toHaveLength(1);
    expect(g6Dedupe(actCandidate({ title: 'Sleigh ride in a laundry basket', source_url: OTHER_URL }), content(retired))).toEqual([]);
  });
  it('catches duplicates accepted earlier in the same run', () => {
    const first = actCandidate({ source_url: OTHER_URL }, { page_url: OTHER_URL });
    const again = actCandidate({ title: 'Sleigh ride in a laundry basket', month: 7 });
    expect(g6Dedupe(again, CONTENT, [first])[0].reason).toMatch(/accepted earlier this run/);
  });
  it('outings: same-name event with different dates is a new edition; overlapping dates is a duplicate', () => {
    const next = outCandidate({ start_date: '2027-11-12', end_date: '2027-11-13' }, {});
    expect(g6Dedupe(next, content())).toEqual([]);
    const overlap = outCandidate({ start_date: '2026-11-14', end_date: '2026-11-15', url: 'https://nlb.libcal.com/event/1' });
    expect(g6Dedupe(overlap, content())[0].reason).toMatch(/duplicate of sg-event-early-read-fiesta-woodlands/);
  });
  it('outings: a similar name to an existing venue is a duplicate unless it replaces it', () => {
    const venue = outings.find((o) => o.id === 'sg-venue-jacob-ballas')!;
    const c = outCandidate({ ...(strip(venue) as OutingDraft), name: "Jacob Ballas Children's Garden (Botanic Gardens)", url: 'https://www.nparks.gov.sg/jbcg' });
    expect(g6Dedupe(c, content())).toHaveLength(1);
    expect(g6Dedupe({ ...c, purpose: 'venue-update', replaces_id: venue.id }, content())).toEqual([]);
  });
  it('normalizeUrl ignores www, fragments, utm params and trailing slash', () => {
    expect(normalizeUrl('https://www.Blog.lovevery.com/a/b/?utm_source=x#top')).toBe(normalizeUrl('https://blog.lovevery.com/a/b'));
  });
});

/* ---------------------------------------------------------------------------------------------- */

describe('G7 events', () => {
  it('passes a Singapore event with dates on the page and confirms them', () => {
    const c = outCandidate({ dates_confirmed: false });
    expect(g7Events(c, OUT_PAGE, TODAY, ['nlb.libcal.com'])).toEqual([]);
    expect((c.draft as OutingDraft).dates_confirmed).toBe(true);
  });
  it('activities pass', () => {
    expect(g7Events(actCandidate(), ACT_PAGE, TODAY)).toEqual([]);
  });
  it('fails a past end date', () => {
    const f = g7Events(outCandidate({ start_date: '2026-10-01', end_date: '2026-10-18' }), OUT_PAGE, TODAY, ['nlb.libcal.com']);
    expect(f).toEqual([{ gate: 'G7', fixable: false, reason: 'already ended (2026-10-18)' }]);
    // Ends today: still on.
    expect(g7Events(outCandidate({ start_date: '2026-10-19', end_date: null }), OUT_PAGE, TODAY, ['nlb.libcal.com'])).toEqual([]);
  });
  it('requires a Singapore location', () => {
    const page = { ...OUT_PAGE, url: 'https://example.com/e', finalUrl: 'https://example.com/e' };
    const abroad = outCandidate({ location: 'Kuala Lumpur', url: 'https://example.com/e' }, { page_url: 'https://example.com/e' });
    expect(g7Events(abroad, page, TODAY)[0].reason).toMatch(/not shown to be in Singapore/);
    // Mentioned on the page, a .sg host or a Singapore source host all count.
    expect(g7Events(abroad, { ...page, text: `${page.text} Singapore.` }, TODAY)).toEqual([]);
    expect(g7Events(outCandidate({ location: 'Woodlands' }), OUT_PAGE, TODAY, ['nlb.libcal.com'])).toEqual([]);
    expect(g7Events(outCandidate({ location: '' }), OUT_PAGE, TODAY, ['nlb.libcal.com'])[0].reason).toMatch(/no Singapore region/);
  });
  it('an event without dates is a fixable failure', () => {
    const f = g7Events(outCandidate({ start_date: null, end_date: null }), OUT_PAGE, TODAY, ['nlb.libcal.com']);
    expect(f).toEqual([{ gate: 'G7', fixable: true, reason: 'no dates found yet' }]);
  });
  it('dates not on the page: passes with dates_confirmed false', () => {
    const c = outCandidate({ start_date: '2026-11-20', end_date: '2026-11-21', dates_confirmed: true });
    expect(g7Events(c, OUT_PAGE, TODAY, ['nlb.libcal.com'])).toEqual([]);
    expect((c.draft as OutingDraft).dates_confirmed).toBe(false);
  });
  it.each([
    'Sat 13 Nov 2026 to Sun 14 Nov 2026',
    '13-14 November 2026',
    '13 \u2013 14 Nov',
    'Nov 13 - 14, 2026',
    '13th November and 14th November',
    '13/11/2026 - 14/11/2026',
    '2026-11-13 to 2026-11-14',
  ])('finds dates written as "%s"', (when) => {
    const c = outCandidate({ dates_confirmed: false });
    g7Events(c, { ...OUT_PAGE, text: `Early READ Fiesta. ${when}. Singapore.` }, TODAY);
    expect((c.draft as OutingDraft).dates_confirmed).toBe(true);
  });
  it('fails an age range outside 0-36 months', () => {
    expect(g7Events(outCandidate({ min_age_months: 48, max_age_months: 96 }), OUT_PAGE, TODAY, ['nlb.libcal.com'])[0].reason).toMatch(/age range 48-96/);
  });
  it('venues without dates pass', () => {
    const venue = outings.find((o) => o.id === 'sg-venue-jacob-ballas')!;
    expect(g7Events(outCandidate(strip(venue) as OutingDraft), { ...OUT_PAGE, text: 'A family-friendly garden for young children.' }, TODAY)).toEqual([]);
  });

  it('v0.4: a new outing whose page shows no under-3 suitability fails', () => {
    const venue = outings.find((o) => o.id === 'sg-venue-jacob-ballas')!;
    const f = g7Events(outCandidate(strip(venue) as OutingDraft), { ...OUT_PAGE, text: 'A garden.' }, TODAY);
    expect(f.map((x) => x.reason)).toContain("page doesn't show it suits under-3s");
  });

  it('v0.4: venue updates for existing venues are exempt from the suitability rule', () => {
    const venue = outings.find((o) => o.id === 'sg-venue-jacob-ballas')!;
    const c = { ...outCandidate(strip(venue) as OutingDraft), purpose: 'venue-update' as const };
    expect(g7Events(c, { ...OUT_PAGE, text: 'A garden.' }, TODAY)).toEqual([]);
  });

  it('v0.4: thrill events fail even with toddler wording on the page', () => {
    const venue = outings.find((o) => o.id === 'sg-venue-jacob-ballas')!;
    const c = outCandidate({ ...(strip(venue) as OutingDraft), name: 'TRICK or THRILLS' });
    const f = g7Events(c, { ...OUT_PAGE, text: 'Fun for toddlers and families.' }, TODAY);
    expect(f.map((x) => x.reason)).toContain('not for young children (thrill event)');
  });
});

/* ---------------------------------------------------------------------------------------------- */

describe('G8 quotas', () => {
  const mk = (i: number, over: Partial<Candidate> = {}, philosophy = ['lovevery']): Candidate =>
    actCandidate({ title: `Activity ${i}`, philosophy }, { source_id: `src-${i}`, ...over });

  it('11 activities -> 10; rejected one is fixable "quota"', () => {
    const r = g8Quotas(Array.from({ length: 11 }, (_, i) => mk(i)), DEFAULT_QUOTAS, { loveveryShare: 0.5 });
    expect(r.accepted).toHaveLength(10);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].candidate.source_id).toBe('src-10');
    expect(r.rejected[0].failures[0]).toMatchObject({ gate: 'G8', fixable: true });
    expect(r.rejected[0].failures[0].reason).toMatch(/^quota/);
  });
  it('6 from one source -> 5', () => {
    const r = g8Quotas(Array.from({ length: 6 }, (_, i) => mk(i, { source_id: 'lovevery-blog' })), DEFAULT_QUOTAS, { loveveryShare: 0 });
    expect(r.accepted).toHaveLength(5);
    expect(r.rejected[0].failures[0].reason).toMatch(/5 new activities from lovevery-blog/);
  });
  it('31 outings -> 30', () => {
    const r = g8Quotas(Array.from({ length: 31 }, (_, i) => outCandidate({ name: `Outing ${i}` })), DEFAULT_QUOTAS, { loveveryShare: 0 });
    expect(r.accepted).toHaveLength(30);
    expect(r.rejected).toHaveLength(1);
  });
  it('Montessori/Reggio first when the published mix is over 60% Lovevery', () => {
    const batch = [
      ...Array.from({ length: 9 }, (_, i) => mk(i)),
      mk(9, {}, ['montessori']),
      mk(10, {}, ['reggio_emilia']),
      mk(11, {}, ['lovevery', 'montessori']),
    ];
    const over = g8Quotas(batch, DEFAULT_QUOTAS, { loveveryShare: 0.65 });
    const accepted = over.accepted.map((c) => c.source_id);
    expect(accepted).toContain('src-9');
    expect(accepted).toContain('src-10');
    expect(over.rejected.map((o) => o.candidate.source_id)).toEqual(['src-8', 'src-11']);
    const under = g8Quotas(batch, DEFAULT_QUOTAS, { loveveryShare: 0.55 });
    expect(under.rejected.map((o) => o.candidate.source_id)).toEqual(['src-10', 'src-11']);
  });
  it('coverage-guard candidates first; venue updates do not count', () => {
    const batch = [...Array.from({ length: 10 }, (_, i) => mk(i)), mk(10, { purpose: 'coverage' })];
    expect(g8Quotas(batch, DEFAULT_QUOTAS, { loveveryShare: 0 }).rejected[0].candidate.source_id).toBe('src-9');
    const outs = [...Array.from({ length: 30 }, (_, i) => outCandidate({ name: `O${i}` })), outCandidate({}, { purpose: 'venue-update' })];
    expect(g8Quotas(outs, DEFAULT_QUOTAS, { loveveryShare: 0 }).accepted).toHaveLength(31);
  });
});

/* ---------------------------------------------------------------------------------------------- */

describe('G9 catalog', () => {
  it('passes the current dataset', () => {
    const r = g9Catalog({ activities, milestones, outings });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
  it('fails when retirements drop a month x category below 2 published activities', () => {
    const retired = activities.map((a) => (a.id === 'act-m06-gm-01' || a.id === 'act-m06-gm-02' ? { ...a, status: 'retired' } : a));
    const r = g9Catalog({ activities: retired, milestones, outings });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/coverage: month 6 gross_motor has 1 published/);
  });
});

/* ---------------------------------------------------------------------------------------------- */

describe('runCandidateGates', () => {
  it('passes a good activity, calls the reviewer once, does not mutate the input', async () => {
    const review = vi.fn(async () => GOOD);
    const c = actCandidate();
    const before = structuredClone(c);
    const r = await runCandidateGates(c, ctx(ACT_PAGE, { review }));
    expect(r.failures).toEqual([]);
    expect(review).toHaveBeenCalledTimes(1);
    expect(r.candidate.review).toEqual(GOOD);
    expect(c).toEqual(before);
  });
  it('passes a good outing and carries dates_confirmed on the outcome copy', async () => {
    const c = outCandidate({ start_date: '2026-11-20', end_date: null });
    const r = await runCandidateGates(c, ctx(OUT_PAGE));
    expect(r.failures).toEqual([]);
    expect((r.candidate.draft as OutingDraft).dates_confirmed).toBe(false);
    expect((c.draft as OutingDraft).dates_confirmed).toBe(true);
  });
  it('collects every deterministic failure and skips the AI review', async () => {
    const review = vi.fn(async () => GOOD);
    const c = actCandidate(
      { energy: 'wild' as ActivityDraft['energy'], how_to: 'Offer a bowl of whole grapes.' },
      { supporting_quote: 'this sentence is definitely not on the page at all' },
    );
    const r = await runCandidateGates(c, ctx(ACT_PAGE, { review }));
    expect(r.failures.map((f) => f.gate)).toEqual(['G1', 'G2', 'G4']);
    expect(review).not.toHaveBeenCalled();
  });
  it('a malformed draft becomes a failure, not a crash', async () => {
    const r = await runCandidateGates({ ...actCandidate(), draft: null as unknown as ActivityDraft }, ctx(ACT_PAGE));
    expect(r.failures.length).toBeGreaterThan(0);
    expect(r.failures.every((f) => !f.fixable)).toBe(true);
  });
});

describe('isRetryable and loveveryShare', () => {
  const outcome = (fixable: boolean[], attempts: number) => ({
    candidate: actCandidate({}, { attempts }),
    failures: fixable.map((f) => ({ gate: 'G7' as const, reason: 'x', fixable: f })),
  });
  it('retries only all-fixable failures with attempts left', () => {
    expect(isRetryable(outcome([true], 1))).toBe(true);
    expect(isRetryable(outcome([true, true], 3))).toBe(true);
    expect(isRetryable(outcome([true], 4))).toBe(false);
    expect(isRetryable(outcome([true, false], 1))).toBe(false);
    expect(isRetryable(outcome([], 1))).toBe(false);
  });
  it('loveveryShare counts published activities tagged lovevery', () => {
    expect(loveveryShare(activities)).toBeCloseTo((387 + 15) / 620, 5);
    expect(loveveryShare([])).toBe(0);
    const two = [activities.find((a) => a.philosophy.includes('lovevery'))!, { ...activities.find((a) => a.philosophy.includes('lovevery'))!, status: 'retired' }];
    expect(loveveryShare(two)).toBe(1);
  });
});
