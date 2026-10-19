import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate, buildCatalog, checkpointFor, publishedActivities, type RawData } from '../scripts/catalog-lib';
import type { ByMonthFile } from '../src/lib/types';

const root = join(__dirname, '..');
const load = (): RawData => ({
  activities: JSON.parse(readFileSync(join(root, 'data/activities.json'), 'utf8')),
  milestones: JSON.parse(readFileSync(join(root, 'data/milestones.json'), 'utf8')),
  outings: JSON.parse(readFileSync(join(root, 'data/sg_outings.json'), 'utf8')),
});

describe('catalog validation', () => {
  it('real data has no errors', () => {
    const { errors } = validate(load());
    expect(errors).toEqual([]);
  });

  it('flags duplicate ids, bad enums, unresolved milestone refs', () => {
    const d = load();
    const a = { ...d.activities[0] };
    d.activities.push(a); // duplicate
    d.activities.push({ ...a, id: 'act-x', energy: 'wild' as never, milestone_ids: ['nope-01-1'] });
    const { errors } = validate(d);
    expect(errors.some((e) => e.includes('duplicate id act-m00-gm-01'))).toBe(true);
    expect(errors.some((e) => e.includes('act-x: bad energy'))).toBe(true);
    expect(errors.some((e) => e.includes('nope-01-1 does not resolve'))).toBe(true);
  });

  it('flags month x category cells with fewer than 2 activities', () => {
    const d = load();
    d.activities = d.activities.filter((a) => !(a.month === 3 && a.category === 'cognitive'));
    const { errors } = validate(d);
    expect(errors).toContain('coverage: month 3 cognitive has 0 activities (need >= 2)');
  });

  it('strict mode turns published coverage gaps into errors', () => {
    // Fixture: leave month 7 language with exactly 2 activities, then mark one unverified,
    // so the source passes but the published set has a gap.
    const d = load();
    const m7lang = d.activities.filter((a) => a.month === 7 && a.category === 'language');
    d.activities = d.activities.filter((a) => !(a.month === 7 && a.category === 'language')).concat(
      m7lang.slice(0, 2).map((a, i) => (i === 0 ? { ...a, verified: false } : a)),
    );
    const lenient = validate(d);
    expect(lenient.errors.some((e) => e.startsWith('coverage: month 7 language'))).toBe(false);
    expect(lenient.warnings.some((w) => w.includes('dropped'))).toBe(true);
    const { errors } = validate(d, { strictPublishedCoverage: true });
    expect(errors.some((e) => e.startsWith('coverage: month 7 language'))).toBe(true);
  });

  it('real data passes strict published coverage', () => {
    expect(validate(load(), { strictPublishedCoverage: true }).errors).toEqual([]);
  });
});

describe('catalog build', () => {
  const built = buildCatalog(load(), 3, '2026-10-18T00:00:00Z');

  it('drops unverified activities', () => {
    const acts = built.files['activities.json'] as { verified: boolean }[];
    expect(acts.length).toBe(publishedActivities(load().activities).length);
    expect(acts.every((a) => a.verified)).toBe(true);
  });

  it('drops an activity marked unverified', () => {
    const d = load();
    const target = d.activities[0].id;
    d.activities = d.activities.map((a) => (a.id === target ? { ...a, verified: false } : a));
    const acts = buildCatalog(d, 3, '2026-10-18T00:00:00Z').files['activities.json'] as { id: string }[];
    expect(acts.length).toBe(d.activities.length - 1);
    expect(acts.some((a) => a.id === target)).toBe(false);
  });

  it('writes 37 by-month files with current and next checkpoint milestones', () => {
    const months = Object.keys(built.files).filter((k) => k.startsWith('by_month/'));
    expect(months.length).toBe(37);
    const m7 = built.files['by_month/07.json'] as ByMonthFile;
    expect(m7.checkpoint).toBe(9);
    expect(m7.next_checkpoint).toBe(12);
    expect(new Set(m7.milestones.map((m) => m.month))).toEqual(new Set([9, 12]));
    expect(m7.activities.every((a) => a.month === 7)).toBe(true);
    const m36 = built.files['by_month/36.json'] as ByMonthFile;
    expect(m36.checkpoint).toBe(36);
    expect(m36.next_checkpoint).toBeNull();
  });

  it('builds the milestone reverse index', () => {
    const idx = built.files['milestone_to_activities.json'] as Record<string, string[]>;
    expect(Object.keys(idx).length).toBe(126);
    expect(idx['gm-02-1']).toContain('act-m00-gm-01');
  });

  it('writes latest.json pointer', () => {
    expect(built.latest).toEqual({ version: 3, published_at: '2026-10-18T00:00:00Z', path: 'catalog/v3/' });
  });

  it('checkpointFor picks current or next checkpoint', () => {
    const cps = [2, 4, 6, 9, 12, 15, 18, 24, 30, 36];
    expect(checkpointFor(0, cps)).toBe(2);
    expect(checkpointFor(9, cps)).toBe(9);
    expect(checkpointFor(16, cps)).toBe(18);
    expect(checkpointFor(36, cps)).toBe(36);
  });
});
