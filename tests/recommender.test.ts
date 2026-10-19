import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CATEGORIES,
  activityTags,
  ageFit,
  buildContext,
  candidates,
  computeTagAffinity,
  dedupe,
  milestonePriority,
  nextDeck,
  reasonFor,
  recommend,
  rerank,
  score,
  scoreAll,
  seedDeck,
  titleStem,
} from '../src/lib/recommender';
import type {
  Activity,
  Category,
  Interaction,
  InteractionType,
  Milestone,
  RecInput,
  ScoreContext,
  ScoredActivity,
} from '../src/lib/recommender';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const CHECKPOINTS = [2, 4, 6, 9, 12, 15, 18, 24, 30, 36];

let seq = 0;
function mk(o: Partial<Activity> = {}): Activity {
  seq += 1;
  return {
    id: `a${String(seq).padStart(4, '0')}`,
    title: `Activity number ${seq}`,
    month: 7,
    category: 'gross_motor',
    philosophy: ['lovevery'],
    milestone_ids: [],
    summary: 's',
    how_to: 'h',
    materials: [],
    setting: 'indoor',
    energy: 'calm',
    senses: ['touch'],
    play_type: ['sensory'],
    duration_min: 5,
    parent_role: 'lead',
    source_name: 'Src',
    source_url: `https://example.com/${seq}`,
    verified: true,
    paid: false,
    ...o,
  };
}

const MILESTONES: Milestone[] = [
  { id: 'gm-06-1', category: 'gross_motor', month: 6, text: 'Rolls from tummy to back' },
  { id: 'gm-09-1', category: 'gross_motor', month: 9, text: 'Sits without support' },
  { id: 'fm-09-1', category: 'fine_motor', month: 9, text: 'Passes toy hand to hand' },
  { id: 'lang-09-1', category: 'language', month: 9, text: 'Babbles mamama' },
  { id: 'se-09-1', category: 'social_emotional', month: 9, text: 'Shy with strangers' },
  { id: 'cog-09-1', category: 'cognitive', month: 9, text: 'Looks for dropped things' },
  { id: 'gm-12-1', category: 'gross_motor', month: 12, text: 'Pulls to stand' },
  { id: 'gm-15-1', category: 'gross_motor', month: 15, text: 'Takes a few steps' },
];

function input(o: Partial<RecInput> = {}): RecInput {
  return {
    activities: [],
    milestones: MILESTONES,
    checkpoints: CHECKPOINTS,
    ageMonths: 7,
    interactions: [],
    favorites: [],
    milestonesSeen: [],
    hidePaid: false,
    now: NOW,
    ...o,
  };
}

function ix(type: InteractionType, itemId: string, daysAgo = 0, via?: 'swipe' | 'browse'): Interaction {
  const i: Interaction = { type, itemId, ageMonths: 7, ts: NOW - daysAgo * DAY };
  if (via) i.via = via;
  return i;
}

function byId(list: Activity[]): Map<string, Activity> {
  return new Map(list.map((a) => [a.id, a]));
}

/** Rich synthetic catalog: for each category and month 5..8, 3 varied items. */
function catalog(): Activity[] {
  const energies: Activity['energy'][] = ['calm', 'moderate', 'active'];
  const settings: Activity['setting'][] = ['indoor', 'outdoor', 'either'];
  const plays = ['sensory', 'movement', 'music', 'reading', 'social', 'construction'];
  const msByCat: Record<Category, string[]> = {
    gross_motor: ['gm-09-1'],
    fine_motor: ['fm-09-1'],
    language: ['lang-09-1'],
    social_emotional: ['se-09-1'],
    cognitive: ['cog-09-1'],
    other: [],
  };
  const out: Activity[] = [];
  CATEGORIES.forEach((cat, ci) => {
    for (let m = 5; m <= 8; m++) {
      for (let k = 0; k < 3; k++) {
        out.push(
          mk({
            title: `${cat} v${k} m${m} play`,
            category: cat,
            month: m,
            energy: energies[(ci + k) % 3],
            setting: settings[(ci + m + k) % 3],
            play_type: [plays[(ci + k) % plays.length]],
            senses: [k % 2 === 0 ? 'touch' : 'sight'],
            parent_role: k === 0 ? 'lead' : 'alongside',
            milestone_ids: k === 0 ? msByCat[cat] : [],
          }),
        );
      }
    }
  });
  return out;
}

