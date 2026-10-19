/**
 * Visitor counts only (SDD §9.1). On app open: if this device hasn't pinged today (Singapore date),
 * send { day_first: true, month_first, week_first } to the visit-counter URL. All three flags come
 * from the one locally stored date of the last ping, so it is still at most one ping a day.
 * Nothing else is sent: no ID, no birth month, no page, no search.
 * Disabled when NEXT_PUBLIC_VISIT_URL is unset (Phase 1).
 */
import { todaySG } from './age';

export interface PingPayload {
  day_first: true;
  month_first: boolean;
  /** first visit in this ISO week (Monday to Sunday, Singapore dates) */
  week_first: boolean;
}

/** ISO 8601 week of a calendar date (YYYY-MM-DD), e.g. "2026-W43". Weeks start on Monday. */
export function isoWeek(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const dow = t.getUTCDay() || 7; // Mon=1 .. Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - dow); // the Thursday of the same week decides the year
  const year = t.getUTCFullYear();
  const week = Math.floor((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 / 7) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Pure: decide what (if anything) to send given the last ping date (YYYY-MM-DD) and today. */
export function computePing(lastPing: string | null, today: string): PingPayload | null {
  if (lastPing === today) return null;
  return {
    day_first: true,
    month_first: !lastPing || lastPing.slice(0, 7) !== today.slice(0, 7),
    week_first: !lastPing || isoWeek(lastPing) !== isoWeek(today),
  };
}

export interface PingDeps {
  url: string | undefined;
  lastPing: string | null;
  savePing: (date: string) => Promise<void> | void;
  fetchFn?: typeof fetch;
  now?: Date;
}

/** Returns the payload that was sent, or null if nothing was sent. */
export async function visitPing(deps: PingDeps): Promise<PingPayload | null> {
  if (!deps.url) return null;
  const today = todaySG(deps.now);
  const payload = computePing(deps.lastPing, today);
  if (!payload) return null;
  const f = deps.fetchFn ?? fetch;
  try {
    await f(deps.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'omit',
      keepalive: true,
    });
    await deps.savePing(today);
    return payload;
  } catch {
    return null;
  }
}

export const VISIT_URL: string | undefined = process.env.NEXT_PUBLIC_VISIT_URL || undefined;
