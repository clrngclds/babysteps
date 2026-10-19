/**
 * Page -> 0..n well-formed Activity/Outing drafts (SDD §8.3 step 2). No gates here: G1-G9 run
 * later, so normalisation only fixes shape (types, order, defaults) and never judges content.
 */
import {
  CATEGORY_IDS,
  PHILOSOPHY,
  PLAY_TYPE,
  SENSES,
  checkpointFor,
  nextCheckpoint,
} from '../../../scripts/catalog-lib';
import type { ActivityDraft, Candidate, Llm, MilestonesFile, OutingDraft, PageContext, SourceConfig } from '../types';
import {
  MAX_ACTIVITY_CANDIDATES,
  MAX_OUTING_CANDIDATES,
  activitySystemPrompt,
  extractionUserPrompt,
  outingSystemPrompt,
} from './prompts';
import { ACTIVITY_EXTRACTION_SCHEMA, OUTING_EXTRACTION_SCHEMA } from './schemas';

/** ~6k tokens of page text; article bodies come first, footers and related links last. */
export const MAX_PAGE_CHARS = 24_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ExtractContext {
  milestones: MilestonesFile;
  today: string;
  discoveredVia?: string;
  focus?: { month: number; category: string };
  /** Clock for extracted_at (tests). */
  now?: () => Date;
}

type Raw = Record<string, unknown>;

export function truncateText(text: string, max = MAX_PAGE_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return sp > max - 200 ? cut.slice(0, sp) : cut;
}

export async function extractCandidates(
  llm: Llm,
  page: PageContext,
  source: SourceConfig,
  ctx: ExtractContext,
): Promise<{ candidates: Candidate[]; blocked?: string }> {
  const isActivity = source.kind === 'activity';
  const res = await llm.generateJson<{ candidates?: unknown }>({
    system: isActivity ? activitySystemPrompt(ctx.milestones) : outingSystemPrompt(),
    prompt: extractionUserPrompt({
      sourceName: source.name,
      pageUrl: page.finalUrl,
      pageTitle: page.title,
      pageText: truncateText(page.text),
      today: ctx.today,
      focus: isActivity ? ctx.focus : undefined,
      milestones: ctx.milestones,
    }),
    schema: isActivity ? ACTIVITY_EXTRACTION_SCHEMA : OUTING_EXTRACTION_SCHEMA,
    purpose: 'extract',
  });
  if (res.blocked) return { candidates: [], blocked: res.blocked };

  const raw = Array.isArray(res.data?.candidates) ? (res.data.candidates as unknown[]) : [];
  const extractedAt = (ctx.now ?? (() => new Date()))().toISOString();
  const out: Candidate[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const quote = s((r as Raw).supporting_quote);
    if (!quote) continue;
    const draft = isActivity
      ? normalizeActivity(r as Raw, page, source, ctx.milestones)
      : normalizeOuting(r as Raw, page);
    out.push({
      kind: source.kind,
      draft,
      supporting_quote: quote,
      source_id: source.id,
      ...(ctx.discoveredVia ? { discovered_via: ctx.discoveredVia } : {}),
      page_url: page.finalUrl,
      extracted_at: extractedAt,
      attempts: 1,
      purpose: ctx.focus ? 'coverage' : 'new',
    });
  }
  return { candidates: out.slice(0, isActivity ? MAX_ACTIVITY_CANDIDATES : MAX_OUTING_CANDIDATES) };
}

/* ----------------------------------------------------------------------------------------------
 * Normalisation helpers
 * -------------------------------------------------------------------------------------------- */

const s = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const lower = (v: unknown) => s(v).toLowerCase();
const int = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(s(v));
  return Number.isFinite(n) ? Math.round(n) : NaN;
};
const bool = (v: unknown): boolean => v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true');
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(s).filter(Boolean) : []);
/** Lowercased, deduped, restricted to an allowed list (the schema enum already constrains this). */
const enumList = (v: unknown, allowed: readonly string[]): string[] =>
  [...new Set(strList(v).map((x) => x.toLowerCase()))].filter((x) => allowed.includes(x));
const nullableStr = (v: unknown): string | null => s(v) || null;
const isoOrNull = (v: unknown): string | null => {
  const t = s(v);
  return ISO_DATE.test(t) ? t : null;
};

/** Keep milestone ids that exist and belong to the month's current or next checkpoint (SDD §6.2 by_month). */
function milestoneIds(v: unknown, month: number, ms: MilestonesFile): string[] {
  if (!Number.isInteger(month)) return [];
  const cur = checkpointFor(month, ms.checkpoints_months);
  const next = nextCheckpoint(cur, ms.checkpoints_months);
  const byId = new Map(ms.milestones.map((m) => [m.id, m]));
  return [...new Set(strList(v))].filter((id) => {
    const m = byId.get(id);
    return m !== undefined && (m.month === cur || m.month === next);
  }).slice(0, 3);
}

/** Field order = data/activities.json order. */
export function normalizeActivity(r: Raw, page: PageContext, source: SourceConfig, ms: MilestonesFile): ActivityDraft {
  const m = int(r.month);
  const month = Number.isNaN(m) ? m : Math.min(36, Math.max(0, m));
  const philosophy = enumList(r.philosophy, PHILOSOPHY);
  return {
    title: s(r.title),
    month,
    category: lower(r.category) as ActivityDraft['category'],
    philosophy: philosophy.length ? philosophy : [...(source.philosophy ?? [])],
    milestone_ids: milestoneIds(r.milestone_ids, month, ms),
    summary: s(r.summary),
    how_to: s(r.how_to),
    materials: strList(r.materials),
    setting: lower(r.setting) as ActivityDraft['setting'],
    energy: lower(r.energy) as ActivityDraft['energy'],
    senses: enumList(r.senses, SENSES),
    play_type: enumList(r.play_type, PLAY_TYPE),
    duration_min: int(r.duration_min),
    parent_role: lower(r.parent_role) as ActivityDraft['parent_role'],
    safety_notes: s(r.safety_notes),
    source_name: source.name,
    source_url: page.finalUrl,
    paid: bool(r.paid),
  };
}

/** Field order = data/sg_outings.json order. */
export function normalizeOuting(r: Raw, page: PageContext): OutingDraft {
  const min = Math.max(0, int(r.min_age_months));
  const max = Math.min(36, int(r.max_age_months));
  const paid = bool(r.paid);
  return {
    name: s(r.name),
    type: lower(r.type) as OutingDraft['type'],
    summary: s(r.summary),
    location: s(r.location),
    region: lower(r.region) as OutingDraft['region'],
    min_age_months: min,
    max_age_months: max,
    categories: enumList(r.categories, CATEGORY_IDS) as OutingDraft['categories'],
    play_type: enumList(r.play_type, PLAY_TYPE),
    setting: lower(r.setting) as OutingDraft['setting'],
    rain_ok: bool(r.rain_ok),
    price_note: s(r.price_note) || (paid ? '' : 'Free.'),
    booking_required: bool(r.booking_required),
    start_date: isoOrNull(r.start_date),
    end_date: isoOrNull(r.end_date),
    recurrence: nullableStr(r.recurrence),
    dates_confirmed: bool(r.dates_confirmed),
    url: page.finalUrl,
    notes: s(r.notes),
    paid,
  };
}