describe('activityTags', () => {
  it('builds namespaced tags', () => {
    const a = mk({ play_type: ['sensory', 'practical_life'], senses: ['touch'], energy: 'active', setting: 'outdoor', parent_role: 'observe' });
    expect(activityTags(a)).toEqual([
      'play_type:sensory',
      'play_type:practical_life',
      'senses:touch',
      'energy:active',
      'setting:outdoor',
      'parent_role:observe',
    ]);
  });
});

describe('candidates', () => {
  it('keeps month in [age-2, age+1]', () => {
    const acts = [3, 4, 5, 6, 7, 8, 9].map((m) => mk({ month: m }));
    expect(candidates(input({ activities: acts })).map((a) => a.month)).toEqual([5, 6, 7, 8]);
  });

  it('clamps the window to 0..36', () => {
    const acts = [0, 1, 2, 33, 34, 35, 36].map((m) => mk({ month: m }));
    expect(candidates(input({ activities: acts, ageMonths: 0 })).map((a) => a.month)).toEqual([0, 1]);
    expect(candidates(input({ activities: acts, ageMonths: 36 })).map((a) => a.month)).toEqual([34, 35, 36]);
  });

  it('excludes swiped, saved, tried, unverified, retired and (when hidePaid) paid items', () => {
    const keep = mk();
    const liked = mk();
    const passed = mk();
    const saved = mk();
    const enjoyed = mk();
    const meh = mk();
    const unverified = mk({ verified: false });
    const retired = mk({ status: 'retired' });
    const published = mk({ status: 'published' });
    const paid = mk({ paid: true });
    const acts = [keep, liked, passed, saved, enjoyed, meh, unverified, retired, published, paid];
    const base = input({
      activities: acts,
      favorites: [saved.id],
      interactions: [
        ix('swipe_like', liked.id, 1),
        ix('save', liked.id, 1, 'swipe'),
        ix('swipe_pass', passed.id, 100),
        ix('tried_enjoyed', enjoyed.id, 60),
        ix('tried_meh', meh.id, 60),
      ],
    });
    expect(candidates(base).map((a) => a.id)).toEqual([keep.id, published.id, paid.id]);
    expect(candidates({ ...base, hidePaid: true }).map((a) => a.id)).toEqual([keep.id, published.id]);
  });

  it('returns not-ready items after 28 days but not before', () => {
    const a = mk();
    const b = mk();
    const at = (days: number): RecInput =>
      input({ activities: [a, b], interactions: [ix('swipe_not_ready', a.id, days), ix('tried_not_ready', b.id, days)] });
    expect(candidates(at(27)).map((x) => x.id)).toEqual([]);
    expect(candidates(at(27.9)).map((x) => x.id)).toEqual([]);
    expect(candidates(at(28)).map((x) => x.id)).toEqual([a.id, b.id]);
  });

  it('only the latest interaction counts for the not-ready exception', () => {
    const a = mk();
    const b = mk();
    const inp = input({
      activities: [a, b],
      interactions: [
        ix('swipe_not_ready', a.id, 60),
        ix('swipe_pass', a.id, 40), // passed after not-ready -> stays excluded
        ix('swipe_pass', b.id, 60),
        ix('swipe_not_ready', b.id, 30), // latest is not-ready, 30 days old -> back
      ],
    });
    expect(candidates(inp).map((x) => x.id)).toEqual([b.id]);
  });
});

