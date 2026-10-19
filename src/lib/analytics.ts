/**
 * Visitor counts only (SDD §9.1). On app open: if this device hasn't pinged today (Singapore date),
 * send { day_first: true, month_first } to the visit-counter URL. Nothing else is sent: no ID,
 * no birth month, no page, no search. Disabled when NEXT_PUBLIC_VISIT_URL is unset (Phase 1).
 */
import { todaySG } from './age';

export interface PingPayload {
  day_first: true;
  month_first: boolean;
}

/** Pure: decide what (if anything) to send given the last ping date (YYYY-MM-DD) and today. */
export function computePing(lastPing: string | null, today: string): PingPayload | null {
  if (lastPing === today) return null;
  return { day_first: true, month_first: !lastPing || lastPing.slice(0, 7) !== today.slice(0, 7) };
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
