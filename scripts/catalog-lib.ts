/**
 * Pure catalog validation + build logic (no file I/O), so it can be unit-tested.
 * Used by scripts/build-catalog.ts.
 */
import type { Activity, Milestone, Outing, MilestonesFile, ByMonthFile, LatestPointer } from '../src/lib/types';

export const CATEGORY_IDS = ['gross_motor', 'fine_motor', 'language', 'social_emotional', 'cognitive', 'other'] as const;
export const PHILOSOPHY = ['montessori', 'lovevery', 'reggio_emilia'];
export const SETTING = ['indoor', 'outdoor', 'either'];
export const ENERGY = ['calm', 'moderate', 'active'];
export const SENSES = ['touch', 'sight', 'sound', 'movement', 'taste', 'smell'];
export const PLAY_TYPE = [
  'exploration', 'sensory', 'construction', 'pretend', 'movement', 'music',
  'reading', 'practical_life', 'nature', 'art', 'social',
];
export const PARENT_ROLE = ['lead', 'alongside', 'observe'];
export const OUTING_TYPE = ['venue', 'programme', 'event'];
export const REGION = ['central', 'north', 'north-east', 'east', 'west'];
/** Content lifecycle fields added in Phase 3 (SDD 6.2, 8.5). All optional so older data still validates. */
export const STATUS = ['published', 'retired'];
export const ORIGIN = ['seed', 'pipeline'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface RawData {
  activities: Activity[];
  milestones: MilestonesFile;
  outings: Outing[];
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

const isNonEmpty = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0;
const isHttps = (s: unknown) => typeof s === 'string' && /^https:\/\/\S+$/.test(s);
const isUrl = (s: unknown) => typeof s === 'string' && /^https?:\/\/\S+$/.test(s);

/** Activities that ship: verified and not retired. */
export function publishedActivities(acts: Activity[]): Activity[] {
  return acts.filter((a) => a.verified !== false && (a.status === undefined || a.status === 'published'));
}

/** Outings that ship: not retired (expired events and closed venues are retired by the pipeline). */
export function publishedOutings(outs: Outing[]): Outing[] {
  return outs.filter((o) => o.status === undefined || o.status === 'published');
}

/** Checks the optional lifecycle fields shared by activities and outings. */
function lifecycleErrors(r: { added_at?: string; status?: string; origin?: string }, p: string): string[] {
  const errs: string[] = [];
  if (r.added_at !== undefined && !(typeof r.added_at === 'string' && ISO_DATE.test(r.added_at))) errs.push(`${p} added_at not ISO date`);
  if (r.status !== undefined && !STATUS.includes(r.status)) errs.push(`${p} bad status ${r.status}`);
  if (r.origin !== undefined && !ORIGIN.includes(r.origin)) errs.push(`${p} bad origin ${r.origin}`);
  return errs;
}

/** Record-level checks for one activity (no id-uniqueness or coverage checks). */
export function validateActivity(a: Activity, msIds: Set<string>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const p = `${a.id}:`;
  if (!isNonEmpty(a.id)) errors.push(`${p} empty id`);
  if (!isNonEmpty(a.title)) errors.push(`${p} empty title`);
  if (!Number.isInteger(a.month) || a.month < 0 || a.month > 36) errors.push(`${p} month out of range`);
  if (!(CATEGORY_IDS as readonly string[]).includes(a.category)) errors.push(`${p} bad category ${a.category}`);
  if (!Array.isArray(a.philosophy) || a.philosophy.some((x) => !PHILOSOPHY.includes(x))) errors.push(`${p} bad philosophy`);
  if (!SETTING.includes(a.setting)) errors.push(`${p} bad setting ${a.setting}`);
  if (!ENERGY.includes(a.energy)) errors.push(`${p} bad energy ${a.energy}`);
  if (!PARENT_ROLE.includes(a.parent_role)) errors.push(`${p} bad parent_role ${a.parent_role}`);
  if (!Array.isArray(a.senses) || a.senses.some((x) => !SENSES.includes(x))) errors.push(`${p} bad senses`);
  if (!Array.isArray(a.play_type) || a.play_type.some((x) => !PLAY_TYPE.includes(x))) errors.push(`${p} bad play_type`);
  if (!Array.isArray(a.materials)) errors.push(`${p} materials must be an array`);
  if (typeof a.duration_min !== 'number' || a.duration_min <= 0) errors.push(`${p} bad duration_min`);
  if (typeof a.paid !== 'boolean') errors.push(`${p} paid must be boolean`);
  if (typeof a.verified !== 'boolean') errors.push(`${p} verified must be boolean`);
  if (!isNonEmpty(a.summary) || !isNonEmpty(a.how_to)) errors.push(`${p} missing summary/how_to`);
  // Unverified items are dropped before publishing, so a missing source is only an error for verified ones.
  if (a.verified !== false) {
    if (!isNonEmpty(a.source_name) || !isUrl(a.source_url)) errors.push(`${p} missing source`);
    else if (!isHttps(a.source_url)) warnings.push(`${p} source_url is not https`);
  }
  if (!Array.isArray(a.milestone_ids)) errors.push(`${p} milestone_ids must be an array`);
  for (const mid of a.milestone_ids ?? []) {
    if (!msIds.has(mid)) errors.push(`${p} milestone ref ${mid} does not resolve`);
  }
  errors.push(...lifecycleErrors(a, p));
  return { errors, warnings };
}

/** Record-level checks for one outing (no id-uniqueness checks). */
export function validateOuting(o: Outing): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const p = `${o.id}:`;
  if (!isNonEmpty(o.id)) errors.push(`${p} empty id`);
  if (!isNonEmpty(o.name)) errors.push(`${p} empty name`);
  if (!isNonEmpty(o.summary)) errors.push(`${p} empty summary`);
  if (!OUTING_TYPE.includes(o.type)) errors.push(`${p} bad type ${o.type}`);
  if (!REGION.includes(o.region)) errors.push(`${p} bad region ${o.region}`);
  if (!SETTING.includes(o.setting)) errors.push(`${p} bad setting ${o.setting}`);
  if (typeof o.paid !== 'boolean') errors.push(`${p} paid must be boolean`);
  if (typeof o.rain_ok !== 'boolean') errors.push(`${p} rain_ok must be boolean`);
  if (!(o.min_age_months >= 0 && o.max_age_months >= o.min_age_months)) errors.push(`${p} bad age range`);
  if ((o.categories ?? []).some((c) => !(CATEGORY_IDS as readonly string[]).includes(c))) errors.push(`${p} bad categories`);
  if (!Array.isArray(o.play_type) || o.play_type.some((x) => !PLAY_TYPE.includes(x))) errors.push(`${p} bad play_type`);
  if (!isHttps(o.url)) errors.push(`${p} url must be https`);
  for (const k of ['start_date', 'end_date'] as const) {
    const v = o[k];
    if (v !== null && !(typeof v === 'string' && ISO_DATE.test(v))) errors.push(`${p} ${k} not ISO date`);
  }
  if (o.type === 'event' && !o.start_date) errors.push(`${p} event without start_date`);
  if (o.start_date && o.end_date && o.end_date < o.start_date) errors.push(`${p} end_date before start_date`);
  if (o.paid && !isNonEmpty(o.price_note)) warnings.push(`${p} paid outing without price_note`);
  errors.push(...lifecycleErrors(o, p));
  return { errors, warnings };
}

export interface ValidateOptions {
  /** Treat published-set coverage gaps (after dropping unverified items) as errors. */
  strictPublishedCoverage?: boolean;
}

export function validate(data: RawData, opts: ValidateOptions = {}): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  const dup = (id: string, kind: string) => {
    if (ids.has(id)) errors.push(`duplicate id ${id} (${kind})`);
    ids.add(id);
  };

  const ms = data.milestones;
  const checkpoints = ms.checkpoints_months;
  const msIds = new Set<string>();
  for (const m of ms.milestones) {
    dup(m.id, 'milestone');
    msIds.add(m.id);
    if (!(CATEGORY_IDS as readonly string[]).includes(m.category)) errors.push(`${m.id}: bad category ${m.category}`);
    if (!checkpoints.includes(m.month)) errors.push(`${m.id}: month ${m.month} is not a checkpoint`);
    if (!isNonEmpty(m.text)) errors.push(`${m.id}: empty text`);
  }

  for (const a of data.activities) {
    dup(a.id, 'activity');
    const r = validateActivity(a, msIds);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }

  for (const o of data.outings) {
    dup(o.id, 'outing');
    const r = validateOuting(o);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }

  // Coverage: >=2 activities per month x category in the source data (error),
  // and in the published set after dropping unverified items (warning unless strict).
  const pub = publishedActivities(data.activities);
  for (let m = 0; m <= 36; m++) {
    for (const c of CATEGORY_IDS) {
      const nAll = data.activities.filter((a) => a.month === m && a.category === c).length;
      if (nAll < 2) errors.push(`coverage: month ${m} ${c} has ${nAll} activities (need >= 2)`);
      const nPub = pub.filter((a) => a.month === m && a.category === c).length;
      if (nAll >= 2 && nPub < 2) {
        const msg = `coverage: month ${m} ${c} has ${nPub} published activities after dropping unverified (need >= 2)`;
        (opts.strictPublishedCoverage ? errors : warnings).push(msg);
      }
    }
  }

  // Every milestone should be linked by >=1 published activity (warning only).
  const linked = new Set(pub.flatMap((a) => a.milestone_ids));
  for (const m of ms.milestones) if (!linked.has(m.id)) warnings.push(`${m.id}: no published activity links to it`);

  const dropped = data.activities.length - pub.length;
  if (dropped) warnings.push(`${dropped} unverified/retired activities dropped`);
  const droppedOutings = data.outings.length - publishedOutings(data.outings).length;
  if (droppedOutings) warnings.push(`${droppedOutings} retired outings dropped`);
  return { errors, warnings };
}

