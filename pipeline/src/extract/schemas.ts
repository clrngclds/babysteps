/**
 * Vertex AI responseSchema objects (OpenAPI subset: type, properties, required, enum, items,
 * nullable, description, propertyOrdering). Vertex rejects other JSON-Schema keywords
 * ($ref, additionalProperties, oneOf, ...), so stay inside this subset.
 * Enums come from scripts/catalog-lib.ts so G1 and the model see the same allowed values.
 * propertyOrdering = field order of data/*.json records, so drafts serialise in the same order.
 */
import {
  CATEGORY_IDS,
  ENERGY,
  OUTING_TYPE,
  PARENT_ROLE,
  PHILOSOPHY,
  PLAY_TYPE,
  REGION,
  SENSES,
  SETTING,
} from '../../../scripts/catalog-lib';

type Schema = Record<string, unknown>;

const str = (description?: string): Schema => ({ type: 'STRING', ...(description ? { description } : {}) });
const int = (description?: string): Schema => ({ type: 'INTEGER', ...(description ? { description } : {}) });
const bool = (description?: string): Schema => ({ type: 'BOOLEAN', ...(description ? { description } : {}) });
const enumOf = (values: readonly string[], description?: string): Schema => ({ ...str(description), enum: [...values] });
const arr = (items: Schema, description?: string): Schema => ({ type: 'ARRAY', items, ...(description ? { description } : {}) });
const nullableStr = (description?: string): Schema => ({ ...str(description), nullable: true });

function obj(properties: Record<string, Schema>, required: string[] = Object.keys(properties)): Schema {
  return { type: 'OBJECT', properties, ...(required.length ? { required } : {}), propertyOrdering: Object.keys(properties) };
}

const QUOTE = str('8-40 words copied exactly (verbatim, same punctuation) from the page text that support this candidate.');

/** Activity fields in data/activities.json order (minus id/verified/lifecycle), then supporting_quote. */
export const ACTIVITY_CANDIDATE_SCHEMA: Schema = obj(
  {
    title: str('Short title in your own words.'),
    month: int('Single age in months, 0-36, that the activity suits best.'),
    category: enumOf(CATEGORY_IDS),
    philosophy: arr(enumOf(PHILOSOPHY)),
    milestone_ids: arr(str(), 'Ids from the milestone list for the current or next checkpoint; [] if none fit.'),
    summary: str('One plain sentence.'),
    how_to: str('2-4 short sentences.'),
    materials: arr(str()),
    setting: enumOf(SETTING),
    energy: enumOf(ENERGY),
    senses: arr(enumOf(SENSES)),
    play_type: arr(enumOf(PLAY_TYPE)),
    duration_min: int('Typical minutes.'),
    parent_role: enumOf(PARENT_ROLE),
    safety_notes: str('Empty string when nothing relevant.'),
    source_name: str(),
    source_url: str(),
    paid: bool('True only if a specific product must be bought.'),
    supporting_quote: QUOTE,
  },
);

/** Outing fields in data/sg_outings.json order (minus id/lifecycle/last_verified), then supporting_quote. */
export const OUTING_CANDIDATE_SCHEMA: Schema = obj({
  name: str(),
  type: enumOf(OUTING_TYPE),
  summary: str('One plain sentence.'),
  location: str('Venue name and address in Singapore.'),
  region: enumOf(REGION),
  min_age_months: int(),
  max_age_months: int(),
  categories: arr(enumOf(CATEGORY_IDS)),
  play_type: arr(enumOf(PLAY_TYPE)),
  setting: enumOf(SETTING),
  rain_ok: bool(),
  price_note: str(),
  booking_required: bool(),
  start_date: nullableStr('YYYY-MM-DD or null.'),
  end_date: nullableStr('YYYY-MM-DD or null.'),
  recurrence: nullableStr('e.g. "Sat 11am-12pm" or null.'),
  dates_confirmed: bool(),
  url: str(),
  notes: str(),
  paid: bool(),
  supporting_quote: QUOTE,
});

export const ACTIVITY_EXTRACTION_SCHEMA: Schema = obj({ candidates: arr(ACTIVITY_CANDIDATE_SCHEMA) });
export const OUTING_EXTRACTION_SCHEMA: Schema = obj({ candidates: arr(OUTING_CANDIDATE_SCHEMA) });

/** notes comes first so the model states its reasons before scoring (better calibrated with thinking off). */
export const REVIEW_SCHEMA: Schema = obj({
  notes: str('1-2 sentences: the main concern, or "ok".'),
  age_appropriate: int('1-5'),
  safety: int('1-5'),
  no_medical_claims: int('1-5'),
  not_product_only: int('1-5'),
});

export const VENUE_STATUS = ['unchanged', 'changed', 'closed', 'unclear'] as const;

export const VENUE_CHECK_SCHEMA: Schema = obj(
  {
    status: enumOf(VENUE_STATUS),
    changes: obj(
      {
        name: str(),
        summary: str(),
        location: str(),
        paid: bool(),
        price_note: str(),
        booking_required: bool(),
        url: str(),
      },
      [],
    ),
    reason: str('One sentence.'),
    supporting_quote: str('Verbatim sentence from the page that shows the change or closure; empty if unchanged.'),
  },
);