describe('computeTagAffinity', () => {
  const a = mk({ play_type: ['sensory'], senses: ['touch'], energy: 'calm', setting: 'indoor', parent_role: 'lead' });
  const map = byId([a]);
  const aff = (ints: Interaction[]): number => computeTagAffinity(ints, map, NOW)['play_type:sensory'] ?? 0;

  it('applies each interaction weight to every tag', () => {
    const r = computeTagAffinity([ix('swipe_like', a.id)], map, NOW);
    for (const t of activityTags(a)) expect(r[t]).toBeCloseTo(1.0);
  });

  it.each<[InteractionType, number]>([
    ['swipe_like', 1.0],
    ['swipe_pass', -0.5],
    ['tried_enjoyed', 2.0],
    ['tried_meh', -0.5],
    ['swipe_not_ready', 0],
    ['tried_not_ready', 0],
  ])('%s weighs %d', (type, w) => {
    expect(aff([ix(type, a.id)])).toBeCloseTo(w);
  });

  it('right-swipe (swipe_like + save via swipe) counts once: +1.0', () => {
    expect(aff([ix('swipe_like', a.id), ix('save', a.id, 0, 'swipe')])).toBeCloseTo(1.0);
  });

  it('browse save (via browse or undefined) is +1.5', () => {
    expect(aff([ix('save', a.id, 0, 'browse')])).toBeCloseTo(1.5);
    expect(aff([ix('save', a.id)])).toBeCloseTo(1.5);
  });

  it('unsave reverses a browse save', () => {
    expect(aff([ix('save', a.id, 2, 'browse'), ix('unsave', a.id, 1)])).toBeCloseTo(0);
  });

  it('unsave reverses a swipe save (cancels the swipe_like +1.0)', () => {
    expect(aff([ix('swipe_like', a.id, 2), ix('save', a.id, 2, 'swipe'), ix('unsave', a.id, 1)])).toBeCloseTo(0);
  });

  it('unsave cancels only the most recent save', () => {
    const ints = [
      ix('save', a.id, 10, 'browse'),
      ix('unsave', a.id, 9),
      ix('swipe_like', a.id, 5),
      ix('save', a.id, 5, 'swipe'),
      ix('unsave', a.id, 1),
      ix('save', a.id, 0, 'browse'),
    ];
    expect(aff(ints)).toBeCloseTo(1.5);
  });

  it('ignores unsave with no prior save and does not cancel tried weights', () => {
    expect(aff([ix('tried_enjoyed', a.id), ix('unsave', a.id)])).toBeCloseTo(2.0);
  });

  it('decays with a 30-day half-life', () => {
    expect(aff([ix('swipe_like', a.id, 30)])).toBeCloseTo(0.5);
    expect(aff([ix('swipe_like', a.id, 60)])).toBeCloseTo(0.25);
    expect(aff([ix('tried_enjoyed', a.id, 15)])).toBeCloseTo(2 * Math.pow(0.5, 0.5));
  });

  it('sums across items', () => {
    const b = mk({ play_type: ['sensory'], energy: 'active' });
    const r = computeTagAffinity([ix('swipe_like', a.id), ix('swipe_pass', b.id)], byId([a, b]), NOW);
    expect(r['play_type:sensory']).toBeCloseTo(0.5);
    expect(r['energy:calm']).toBeCloseTo(1.0);
    expect(r['energy:active']).toBeCloseTo(-0.5);
  });
});

