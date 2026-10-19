import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isNew } from '../src/lib/recommender';
import { publishedOutings, validateActivity, validateOuting } from '../scripts/catalog-lib';
import type { Activity, Outing } from '../src/lib/types';

const root = join(__dirname, '..');
const acts: Activity[] = JSON.parse(readFileSync(join(root, 'data/activities.json'), 'utf8'));
const outs: Outing[] = JSON.parse(readFileSync(join(root, 'data/sg_outings.json'), 'utf8'));
const DAY = 86_400_000;

describe('web app tolerates Phase 3 lifecycle fields', () => {
  it('seed content is never "New this week", pipeline content is for 7 days', () => {
    const now = Date.parse('2026-10-20T00:00:00Z');
    const seed = { ...acts[0], added_at: '2026-10-18', origin: 'seed' } as Activity;
    const fresh = { ...acts[0], added_at: '2026-10-18', origin: 'pipeline' } as Activity;
    expect(isNew(seed, now)).toBe(false);
    expect(isNew(fresh, now)).toBe(true);
    expect(isNew(fresh, now + 8 * DAY)).toBe(false);
  });

  it('record validators accept the new fields and the real data', () => {
    const ms = new Set<string>(JSON.parse(readFileSync(join(root, 'data/milestones.json'), 'utf8')).milestones.map((m: { id: string }) => m.id));
    expect(acts.flatMap((a) => validateActivity(a, ms).errors)).toEqual([]);
    expect(outs.flatMap((o) => validateOuting(o).errors)).toEqual([]);
  });

  it('retired outings are not shipped; records without status still are', () => {
    const { status: _s, ...noStatus } = outs[1];
    const list = [{ ...outs[0], status: 'retired' }, noStatus as Outing, outs[2]];
    expect(publishedOutings(list).map((o) => o.id)).toEqual([outs[1].id, outs[2].id]);
  });
});
