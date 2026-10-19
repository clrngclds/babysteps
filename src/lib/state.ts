/**
 * On-device state (SDD §6.3). One IndexedDB record, key `bd-state-v1`.
 * Pure update helpers live here so they can be unit-tested; persistence is in idb.ts.
 */
import type { Interaction, InteractionType } from './types';
import { DEFAULT_FILTERS, type Filters } from './filters';

export const STATE_KEY = 'bd-state-v1';
export const MAX_INTERACTIONS = 2000;

export interface DeviceState {
  birth: string | null; // "YYYY-MM"
  createdAt: string; // YYYY-MM-DD
  catalogVersion: number | null;
  interactions: Interaction[];
  /** saved activity ids, newest first */
  favorites: string[];
  milestonesSeen: string[];
  tagAffinity: Record<string, number>;
  filters: Filters;
  /** last visit-ping date (SG, YYYY-MM-DD). day_first, month_first and week_first are all derived from it. */
  lastPing: string | null;
  /** number of app sessions, for the add-to-home-screen prompt */
  visits: number;
  installDismissed: boolean;
}

export function emptyState(today: string): DeviceState {
  return {
    birth: null,
    createdAt: today,
    catalogVersion: null,
    interactions: [],
    favorites: [],
    milestonesSeen: [],
    tagAffinity: {},
    filters: { ...DEFAULT_FILTERS },
    lastPing: null,
    visits: 0,
    installDismissed: false,
  };
}

/** Fill in missing fields from older or partial records. */
export function normalizeState(raw: unknown, today: string): DeviceState {
  const base = emptyState(today);
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<DeviceState>;
  return {
    ...base,
    ...r,
    filters: { ...DEFAULT_FILTERS, ...(r.filters ?? {}) },
    interactions: Array.isArray(r.interactions) ? r.interactions : [],
    favorites: Array.isArray(r.favorites) ? r.favorites : [],
    milestonesSeen: Array.isArray(r.milestonesSeen) ? r.milestonesSeen : [],
    // A malformed date would break the day/week/month comparison; treat it as "never pinged".
    lastPing: isIsoDate(r.lastPing) ? r.lastPing : null,
  };
}

function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

function push(s: DeviceState, ...items: Interaction[]): Interaction[] {
  const next = [...s.interactions, ...items];
  return next.length > MAX_INTERACTIONS ? next.slice(next.length - MAX_INTERACTIONS) : next;
}

export function addSave(s: DeviceState, itemId: string, ageMonths: number, ts: number, via: 'browse' | 'swipe' = 'browse'): DeviceState {
  if (s.favorites.includes(itemId)) return s;
  return {
    ...s,
    favorites: [itemId, ...s.favorites],
    interactions: push(s, { type: 'save', itemId, ageMonths, ts, via }),
  };
}

export function removeSave(s: DeviceState, itemId: string, ageMonths: number, ts: number): DeviceState {
  if (!s.favorites.includes(itemId)) return s;
  return {
    ...s,
    favorites: s.favorites.filter((x) => x !== itemId),
    interactions: push(s, { type: 'unsave', itemId, ageMonths, ts }),
  };
}

export type SwipeDir = 'like' | 'pass' | 'not_ready';

/** A right-swipe writes both swipe_like and save (weighted once by the recommender). */
export function addSwipe(s: DeviceState, itemId: string, dir: SwipeDir, ageMonths: number, ts: number): DeviceState {
  const type: InteractionType = dir === 'like' ? 'swipe_like' : dir === 'pass' ? 'swipe_pass' : 'swipe_not_ready';
  const next: DeviceState = { ...s, interactions: push(s, { type, itemId, ageMonths, ts }) };
  return dir === 'like' ? addSave(next, itemId, ageMonths, ts, 'swipe') : next;
}

export type TriedResult = 'enjoyed' | 'meh' | 'not_ready';

export function addTried(s: DeviceState, itemId: string, result: TriedResult, ageMonths: number, ts: number): DeviceState {
  const type: InteractionType = result === 'enjoyed' ? 'tried_enjoyed' : result === 'meh' ? 'tried_meh' : 'tried_not_ready';
  return { ...s, interactions: push(s, { type, itemId, ageMonths, ts }) };
}

export function lastTried(s: DeviceState, itemId: string): TriedResult | null {
  for (let i = s.interactions.length - 1; i >= 0; i--) {
    const x = s.interactions[i];
    if (x.itemId !== itemId) continue;
    if (x.type === 'tried_enjoyed') return 'enjoyed';
    if (x.type === 'tried_meh') return 'meh';
    if (x.type === 'tried_not_ready') return 'not_ready';
  }
  return null;
}

export function swipeCount(s: DeviceState): number {
  return s.interactions.filter((x) => x.type === 'swipe_like' || x.type === 'swipe_pass' || x.type === 'swipe_not_ready').length;
}

export function toggleMilestoneSeen(s: DeviceState, id: string): DeviceState {
  return {
    ...s,
    milestonesSeen: s.milestonesSeen.includes(id) ? s.milestonesSeen.filter((x) => x !== id) : [...s.milestonesSeen, id],
  };
}