describe('scoring', () => {
  it('ageFit peaks at the age and falls 0.25 per month', () => {
    expect(ageFit(7, 7)).toBe(1);
    expect(ageFit(6, 7)).toBe(0.75);
    expect(ageFit(8, 7)).toBe(0.75);
    expect(ageFit(5, 7)).toBe(0.5);
    expect(ageFit(1, 7)).toBe(0);
  });

  it('milestonePriority: current-or-next checkpoint = 1, later halves, seen/past/none = 0', () => {
    const ctx = buildContext(input({ ageMonths: 7, milestonesSeen: ['fm-09-1'] }));
    expect(milestonePriority(mk({ milestone_ids: ['gm-09-1'] }), ctx)).toBe(1);
    expect(milestonePriority(mk({ milestone_ids: ['gm-12-1'] }), ctx)).toBe(0.5);
    expect(milestonePriority(mk({ milestone_ids: ['gm-15-1'] }), ctx)).toBe(0.25);
    expect(milestonePriority(mk({ milestone_ids: ['gm-12-1', 'gm-09-1'] }), ctx)).toBe(1);
    expect(milestonePriority(mk({ milestone_ids: ['gm-06-1'] }), ctx)).toBe(0);
    expect(milestonePriority(mk({ milestone_ids: ['fm-09-1'] }), ctx)).toBe(0);
    expect(milestonePriority(mk({ milestone_ids: [] }), ctx)).toBe(0);
    expect(milestonePriority(mk({ milestone_ids: ['unknown'] }), ctx)).toBe(0);
  });

  it('milestonePriority: age on a checkpoint targets that checkpoint', () => {
    const ctx = buildContext(input({ ageMonths: 6 }));
    expect(milestonePriority(mk({ milestone_ids: ['gm-06-1'] }), ctx)).toBe(1);
    expect(milestonePriority(mk({ milestone_ids: ['gm-09-1'] }), ctx)).toBe(0.5);
  });

  it('score = 0.60*tanh(mean tag weight) + 0.25*milestonePriority + 0.15*ageFit', () => {
    const a = mk({ month: 6, milestone_ids: ['gm-12-1'], play_type: ['sensory'], senses: ['touch'] });
    const ctx: ScoreContext = {
      ...buildContext(input({ ageMonths: 7 })),
      affinity: { 'play_type:sensory': 2, 'senses:touch': 1, 'energy:calm': -0.5 },
    };
    const r = score(a, ctx);
    const tagMean = (2 + 1 - 0.5 + 0 + 0) / 5;
    expect(r.tagAffinity).toBeCloseTo(Math.tanh(tagMean));
    expect(r.milestonePriority).toBe(0.5);
    expect(r.ageFit).toBe(0.75);
    expect(r.score).toBeCloseTo(0.6 * Math.tanh(tagMean) + 0.25 * 0.5 + 0.15 * 0.75);
  });

  it('isolates each weight', () => {
    const ctx0 = buildContext(input({ ageMonths: 7 }));
    expect(score(mk({ month: 7 }), ctx0).score).toBeCloseTo(0.15);
    expect(score(mk({ month: 3, milestone_ids: ['gm-09-1'] }), ctx0).score).toBeCloseTo(0.25);
    const ctx1: ScoreContext = { ...ctx0, affinity: { 'play_type:sensory': 1000, 'senses:touch': 1000, 'energy:calm': 1000, 'setting:indoor': 1000, 'parent_role:lead': 1000 } };
    expect(score(mk({ month: 3 }), ctx1).score).toBeCloseTo(0.6);
  });

  it('tag affinity is bounded to [-1, 1]', () => {
    const ctx: ScoreContext = { ...buildContext(input()), affinity: { 'play_type:sensory': -1e6 } };
    const r = score(mk(), ctx);
    expect(r.tagAffinity).toBeGreaterThanOrEqual(-1);
    expect(r.tagAffinity).toBeLessThan(-0.99);
  });
});

function scored(a: Activity, s: number, mp = 0): ScoredActivity {
  return { activity: a, score: s, tagAffinity: 0, milestonePriority: mp, ageFit: 1 };
}

