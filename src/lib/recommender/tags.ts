import type { Activity, Interaction, InteractionType } from './types';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HALF_LIFE_MS = 30 * DAY_MS;

/** Base tag-weight change per interaction (SDD §7.3). `save` depends on `via`, see computeTagAffinity. */
export const INTERACTION_WEIGHTS: Record<Exclude<InteractionType, 'save' | 'unsave'>, number> = {
  swipe_like: 1.0,
  swipe_pass: -0.5,
  tried_enjoyed: 2.0,
  tried_meh: -0.5,
  swipe_not_ready: 0,
  tried_not_ready: 0,
};
export const BROWSE_SAVE_WEIGHT = 1.5;

/** Tags for an activity: play_type:x, senses:x, energy:x, setting:x, parent_role:x (deduplicated, stable order). */
export function activityTags(a: Activity): string[] {
  const tags: string[] = [];
  const push = (t: string): void => {
    if (!tags.includes(t)) tags.push(t);
  };
  for (const p of a.play_type) push(`play_type:${p}`);
  for (const s of a.senses) push(`senses:${s}`);
  push(`energy:${a.energy}`);
  push(`setting:${a.setting}`);
  push(`parent_role:${a.parent_role}`);
  return tags;
}

/** Human-readable value of a tag: "play_type:practical_life" -> "practical life". */
export function tagLabel(tag: string): string {
  const i = tag.indexOf(':');
  return (i >= 0 ? tag.slice(i + 1) : tag).replace(/_/g, ' ');
}

/** Exponential decay with a 30-day half-life. Future timestamps are treated as "now". */
export function decay(ts: number, now: number): number {
  const age = Math.max(0, now - ts);
  return Math.pow(0.5, age / HALF_LIFE_MS);
}

/**
 * Chronological order; at equal ts a swipe_like sorts before the `save` it produced
 * (a right-swipe writes both), and save before unsave. Stable otherwise.
 */
export function sortInteractions(interactions: Interaction[]): Interaction[] {
  const rank = (t: InteractionType): number => (t === 'save' ? 1 : t === 'unsave' ? 2 : 0);
  return interactions
    .map((it, idx) => ({ it, idx }))
    .sort((x, y) => x.it.ts - y.it.ts || rank(x.it.type) - rank(y.it.type) || x.idx - y.idx)
    .map((e) => e.it);
}

interface Contribution {
  itemId: string;
  weight: number;
  ts: number;
  cancelled: boolean;
}

/**
 * Per-tag affinity from the interaction history.
 * - swipe_like +1.0 (covers the `save` with via:'swipe' that the right-swipe also writes; that save adds 0)
 * - save via 'browse' or via undefined +1.5
 * - unsave cancels the item's most recent save contribution (the swipe_like's +1.0 for a swipe save,
 *   the +1.5 for a browse save)
 * - swipe_pass -0.5, tried_enjoyed +2.0, tried_meh -0.5, not_ready 0
 * Each contribution is w * 0.5^((now - ts) / 30 days) and is added to every tag of the item.
 * Interactions for items missing from `activitiesById` (e.g. retired) contribute nothing.
 */
export function computeTagAffinity(
  interactions: Interaction[],
  activitiesById: Map<string, Activity>,
  now: number,
): Record<string, number> {
  const contributions: Contribution[] = [];
  const lastLike = new Map<string, Contribution>();
  const saveStack = new Map<string, Array<Contribution | null>>();

  for (const it of sortInteractions(interactions)) {
    switch (it.type) {
      case 'save': {
        const stack = saveStack.get(it.itemId) ?? [];
        if (it.via === 'swipe') {
          // Weighted through the swipe_like; remember which contribution to cancel on unsave.
          const like = lastLike.get(it.itemId);
          stack.push(like && !like.cancelled ? like : null);
        } else {
          const c: Contribution = { itemId: it.itemId, weight: BROWSE_SAVE_WEIGHT, ts: it.ts, cancelled: false };
          contributions.push(c);
          stack.push(c);
        }
        saveStack.set(it.itemId, stack);
        break;
      }
      case 'unsave': {
        const stack = saveStack.get(it.itemId);
        const c = stack && stack.length > 0 ? stack.pop() : undefined;
        if (c) c.cancelled = true;
        break;
      }
      default: {
        const w = INTERACTION_WEIGHTS[it.type];
        const c: Contribution = { itemId: it.itemId, weight: w, ts: it.ts, cancelled: false };
        contributions.push(c);
        if (it.type === 'swipe_like') lastLike.set(it.itemId, c);
      }
    }
  }

  const affinity: Record<string, number> = {};
  for (const c of contributions) {
    if (c.cancelled || c.weight === 0) continue;
    const a = activitiesById.get(c.itemId);
    if (!a) continue;
    const w = c.weight * decay(c.ts, now);
    for (const tag of activityTags(a)) affinity[tag] = (affinity[tag] ?? 0) + w;
  }
  return affinity;
}
