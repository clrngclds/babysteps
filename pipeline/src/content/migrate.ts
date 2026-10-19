/**
 * Phase 3 migration (SDD §6.2): backfill the lifecycle fields on the v2 dataset.
 * Existing fields keep their order; `added_at`, `status`, `origin` are appended at the end, and
 * existing values are never overwritten (so the migration is idempotent). `paid` stays as is.
 */
import type { Activity, Outing } from '../types';

export const SEED_DATE = '2026-10-18';
export const LIFECYCLE_FIELDS = ['added_at', 'status', 'origin'] as const;

export function migrateRecord<T extends object>(r: T, date = SEED_DATE): T {
  const rec = r as Record<string, unknown>;
  const out: Record<string, unknown> = { ...rec };
  if (out.added_at === undefined) out.added_at = date;
  if (out.status === undefined) out.status = 'published';
  if (out.origin === undefined) out.origin = 'seed';
  return out as T;
}

export function migrateActivities(acts: Activity[], date = SEED_DATE): Activity[] {
  return acts.map((a) => migrateRecord(a, date));
}

export function migrateOutings(outs: Outing[], date = SEED_DATE): Outing[] {
  return outs.map((o) => migrateRecord(o, date));
}

/** True if every record already has all lifecycle fields. */
export function isMigrated(records: object[]): boolean {
  return records.every((r) => LIFECYCLE_FIELDS.every((k) => (r as Record<string, unknown>)[k] !== undefined));
}