describe('rerank', () => {
  it('dedupes by title stem and source URL, keeping the higher score', () => {
    const a = mk({ title: 'Tummy time on your chest' });
    const b = mk({ title: 'Tummy time, on chest!' });
    const c = mk({ source_url: 'https://site.com/page' });
    const d = mk({ source_url: 'https://www.site.com/page/' });
    const e = mk();
    expect(titleStem('The Tummy-Time on your chest, please')).toBe('tummytime chest please');
    expect(titleStem(a.title)).toBe(titleStem('Tummy time... on CHEST'));
    const out = dedupe([scored(a, 0.2), scored(b, 0.5), scored(c, 0.9), scored(d, 0.1), scored(e, 0.3)]);
    expect(out.map((s) => s.activity.id)).toEqual([c.id, b.id, e.id]);
  });

  it('enforces >=4 categories, <=4 per category and 2 exploration slots from least-rated categories', () => {
    const pool: ScoredActivity[] = [];
    // gross motor dominates the scores
    for (let i = 0; i < 10; i++) pool.push(scored(mk({ category: 'gross_motor' }), 0.9 - i * 0.01));
    for (let i = 0; i < 5; i++) pool.push(scored(mk({ category: 'fine_motor' }), 0.5 - i * 0.01));
    for (let i = 0; i < 3; i++) pool.push(scored(mk({ category: 'language' }), 0.3 - i * 0.01, i === 2 ? 1 : 0));
    for (let i = 0; i < 3; i++) pool.push(scored(mk({ category: 'social_emotional' }), 0.2 - i * 0.01, i === 1 ? 0.5 : 0));
    for (let i = 0; i < 3; i++) pool.push(scored(mk({ category: 'cognitive' }), 0.25 - i * 0.01, 1));
    for (let i = 0; i < 3; i++) pool.push(scored(mk({ category: 'other' }), 0.1 - i * 0.01));
    const acts = pool.map((s) => s.activity);
    const gm = acts.filter((a) => a.category === 'gross_motor');
    const fm = acts.filter((a) => a.category === 'fine_motor');
    const co = acts.filter((a) => a.category === 'cognitive');
    // rating counts: gross 3, fine 2, cognitive 1, language 0, social 0, other 0
    const interactions = [
      ix('swipe_like', gm[0].id), ix('swipe_pass', gm[1].id), ix('tried_meh', gm[2].id),
      ix('save', fm[0].id, 0, 'browse'), ix('tried_enjoyed', fm[1].id),
      ix('swipe_like', co[0].id), ix('save', co[0].id, 0, 'swipe'), ix('swipe_not_ready', co[1].id),
    ];
    const inp = input({ activities: acts, interactions });
    const out = rerank(pool, inp, 10);
    expect(out).toHaveLength(10);
    const counts = new Map<Category, number>();
    out.forEach((r) => counts.set(r.activity.category, (counts.get(r.activity.category) ?? 0) + 1));
    expect(counts.size).toBeGreaterThanOrEqual(4);
    for (const c of counts.values()) expect(c).toBeLessThanOrEqual(4);
    const explore = out.filter((r) => r.explore);
    expect(explore).toHaveLength(2);
    // least-rated (0): language, social_emotional, other -> first two with milestone-linked items
    expect(explore.map((r) => r.activity.category)).toEqual(['language', 'social_emotional']);
    expect(explore.every((r) => r.milestonePriority > 0)).toBe(true);
    // highest milestone priority in that category
    expect(explore[0].milestonePriority).toBe(1);
    // exploration slots sit at positions 5 and 10
    expect(out[4].explore && out[9].explore).toBe(true);
  });

  it('adds missing categories when scores concentrate in few categories', () => {
    const pool: ScoredActivity[] = [];
    for (const cat of ['gross_motor', 'fine_motor'] as Category[]) {
      for (let i = 0; i < 8; i++) pool.push(scored(mk({ category: cat }), 0.9 - i * 0.01));
    }
    pool.push(scored(mk({ category: 'language' }), 0.01));
    pool.push(scored(mk({ category: 'other' }), 0.02));
    pool.push(scored(mk({ category: 'cognitive' }), 0.03));
    const out = rerank(pool, input({ activities: pool.map((s) => s.activity) }), 10);
    const cats = new Set(out.map((r) => r.activity.category));
    expect(out).toHaveLength(10);
    expect(cats.size).toBeGreaterThanOrEqual(4);
    expect(out.filter((r) => r.activity.category === 'gross_motor').length).toBeLessThanOrEqual(4);
  });

  it('is deterministic', () => {
    const acts = catalog();
    const inp = input({ activities: acts, interactions: [ix('swipe_like', acts[0].id)] });
    const ctx = buildContext(inp);
    const s = scoreAll(candidates(inp), ctx);
    const ids1 = rerank(s, inp).map((r) => r.activity.id);
    const ids2 = rerank([...s].reverse(), inp).map((r) => r.activity.id);
    expect(ids1).toEqual(ids2);
  });
});

