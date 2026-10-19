import { DAY_MS, sortInteractions } from './tags';
import type { Activity, Interaction, RecInput } from './types';

export const NOT_READY_COOLDOWN_MS = 28 * DAY_MS;
export const MIN_MONTH = 0;
export const MAX_MONTH = 36;

/** Month window [age-2, age+1], clamped to 0..36. */
export function monthWindow(age: number): [number, number] {
  const lo = Math.min(MAX_MONTH, Math.max(MIN_MONTH, age - 2));
  const hi = Math.min(MAX_MONTH, Math.max(MIN_MONTH, age + 1));
  return [lo, hi];
}

/** Published and verified: `verified !== false` and status undefined or 'published'. */
export function isPublished(a: Activity): boolean {
  return a.verified !== false && (a.status === undefined || a.status === 'published');
}

function isNotReady(i: Interaction): boolean {
  return i.type === 'swipe_not_ready' || i.type === 'tried_not_ready';
}

function isConsumed(i: Interaction): boolean {
  return (
    i.type === 'swipe_like' ||
    i.type === 'swipe_pass' ||
    i.type === 'tried_enjoyed' ||
    i.type === 'tried_meh' ||
    i.type === 'tried_not_ready' ||
    i.type === 'swipe_not_ready'
  );
}

/**
 * Item ids that must not be offered now:
 * - in favorites;
 * - swiped (like/pass/not_ready) or tried (any tried_*);
 *   except when the item's latest interaction is swipe_not_ready/tried_not_ready and at least 28 days
 *   have passed since it (then it returns; before that it stays excluded).
 */
export function excludedIds(input: RecInput): Set<string> {
  const excluded = new Set<string>(input.favorites);
  const latest = new Map<string, Interaction>();
  const consumed = new Set<string>();
  for (const it of sortInteractions(input.interactions)) {
    latest.set(it.itemId, it);
    if (isConsumed(it)) consumed.add(it.itemId);
  }
  for (const id of consumed) {
    const last = latest.get(id);
    if (last && isNotReady(last) && input.now - last.ts >= NOT_READY_COOLDOWN_MS) continue;
    excluded.add(id);
  }
  return excluded;
}

export function candidates(input: RecInput): Activity[] {
  const [lo, hi] = monthWindow(input.ageMonths);
  const excluded = excludedIds(input);
  return input.activities.filter(
    (a) =>
      isPublished(a) &&
      a.month >= lo &&
      a.month <= hi &&
      !(input.hidePaid && a.paid === true) &&
      !excluded.has(a.id),
  );
}
