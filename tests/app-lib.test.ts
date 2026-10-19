import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildIndex, stem } from '../src/lib/search';
import { filterOutings, isPast, isThisWeekend, weekendRange, dateLabel } from '../src/lib/outings';
import { activeFilterCount, DEFAULT_FILTERS, filterActivities, matchesFilters } from '../src/lib/filters';
import { addSave, addSwipe, addTried, emptyState, lastTried, normalizeState, removeSave, swipeCount, MAX_INTERACTIONS } from '../src/lib/state';
import { computePing, visitPing } from '../src/lib/analytics';
import type { Activity, MilestonesFile, Outing } from '../src/lib/types';

const root = join(__dirname, '..');
const activities: Activity[] = JSON.parse(readFileSync(join(root, 'data/activities.json'), 'utf8')).filter((a: Activity) => a.verified);
const msFile: MilestonesFile = JSON.parse(readFileSync(join(root, 'data/milestones.json'), 'utf8'));
const outings: Outing[] = JSON.parse(readFileSync(join(root, 'data/sg_outings.json'), 'utf8'));

describe('search', () => {
  const idx = buildIndex({ activities, milestones: msFile.milestones, outings });

  it('folds simple plurals', () => {
    expect(stem('balls')).toBe('ball');
    expect(stem('berries')).toBe('berry');
    expect(stem('boxes')).toBe('box');
    expect(stem('glass')).toBe('glass');
  });

  it('matches word starts ("crawl" finds "crawling"/"crawls")', () => {
    const r = idx.search('crawl', 9);
    const texts = [...r.milestones.map((m) => m.text), ...r.activities.map((a) => a.title + ' ' + a.summary)].join(' ').toLowerCase();
    expect(texts).toMatch(/crawl(ing|s)/);
  });

  it('plural query finds singular text', () => {
    const r = idx.search('balls', 16);
    expect(r.activities.length).toBeGreaterThan(0);
    expect(r.milestones.some((m) => /ball/i.test(m.text))).toBe(true);
  });

  it('ignores case and punctuation', () => {
    const a = idx.search('Peek-a-boo!', 9).activities.map((x) => x.id);
    const b = idx.search('PEEKABOO', 9).activities.map((x) => x.id);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
    expect(idx.search('walker', 12).activities.length).toBeGreaterThan(0);
  });

  it('ranks activities near the child age first', () => {
    const r = idx.search('ball', 16);
    const first = r.activities.slice(0, 3).map((a) => Math.abs(a.month - 16));
    const last = r.activities.slice(-3).map((a) => Math.abs(a.month - 16));
    expect(Math.max(...first)).toBeLessThanOrEqual(Math.min(...last));
  });

  it('groups outings (name, summary, location)', () => {
    const r = idx.search('library', 16);
    expect(r.outings.length).toBeGreaterThan(0);
    expect(idx.search('', 16)).toEqual({ milestones: [], activities: [], outings: [] });
  });
});

describe('outings', () => {
  const today = '2026-10-19'; // Monday
  it('computes the coming weekend', () => {
    expect(weekendRange(today)).toEqual(['2026-10-24', '2026-10-25']);
    expect(weekendRange('2026-10-24')).toEqual(['2026-10-24', '2026-10-25']);
    expect(weekendRange('2026-10-25')).toEqual(['2026-10-25', '2026-10-25']);
  });
  it('hides past events', () => {
    const past = { ...outings.find((o) => o.type === 'event')!, start_date: '2026-10-01', end_date: '2026-10-02' };
    expect(isPast(past, today)).toBe(true);
    const list = filterOutings([past, ...outings], { age: 16, today, weekend: false, rainOk: false, region: 'all', hidePaid: false });
    expect(list.find((o) => o === past)).toBeUndefined();
  });
  it('filters by weekend, rain, region, paid and age', () => {
    const base = { age: 16, today, weekend: false, rainOk: false, region: 'all' as const, hidePaid: false };
    const all = filterOutings(outings, base);
    expect(filterOutings(outings, { ...base, hidePaid: true }).every((o) => !o.paid)).toBe(true);
    expect(filterOutings(outings, { ...base, rainOk: true }).every((o) => o.rain_ok)).toBe(true);
    expect(filterOutings(outings, { ...base, region: 'west' }).every((o) => o.region === 'west')).toBe(true);
    expect(filterOutings(outings, { ...base, weekend: true }).every((o) => isThisWeekend(o, today))).toBe(true);
    expect(all.every((o) => o.min_age_months <= 16 && o.max_age_months >= 16)).toBe(true);
    expect(all.some((o) => o.paid)).toBe(true);
  });
  it('formats card dates', () => {
    const ev = outings.find((o) => o.id === 'sg-event-early-read-fiesta-punggol')!;
    expect(dateLabel(ev, today)).toBe('Sat 21 Nov');
    const train = outings.find((o) => o.id === 'sg-event-gbtb-christmas-train-show-2026')!;
    expect(dateLabel(train, today)).toBe('From 20 Nov');
  });
});