describe('seedDeck / nextDeck', () => {
  it('seed deck has 8 cards covering all 6 categories with mixed energy/setting, preferring month === age', () => {
    const acts = catalog();
    const deck = seedDeck(input({ activities: acts }));
    expect(deck).toHaveLength(8);
    expect(new Set(deck.map((a) => a.category)).size).toBe(6);
    expect(new Set(deck.map((a) => a.energy)).size).toBe(3);
    expect(new Set(deck.map((a) => a.setting)).size).toBe(3);
    expect(new Set(deck.flatMap((a) => a.play_type)).size).toBeGreaterThanOrEqual(3);
    expect(deck.every((a) => a.month === 7)).toBe(true);
    expect(new Set(deck.map((a) => a.id)).size).toBe(8);
    expect(seedDeck(input({ activities: acts })).map((a) => a.id)).toEqual(deck.map((a) => a.id));
  });

  it('nextDeck falls back to the seed deck without history and re-ranks with history', () => {
    const acts = catalog();
    const fresh = input({ activities: acts });
    expect(nextDeck(fresh).map((a) => a.id)).toEqual(seedDeck(fresh).map((a) => a.id));
    const liked = acts.find((a) => a.category === 'language' && a.month === 7) as Activity;
    const withHistory = input({ activities: acts, interactions: [ix('swipe_like', liked.id), ix('save', liked.id, 0, 'swipe')], favorites: [liked.id] });
    const deck = nextDeck(withHistory);
    expect(deck).toHaveLength(8);
    expect(deck.map((a) => a.id)).not.toContain(liked.id);
  });
});

describe('reasons', () => {
  const SAVED_RE = /^Because you saved .+ \([^,()]+(, [^,()]+)?\)$/;
  const MILESTONE_RE = /^Builds toward .+ \(by \d+ months\)$/;
  const EXPLORE_RE = /^Something new: a (gross motor|fine motor|language|social-emotional|cognitive|everyday-life) activity$/;

  it('explore slot -> "Something new"', () => {
    const a = mk({ category: 'other' });
    const inp = input({ activities: [a] });
    const r = reasonFor({ ...scored(a, 0.1, 1), explore: true }, inp, buildContext(inp));
    expect(r).toEqual({ reason: 'Something new: a everyday-life activity', kind: 'explore' });
    expect(r.reason).toMatch(EXPLORE_RE);
  });

  it('saved overlap -> "Because you saved" with two human-readable tag values', () => {
    const saved = mk({ title: 'Treasure basket', play_type: ['practical_life'], senses: ['touch'], energy: 'calm', setting: 'outdoor', parent_role: 'observe' });
    const pick = mk({ play_type: ['practical_life'], senses: ['sight'], energy: 'calm', setting: 'indoor', parent_role: 'lead', milestone_ids: ['gm-09-1'] });
    const inp = input({ activities: [saved, pick], favorites: [saved.id], interactions: [ix('tried_enjoyed', saved.id, 1)] });
    const ctx = buildContext(inp);
    const r = reasonFor({ ...scored(pick, 0.5, 1), explore: false }, inp, ctx);
    expect(r.kind).toBe('saved');
    expect(r.reason).toBe('Because you saved Treasure basket (practical life, calm)');
    expect(r.reason).toMatch(SAVED_RE);
  });

  it('picks the liked item sharing the most tags', () => {
    const s1 = mk({ title: 'One', energy: 'active', setting: 'outdoor', parent_role: 'observe', play_type: ['music'], senses: ['sound'] });
    const s2 = mk({ title: 'Two', energy: 'calm', setting: 'indoor', parent_role: 'observe', play_type: ['music'], senses: ['sound'] });
    const pick = mk({ energy: 'calm', setting: 'indoor', parent_role: 'lead', play_type: ['art'], senses: ['sight'] });
    const inp = input({ activities: [s1, s2, pick], interactions: [ix('swipe_like', s1.id), ix('swipe_like', s2.id, 3)] });
    const r = reasonFor({ ...scored(pick, 0.5), explore: false }, inp, buildContext(inp));
    expect(r.reason).toBe('Because you saved Two (calm, indoor)');
  });

  it('milestone -> "Builds toward"', () => {
    const pick = mk({ milestone_ids: ['fm-09-1'] });
    const inp = input({ activities: [pick] });
    const ctx = buildContext(inp);
    const r = reasonFor({ ...scored(pick, 0.5, milestonePriority(pick, ctx)), explore: false }, inp, ctx);
    expect(r).toEqual({ reason: 'Builds toward Passes toy hand to hand (by 9 months)', kind: 'milestone' });
    expect(r.reason).toMatch(MILESTONE_RE);
  });

  it('added within 7 days -> "New this week"; otherwise "Right for N months"', () => {
    const fresh = mk({ added_at: new Date(NOW - 3 * DAY).toISOString() });
    const old = mk({ added_at: new Date(NOW - 10 * DAY).toISOString() });
    const inp = input({ activities: [fresh, old] });
    const ctx = buildContext(inp);
    expect(reasonFor({ ...scored(fresh, 0.1), explore: false }, inp, ctx)).toEqual({ reason: 'New this week', kind: 'new' });
    expect(reasonFor({ ...scored(old, 0.1), explore: false }, inp, ctx)).toEqual({ reason: 'Right for 7 months', kind: 'age' });
  });

  it('recommend attaches reasons that follow the templates', () => {
    const acts = catalog();
    const inp = input({ activities: acts, interactions: [ix('swipe_like', acts[0].id), ix('save', acts[0].id, 0, 'swipe')], favorites: [acts[0].id] });
    const picks = recommend(inp);
    expect(picks).toHaveLength(10);
    for (const p of picks) {
      expect(p.reason).toMatch(new RegExp(`${SAVED_RE.source}|${MILESTONE_RE.source}|${EXPLORE_RE.source}|^New this week$|^Right for 7 months$`));
    }
    expect(picks.filter((p) => p.kind === 'explore')).toHaveLength(2);
  });
});

