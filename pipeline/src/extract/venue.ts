/**
 * Monthly venue re-check (SDD §8.6): Gemini compares a stored Outing with its freshly fetched page
 * and reports renames, closures and price/booking changes the page states explicitly.
 */
import { sgtToday } from '../config';
import type { Llm, Outing, PageContext } from '../types';
import { truncateText } from './extract';
import { VENUE_SYSTEM, venueUserPrompt } from './prompts';
import { VENUE_CHECK_SCHEMA, VENUE_STATUS } from './schemas';

export type VenueStatus = (typeof VENUE_STATUS)[number];
export type VenueChanges = Partial<Pick<Outing, 'name' | 'summary' | 'location' | 'paid' | 'price_note' | 'booking_required' | 'url'>>;

export interface VenueCheck {
  status: VenueStatus;
  changes: VenueChanges;
  reason: string;
  supporting_quote: string;
}

const STRING_FIELDS = ['name', 'summary', 'location', 'price_note', 'url'] as const;
const BOOL_FIELDS = ['paid', 'booking_required'] as const;

const str = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

export async function compareVenue(llm: Llm, outing: Outing, page: PageContext, today: string = sgtToday()): Promise<VenueCheck> {
  const res = await llm.generateJson<Record<string, unknown>>({
    system: VENUE_SYSTEM,
    prompt: venueUserPrompt(outing, { finalUrl: page.finalUrl, title: page.title, text: truncateText(page.text) }, today),
    schema: VENUE_CHECK_SCHEMA,
    temperature: 0,
    purpose: 'venue',
  });
  if (res.blocked || !res.data) return { status: 'unclear', changes: {}, reason: 'blocked by safety filter', supporting_quote: '' };
  return normalizeVenueCheck(res.data, outing);
}

/** Dollar amounts in a price note, e.g. "S$55 / $43.50" -> {"55","43.5"}. */
function amounts(s: string): Set<string> {
  return new Set([...s.matchAll(/(?:S\$|\$)\s?(\d+(?:\.\d{1,2})?)/gi)].map((m) => String(Number(m[1]))));
}

/** Same dollar amounts (or both free with no amounts) = no real price change. */
export function samePrices(a: string, b: string): boolean {
  const x = amounts(a);
  const y = amounts(b);
  if (x.size === 0 && y.size === 0) return /\bfree\b/i.test(a) && /\bfree\b/i.test(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
}

/** Keep only well-typed fields that really differ from the stored entry. */
export function normalizeVenueCheck(d: Record<string, unknown>, outing: Outing): VenueCheck {
  let status: VenueStatus = (VENUE_STATUS as readonly string[]).includes(str(d.status)) ? (str(d.status) as VenueStatus) : 'unclear';
  const raw = (d.changes && typeof d.changes === 'object' ? d.changes : {}) as Record<string, unknown>;
  const changes: VenueChanges = {};
  if (status === 'changed') {
    for (const k of STRING_FIELDS) {
      const v = str(raw[k]);
      if (v && v !== outing[k]) changes[k] = v;
    }
    // The model tends to "update" price_note when the page merely restates the same prices.
    if (changes.price_note !== undefined && samePrices(changes.price_note, outing.price_note)) delete changes.price_note;
    for (const k of BOOL_FIELDS) {
      if (typeof raw[k] === 'boolean' && raw[k] !== outing[k]) changes[k] = raw[k] as boolean;
    }
    // "changed" with nothing that differs is a no-op.
    if (Object.keys(changes).length === 0) status = 'unchanged';
  }
  return { status, changes, reason: str(d.reason), supporting_quote: str(d.supporting_quote) };
}