describe('filters', () => {
  const a = activities[0];
  it('counts active filters', () => {
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
    expect(activeFilterCount({ setting: 'indoor', energy: 'calm', duration: 'le5', hidePaid: true })).toBe(4);
  });
  it('indoor includes "either", hide paid removes paid items', () => {
    expect(matchesFilters({ ...a, setting: 'either' }, { ...DEFAULT_FILTERS, setting: 'indoor' })).toBe(true);
    expect(matchesFilters({ ...a, setting: 'outdoor' }, { ...DEFAULT_FILTERS, setting: 'indoor' })).toBe(false);
    expect(matchesFilters({ ...a, paid: true }, { ...DEFAULT_FILTERS, hidePaid: true })).toBe(false);
  });
  it('duration buckets', () => {
    const f = (d: 'le5' | 'le15' | 'ge15', min: number) => matchesFilters({ ...a, duration_min: min }, { ...DEFAULT_FILTERS, duration: d });
    expect(f('le5', 5)).toBe(true);
    expect(f('le5', 6)).toBe(false);
    expect(f('le15', 15)).toBe(true);
    expect(f('ge15', 15)).toBe(true);
    expect(f('ge15', 10)).toBe(false);
  });
  it('combines with category', () => {
    const r = filterActivities(activities, DEFAULT_FILTERS, 'language');
    expect(r.every((x) => x.category === 'language')).toBe(true);
  });
});

describe('device state', () => {
  const s0 = { ...emptyState('2026-10-19'), birth: '2025-06' };
  it('right-swipe writes swipe_like and save', () => {
    const s = addSwipe(s0, 'a1', 'like', 16, 1);
    expect(s.interactions.map((i) => i.type)).toEqual(['swipe_like', 'save']);
    expect(s.interactions[1].via).toBe('swipe');
    expect(s.favorites).toEqual(['a1']);
    expect(swipeCount(s)).toBe(1);
  });
  it('saves newest first and unsave removes', () => {
    let s = addSave(s0, 'a1', 16, 1);
    s = addSave(s, 'a2', 16, 2);
    expect(s.favorites).toEqual(['a2', 'a1']);
    s = removeSave(s, 'a2', 16, 3);
    expect(s.favorites).toEqual(['a1']);
    expect(s.interactions.at(-1)?.type).toBe('unsave');
  });
  it('records tried feedback', () => {
    const s = addTried(s0, 'a1', 'meh', 16, 1);
    expect(lastTried(s, 'a1')).toBe('meh');
  });
  it('caps interactions at 2000', () => {
    let s = s0;
    for (let i = 0; i < MAX_INTERACTIONS + 5; i++) s = addSwipe(s, `x${i}`, 'pass', 16, i);
    expect(s.interactions.length).toBe(MAX_INTERACTIONS);
  });
  it('normalizes partial records', () => {
    const s = normalizeState({ birth: '2025-06' }, '2026-10-19');
    expect(s.birth).toBe('2025-06');
    expect(s.filters).toEqual(DEFAULT_FILTERS);
    expect(s.favorites).toEqual([]);
  });
});

describe('visitPing', () => {
  it('computes day_first/month_first', () => {
    expect(computePing(null, '2026-10-19')).toEqual({ day_first: true, month_first: true });
    expect(computePing('2026-10-18', '2026-10-19')).toEqual({ day_first: true, month_first: false });
    expect(computePing('2026-09-30', '2026-10-01')).toEqual({ day_first: true, month_first: true });
    expect(computePing('2026-10-19', '2026-10-19')).toBeNull();
  });
  it('is disabled when the URL is unset', async () => {
    const f = vi.fn();
    expect(await visitPing({ url: undefined, lastPing: null, savePing: () => {}, fetchFn: f as unknown as typeof fetch })).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
  it('posts only the two flags when enabled', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true });
    const save = vi.fn();
    const sent = await visitPing({ url: 'https://example.test/v', lastPing: '2026-10-18', savePing: save, fetchFn: f as unknown as typeof fetch, now: new Date('2026-10-19T04:00:00Z') });
    expect(sent).toEqual({ day_first: true, month_first: false });
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ day_first: true, month_first: false });
    expect(save).toHaveBeenCalledWith('2026-10-19');
  });
});