describe('real catalog smoke test', () => {
  const root = process.cwd();
  const activities = JSON.parse(readFileSync(resolve(root, 'data/activities.json'), 'utf8')) as Activity[];
  const ms = JSON.parse(readFileSync(resolve(root, 'data/milestones.json'), 'utf8')) as {
    milestones: Milestone[];
    checkpoints_months: number[];
  };

  it('loads the data', () => {
    expect(activities.length).toBe(620);
    expect(ms.checkpoints_months).toEqual(CHECKPOINTS);
  });

  it.each([0, 7, 16, 36])('age %i: 10 picks, >=4 categories, <=4 per category', (age) => {
    const base: RecInput = {
      activities,
      milestones: ms.milestones,
      checkpoints: ms.checkpoints_months,
      ageMonths: age,
      interactions: [],
      favorites: [],
      milestonesSeen: [],
      hidePaid: true,
      now: NOW,
    };
    const seed = seedDeck(base);
    expect(seed).toHaveLength(8);
    expect(new Set(seed.map((a) => a.category)).size).toBe(6);

    // like the first 3 seed cards, pass the rest
    const interactions: Interaction[] = seed.flatMap((a, i) =>
      i < 3
        ? [ix('swipe_like', a.id, 8 - i), ix('save', a.id, 8 - i, 'swipe')]
        : [ix('swipe_pass', a.id, 8 - i)],
    );
    for (const inp of [base, { ...base, interactions, favorites: seed.slice(0, 3).map((a) => a.id) }]) {
      const picks = recommend(inp);
      expect(picks).toHaveLength(10);
      const counts = new Map<Category, number>();
      picks.forEach((p) => counts.set(p.activity.category, (counts.get(p.activity.category) ?? 0) + 1));
      expect(counts.size).toBeGreaterThanOrEqual(4);
      for (const c of counts.values()) expect(c).toBeLessThanOrEqual(4);
      expect(picks.every((p) => p.reason.length > 0 && !p.activity.paid)).toBe(true);
      expect(new Set(picks.map((p) => p.activity.id)).size).toBe(10);
      expect(new Set(picks.map((p) => p.activity.source_url)).size).toBe(10);
      if (inp.interactions.length > 0) {
        const seen = new Set(seed.map((a) => a.id));
        expect(picks.some((p) => seen.has(p.activity.id))).toBe(false);
      }
    }
  });
});