/** Smallest checkpoint >= month (the current or next CDC checkpoint). */
export function checkpointFor(month: number, checkpoints: number[]): number {
  const sorted = [...checkpoints].sort((a, b) => a - b);
  return sorted.find((c) => c >= month) ?? sorted[sorted.length - 1];
}

export function nextCheckpoint(cp: number, checkpoints: number[]): number | null {
  const sorted = [...checkpoints].sort((a, b) => a - b);
  return sorted.find((c) => c > cp) ?? null;
}

export interface BuiltCatalog {
  files: Record<string, unknown>; // relative path under catalog/v{N}/ -> JSON value
  latest: LatestPointer;
  counts: { activities: number; milestones: number; outings: number };
}

export function buildCatalog(data: RawData, version: number, publishedAt: string): BuiltCatalog {
  const acts = publishedActivities(data.activities).sort((a, b) => a.month - b.month || a.id.localeCompare(b.id));
  const ms = data.milestones;
  const cps = ms.checkpoints_months;
  const files: Record<string, unknown> = {};
  files['milestones.json'] = ms;
  files['activities.json'] = acts;
  const outings = publishedOutings(data.outings);
  files['outings.json'] = outings;

  for (let m = 0; m <= 36; m++) {
    const cp = checkpointFor(m, cps);
    const next = nextCheckpoint(cp, cps);
    const byMonth: ByMonthFile = {
      month: m,
      checkpoint: cp,
      next_checkpoint: next,
      activities: acts.filter((a) => a.month === m),
      milestones: ms.milestones.filter((x) => x.month === cp || (next !== null && x.month === next)),
    };
    files[`by_month/${String(m).padStart(2, '0')}.json`] = byMonth;
  }

  const m2a: Record<string, string[]> = {};
  for (const x of ms.milestones) m2a[x.id] = [];
  for (const a of acts) for (const mid of a.milestone_ids) (m2a[mid] ??= []).push(a.id);
  files['milestone_to_activities.json'] = m2a;

  return {
    files,
    latest: { version, published_at: publishedAt, path: `catalog/v${version}/` },
    counts: { activities: acts.length, milestones: ms.milestones.length, outings: outings.length },
  };
}

/** Typed helper for the by-month milestones (used in tests). */
export type { Milestone };
