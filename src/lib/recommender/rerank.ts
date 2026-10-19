import type { ScoredActivity } from './score';
import { CATEGORIES } from './types';
import type { Activity, Category, RecInput } from './types';

export interface RankedItem extends ScoredActivity {
  /** True when the item fills an exploration slot. */
  explore: boolean;
}

export const MAX_PER_CATEGORY = 4;
export const MIN_CATEGORIES = 4;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'with', 'to', 'in', 'on', 'at', 'by', 'from',
  'your', 'you', 'my', 'our', 'their', 'its', 'is', 'up',
]);

/** Title stem: lowercase, strip punctuation, drop stopwords, keep the first 3 remaining words. */
export function titleStem(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const significant = words.filter((w) => !STOPWORDS.has(w));
  return (significant.length > 0 ? significant : words).slice(0, 3).join(' ');
}

function normaliseUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

/** Score desc, then id asc (deterministic). */
export function compareScored(x: ScoredActivity, y: ScoredActivity): number {
  return y.score - x.score || (x.activity.id < y.activity.id ? -1 : x.activity.id > y.activity.id ? 1 : 0);
}

/** Remove near-duplicates (same title stem or same source URL), keeping the higher-scoring item. */
export function dedupe(scored: ScoredActivity[]): ScoredActivity[] {
  const sorted = [...scored].sort(compareScored);
  const stems = new Set<string>();
  const urls = new Set<string>();
  const out: ScoredActivity[] = [];
  for (const s of sorted) {
    const stem = titleStem(s.activity.title);
    const url = s.activity.source_url ? normaliseUrl(s.activity.source_url) : '';
    if (stems.has(stem) || (url !== '' && urls.has(url))) continue;
    stems.add(stem);
    if (url !== '') urls.add(url);
    out.push(s);
  }
  return out;
}

/**
 * Number of rating interactions per category (positive + negative):
 * swipe_like, swipe_pass, tried_enjoyed, tried_meh, and browse saves. Not-ready, unsave and the
 * swipe-generated save are not ratings.
 */
export function ratingCounts(input: RecInput): Record<Category, number> {
  const byId = new Map<string, Activity>();
  for (const a of input.activities) byId.set(a.id, a);
  const counts: Record<Category, number> = {
    gross_motor: 0, fine_motor: 0, language: 0, social_emotional: 0, cognitive: 0, other: 0,
  };
  for (const it of input.interactions) {
    const isRating =
      it.type === 'swipe_like' ||
      it.type === 'swipe_pass' ||
      it.type === 'tried_enjoyed' ||
      it.type === 'tried_meh' ||
      (it.type === 'save' && it.via !== 'swipe');
    if (!isRating) continue;
    const a = byId.get(it.itemId);
    if (a) counts[a.category] += 1;
  }
  return counts;
}

/** Categories ordered least-rated first; ties keep CATEGORIES order. */
export function leastRatedCategories(input: RecInput): Category[] {
  const counts = ratingCounts(input);
  return [...CATEGORIES].sort((x, y) => counts[x] - counts[y] || CATEGORIES.indexOf(x) - CATEGORIES.indexOf(y));
}

/** 2 of every 10 slots. */
export function explorationSlots(n: number): number {
  return Math.floor((n * 2) / 10);
}

/**
 * Re-rank for balance (SDD §7.4). Deterministic.
 * 1. Dedupe near-duplicates (title stem or source URL), keep higher score.
 * 2. Exploration: floor(n/5) slots, one per category, walking categories from least-rated; in each,
 *    the item with the highest milestonePriority (> 0), ties by score. If not enough categories
 *    have a milestone-linked item, a second pass takes the best-scoring item of the least-rated
 *    remaining categories.
 * 3. Fill the rest by score with at most 4 per category (cap relaxed only if the pool can't fill n).
 * 4. Coverage: while fewer than min(4, categories available) categories are present, replace the
 *    lowest-scoring non-exploration item of a category holding >1 slot with the best item of a
 *    missing category.
 * Output order: non-exploration picks by score, exploration picks inserted at positions 5, 10, ...
 */
export function rerank(scored: ScoredActivity[], input: RecInput, n = 10): RankedItem[] {
  if (n <= 0) return [];
  const pool = dedupe(scored);
  const chosen = new Set<string>();
  const catCount = new Map<Category, number>();
  const add = (s: ScoredActivity): void => {
    chosen.add(s.activity.id);
    catCount.set(s.activity.category, (catCount.get(s.activity.category) ?? 0) + 1);
  };
  const remove = (s: ScoredActivity): void => {
    chosen.delete(s.activity.id);
    catCount.set(s.activity.category, (catCount.get(s.activity.category) ?? 0) - 1);
  };

  // 2. Exploration
  const explore: ScoredActivity[] = [];
  const slots = Math.min(explorationSlots(n), pool.length);
  const order = leastRatedCategories(input);
  const exploreCats = new Set<Category>();
  for (const requireMilestone of [true, false]) {
    for (const cat of order) {
      if (explore.length >= slots) break;
      if (exploreCats.has(cat)) continue;
      let best: ScoredActivity | null = null;
      for (const s of pool) {
        if (s.activity.category !== cat || chosen.has(s.activity.id)) continue;
        if (requireMilestone && s.milestonePriority <= 0) continue;
        if (!best || s.milestonePriority > best.milestonePriority) best = s; // pool is score-sorted
      }
      if (best) {
        explore.push(best);
        exploreCats.add(cat);
        add(best);
      }
    }
  }

  // 3. Fill by score with the per-category cap
  const main: ScoredActivity[] = [];
  const total = (): number => explore.length + main.length;
  for (const s of pool) {
    if (total() >= n) break;
    if (chosen.has(s.activity.id)) continue;
    if ((catCount.get(s.activity.category) ?? 0) >= MAX_PER_CATEGORY) continue;
    main.push(s);
    add(s);
  }
  for (const s of pool) {
    if (total() >= n) break;
    if (chosen.has(s.activity.id)) continue;
    main.push(s);
    add(s);
  }

  // 4. Category coverage
  const available = new Set(pool.map((s) => s.activity.category)).size;
  const required = Math.min(MIN_CATEGORIES, available);
  const present = (): number => [...catCount.values()].filter((c) => c > 0).length;
  while (present() < required) {
    const incoming = pool.find((s) => !chosen.has(s.activity.id) && (catCount.get(s.activity.category) ?? 0) === 0);
    if (!incoming) break;
    let victimIdx = -1;
    for (let i = main.length - 1; i >= 0; i--) {
      if ((catCount.get(main[i].activity.category) ?? 0) > 1) {
        victimIdx = i;
        break;
      }
    }
    if (victimIdx === -1) break;
    remove(main[victimIdx]);
    main.splice(victimIdx, 1);
    main.push(incoming);
    add(incoming);
    main.sort(compareScored);
  }

  main.sort(compareScored);
  const out: RankedItem[] = main.map((s) => ({ ...s, explore: false }));
  explore.forEach((s, k) => {
    const pos = Math.min(out.length, 5 * (k + 1) - 1);
    out.splice(pos, 0, { ...s, explore: true });
  });
  return out;
}
