import { candidates } from './candidates';
import { reasonFor } from './reasons';
import { rerank, titleStem } from './rerank';
import { buildContext, scoreAll } from './score';
import { CATEGORIES } from './types';
import type { Activity, Category, Pick, RecInput } from './types';

export * from './types';
export { activityTags, computeTagAffinity, decay, tagLabel, INTERACTION_WEIGHTS, BROWSE_SAVE_WEIGHT, DAY_MS, HALF_LIFE_MS } from './tags';
export {
  ageFit,
  milestonePriority,
  bestMilestone,
  targetCheckpoint,
  checkpointIndex,
  tagAffinityNorm,
  score,
  scoreAll,
  buildContext,
  W_TAG,
  W_MILESTONE,
  W_AGE,
} from './score';
export type { ScoreContext, ScoredActivity } from './score';
export { candidates, excludedIds, monthWindow, isPublished, NOT_READY_COOLDOWN_MS } from './candidates';
export { rerank, dedupe, titleStem, ratingCounts, leastRatedCategories, explorationSlots, MAX_PER_CATEGORY, MIN_CATEGORIES } from './rerank';
export type { RankedItem } from './rerank';
export { reasonFor, likedIds, savedMatch, isNew, CATEGORY_LABELS } from './reasons';

/** True when there is any swipe, save or tried history (or saved favorites). */
export function hasHistory(input: RecInput): boolean {
  return input.favorites.length > 0 || input.interactions.some((i) => i.type !== 'unsave');
}

/**
 * First-run deck. From candidates: one per category (in CATEGORIES order), then the remaining
 * n-6 from any category. Each step picks greedily by, in order:
 *   1. not a near-duplicate (title stem / source URL) of an already chosen card
 *   2. month === age
 *   3. novelty = new energy value + new setting value + (any new play_type ? 1 : 0)
 *   4. (fill phase only) fewer cards already chosen from its category
 *   5. smaller |month - age|, then id
 * Deterministic.
 */
export function seedDeck(input: RecInput, n = 8): Activity[] {
  const pool = candidates(input);
  const age = input.ageMonths;
  const chosen: Activity[] = [];
  const chosenIds = new Set<string>();
  const energies = new Set<string>();
  const settings = new Set<string>();
  const plays = new Set<string>();
  const stems = new Set<string>();
  const urls = new Set<string>();
  const catCount = new Map<Category, number>();

  const take = (a: Activity): void => {
    chosen.push(a);
    chosenIds.add(a.id);
    energies.add(a.energy);
    settings.add(a.setting);
    a.play_type.forEach((p) => plays.add(p));
    stems.add(titleStem(a.title));
    urls.add(a.source_url);
    catCount.set(a.category, (catCount.get(a.category) ?? 0) + 1);
  };
  const key = (a: Activity, useCat: boolean): number[] => [
    stems.has(titleStem(a.title)) || urls.has(a.source_url) ? 1 : 0,
    a.month === age ? 0 : 1,
    -((energies.has(a.energy) ? 0 : 1) + (settings.has(a.setting) ? 0 : 1) + (a.play_type.some((p) => !plays.has(p)) ? 1 : 0)),
    useCat ? catCount.get(a.category) ?? 0 : 0,
    Math.abs(a.month - age),
  ];
  const better = (x: Activity, y: Activity, useCat: boolean): boolean => {
    const kx = key(x, useCat);
    const ky = key(y, useCat);
    for (let i = 0; i < kx.length; i++) if (kx[i] !== ky[i]) return kx[i] < ky[i];
    return x.id < y.id;
  };
  const pickBest = (filter: (a: Activity) => boolean, useCat: boolean): Activity | null => {
    let best: Activity | null = null;
    for (const a of pool) {
      if (chosenIds.has(a.id) || !filter(a)) continue;
      if (!best || better(a, best, useCat)) best = a;
    }
    return best;
  };

  for (const cat of CATEGORIES) {
    if (chosen.length >= n) break;
    const a = pickBest((x) => x.category === cat, false);
    if (a) take(a);
  }
  while (chosen.length < n) {
    const a = pickBest(() => true, true);
    if (!a) break;
    take(a);
  }
  return chosen;
}

/** Continuing swipe deck: candidates scored and re-ranked, top n. Falls back to seedDeck without history. */
export function nextDeck(input: RecInput, n = 8): Activity[] {
  if (!hasHistory(input)) return seedDeck(input, n);
  const ctx = buildContext(input);
  return rerank(scoreAll(candidates(input), ctx), input, n).map((r) => r.activity);
}

/** candidates -> score -> rerank -> reasons. */
export function recommend(input: RecInput, n = 10): Pick[] {
  const ctx = buildContext(input);
  const ranked = rerank(scoreAll(candidates(input), ctx), input, n);
  return ranked.map((r) => {
    const { reason, kind } = reasonFor(r, input, ctx);
    return { activity: r.activity, score: r.score, reason, kind };
  });
}
