import type { RankedItem } from './rerank';
import { bestMilestone, checkpointIndex } from './score';
import type { ScoreContext } from './score';
import { DAY_MS, activityTags, sortInteractions, tagLabel } from './tags';
import type { Activity, Category, Pick, RecInput } from './types';

export const CATEGORY_LABELS: Record<Category, string> = {
  gross_motor: 'gross motor',
  fine_motor: 'fine motor',
  language: 'language',
  social_emotional: 'social-emotional',
  cognitive: 'cognitive',
  other: 'everyday-life',
};

export const NEW_WINDOW_MS = 7 * DAY_MS;

/** True when added_at is within 7 days of now. Seed content (the original dataset) is never "new". */
export function isNew(a: Activity, now: number): boolean {
  if (!a.added_at || a.origin === 'seed') return false;
  const t = Date.parse(a.added_at);
  return !Number.isNaN(t) && now - t <= NEW_WINDOW_MS;
}

/**
 * Items the user has signalled they like, most recent first: favorites, tried_enjoyed, and
 * swipe_like (unless the swipe's save was later undone).
 */
export function likedIds(input: RecInput): string[] {
  const lastTs = new Map<string, number>();
  const unsaved = new Set<string>();
  const enjoyed = new Set<string>();
  for (const it of sortInteractions(input.interactions)) {
    if (it.type === 'save') unsaved.delete(it.itemId);
    if (it.type === 'unsave') unsaved.add(it.itemId);
    if (it.type === 'swipe_like' || it.type === 'tried_enjoyed' || it.type === 'save') {
      lastTs.set(it.itemId, it.ts);
      if (it.type === 'tried_enjoyed') enjoyed.add(it.itemId);
    }
  }
  const ids = new Set<string>(input.favorites);
  for (const id of lastTs.keys()) {
    if (enjoyed.has(id) || !unsaved.has(id)) ids.add(id);
  }
  for (const id of input.favorites) if (!lastTs.has(id)) lastTs.set(id, -Infinity);
  return [...ids].sort((x, y) => (lastTs.get(y) ?? -Infinity) - (lastTs.get(x) ?? -Infinity) || (x < y ? -1 : 1));
}

interface SavedMatch {
  saved: Activity;
  labels: string[];
}

/**
 * The liked item sharing the most positively-weighted tags (affinity > 0) with the pick.
 * Ties: most recently liked. Labels: up to two distinct shared tag values, highest affinity first.
 */
export function savedMatch(a: Activity, input: RecInput, ctx: ScoreContext): SavedMatch | null {
  const byId = new Map<string, Activity>();
  for (const x of input.activities) byId.set(x.id, x);
  const pickTags = activityTags(a);
  let best: { saved: Activity; shared: string[] } | null = null;
  for (const id of likedIds(input)) {
    if (id === a.id) continue;
    const saved = byId.get(id);
    if (!saved) continue;
    const savedTags = new Set(activityTags(saved));
    const shared = pickTags.filter((t) => savedTags.has(t) && (ctx.affinity[t] ?? 0) > 0);
    if (shared.length > 0 && (!best || shared.length > best.shared.length)) best = { saved, shared };
  }
  if (!best) return null;
  const ordered = [...best.shared].sort(
    (x, y) => (ctx.affinity[y] ?? 0) - (ctx.affinity[x] ?? 0) || pickTags.indexOf(x) - pickTags.indexOf(y),
  );
  const labels: string[] = [];
  for (const t of ordered) {
    const l = tagLabel(t);
    if (!labels.includes(l)) labels.push(l);
    if (labels.length === 2) break;
  }
  return { saved: best.saved, labels };
}

/**
 * Reason templates (SDD §7.5). Priority: exploration slot -> saved-item overlap -> milestone ->
 * new this week -> age.
 */
export function reasonFor(item: RankedItem, input: RecInput, ctx: ScoreContext): { reason: string; kind: Pick['kind'] } {
  const a = item.activity;
  if (item.explore) {
    return { reason: `Something new: a ${CATEGORY_LABELS[a.category]} activity`, kind: 'explore' };
  }
  const match = savedMatch(a, input, ctx);
  if (match) {
    return { reason: `Because you saved ${match.saved.title} (${match.labels.join(', ')})`, kind: 'saved' };
  }
  const hit = item.milestonePriority > 0 ? bestMilestone(a, ctx) : null;
  if (hit) {
    const ci = checkpointIndex(hit.milestone.month, ctx.checkpoints);
    const by = ci >= 0 && ctx.checkpoints[ci] >= hit.milestone.month ? ctx.checkpoints[ci] : hit.milestone.month;
    return { reason: `Builds toward ${hit.milestone.text} (by ${by} months)`, kind: 'milestone' };
  }
  if (isNew(a, input.now)) return { reason: 'New this week', kind: 'new' };
  return { reason: `Right for ${input.ageMonths} months`, kind: 'age' };
}
