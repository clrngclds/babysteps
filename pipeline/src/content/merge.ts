/**
 * Turns gate-passing candidates into canonical records and merges them into content (SDD §8.5 step 1).
 * Field order matches data/*.json, with the lifecycle fields at the end.
 */
import type { Activity, ActivityDraft, Candidate, ContentSet, Outing, OutingDraft } from '../types';

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');

/** act-m{MM}-{code}-{nn}: next free number in that month x category cell. */
export function nextActivityId(content: ContentSet, month: number, category: string, taken: Set<string>): string {
  const code = content.milestones.categories.find((c) => c.id === category)?.code ?? 'oth';
  const prefix = `act-m${String(month).padStart(2, '0')}-${code}-`;
  let n = 1;
  for (const a of content.activities) {
    if (a.id.startsWith(prefix)) n = Math.max(n, Number(a.id.slice(prefix.length)) + 1 || n);
  }
  let id = `${prefix}${String(n).padStart(2, '0')}`;
  while (taken.has(id)) id = `${prefix}${String(++n).padStart(2, '0')}`;
  return id;
}

/** sg-{type}-{slug}[-n] */
export function nextOutingId(type: string, name: string, taken: Set<string>): string {
  const base = `sg-${type}-${slug(name) || 'item'}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

export function toActivity(d: ActivityDraft, id: string, today: string): Activity {
  return {
    id,
    title: d.title,
    month: d.month,
    category: d.category,
    philosophy: d.philosophy,
    milestone_ids: d.milestone_ids,
    summary: d.summary,
    how_to: d.how_to,
    materials: d.materials,
    setting: d.setting,
    energy: d.energy,
    senses: d.senses,
    play_type: d.play_type,
    duration_min: d.duration_min,
    parent_role: d.parent_role,
    safety_notes: d.safety_notes ?? '',
    source_name: d.source_name,
    source_url: d.source_url,
    verified: true, // passed grounding (G2)
    paid: d.paid,
    added_at: today,
    status: 'published',
    origin: 'pipeline',
  };
}

export function toOuting(d: OutingDraft, id: string, today: string): Outing {
  return {
    id,
    name: d.name,
    type: d.type,
    summary: d.summary,
    location: d.location,
    region: d.region,
    min_age_months: d.min_age_months,
    max_age_months: d.max_age_months,
    categories: d.categories,
    play_type: d.play_type,
    setting: d.setting,
    rain_ok: d.rain_ok,
    price_note: d.price_note ?? '',
    booking_required: d.booking_required,
    start_date: d.start_date ?? null,
    end_date: d.end_date ?? null,
    recurrence: d.recurrence ?? null,
    dates_confirmed: d.dates_confirmed,
    url: d.url,
    last_verified: today,
    notes: d.notes ?? '',
    paid: d.paid,
    added_at: today,
    status: 'published',
    origin: 'pipeline',
  };
}

export interface MergeResult {
  content: ContentSet;
  addedActivities: Activity[];
  addedOutings: Outing[];
  updated: { id: string; reason: string }[];
}

/** Pure: returns a new ContentSet. Venue updates (`replaces_id`) overwrite fields of the existing outing. */
export function mergeCandidates(content: ContentSet, cands: Candidate[], today: string): MergeResult {
  const taken = new Set([...content.activities.map((a) => a.id), ...content.outings.map((o) => o.id)]);
  const activities = [...content.activities];
  const outings = [...content.outings];
  const addedActivities: Activity[] = [];
  const addedOutings: Outing[] = [];
  const updated: { id: string; reason: string }[] = [];

  for (const c of cands) {
    if (c.kind === 'activity') {
      const d = c.draft as ActivityDraft;
      const id = nextActivityId({ ...content, activities }, d.month, d.category, taken);
      taken.add(id);
      const rec = toActivity(d, id, today);
      activities.push(rec);
      addedActivities.push(rec);
    } else if (c.replaces_id) {
      const i = outings.findIndex((o) => o.id === c.replaces_id);
      if (i < 0) continue;
      const prev = outings[i];
      const next = toOuting(c.draft as OutingDraft, prev.id, today);
      // Keep identity and history fields from the stored record.
      outings[i] = { ...next, added_at: prev.added_at, origin: prev.origin };
      updated.push({ id: prev.id, reason: 'venue re-check' });
    } else {
      const d = c.draft as OutingDraft;
      const id = nextOutingId(d.type, d.name, taken);
      taken.add(id);
      const rec = toOuting(d, id, today);
      outings.push(rec);
      addedOutings.push(rec);
    }
  }
  return { content: { ...content, activities, outings }, addedActivities, addedOutings, updated };
}

/** Pure: marks records retired. Unknown ids are ignored. */
export function retireRecords(content: ContentSet, ids: Set<string>): ContentSet {
  const r = <T extends { id: string; status?: string }>(x: T): T => (ids.has(x.id) ? { ...x, status: 'retired' } : x);
  return { ...content, activities: content.activities.map(r), outings: content.outings.map(r) };
}

/** Pure: applies field patches to outings (date confirmation, last_verified). */
export function patchOutings(content: ContentSet, patches: Map<string, Partial<Outing>>): ContentSet {
  return { ...content, outings: content.outings.map((o) => (patches.has(o.id) ? { ...o, ...patches.get(o.id) } : o)) };
}
