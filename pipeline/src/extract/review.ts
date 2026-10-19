/**
 * G5 AI reviewer (SDD §8.4): a second Gemini call with a different persona scores the draft.
 * Publish only if every score >= 4.
 */
import type { Candidate, Llm, PageContext, ReviewScores } from '../types';
import { REVIEW_SYSTEM, reviewUserPrompt } from './prompts';
import { REVIEW_SCHEMA } from './schemas';

const EXCERPT_CHARS = 8_000;
const SCORE_KEYS = ['age_appropriate', 'safety', 'no_medical_claims', 'not_product_only'] as const;

/** Page excerpt centred on the supporting quote when it is found, else the start of the page. */
export function reviewExcerpt(text: string, quote: string, max = EXCERPT_CHARS): string {
  if (text.length <= max) return text;
  const i = quote ? text.indexOf(quote) : -1;
  const start = i < 0 ? 0 : Math.max(0, Math.min(i - Math.floor(max / 3), text.length - max));
  return text.slice(start, start + max);
}

const score = (v: unknown): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 1;
};

export async function reviewCandidate(llm: Llm, cand: Candidate, page: PageContext): Promise<ReviewScores> {
  const res = await llm.generateJson<Record<string, unknown>>({
    system: REVIEW_SYSTEM,
    prompt: reviewUserPrompt(JSON.stringify(cand.draft, null, 1), cand.kind, reviewExcerpt(page.text, cand.supporting_quote)),
    schema: REVIEW_SCHEMA,
    temperature: 0,
    purpose: 'review',
  });
  if (res.blocked || !res.data) {
    return { age_appropriate: 1, safety: 1, no_medical_claims: 1, not_product_only: 1, notes: 'blocked by safety filter' };
  }
  const d = res.data;
  return {
    age_appropriate: score(d.age_appropriate),
    safety: score(d.safety),
    no_medical_claims: score(d.no_medical_claims),
    not_product_only: score(d.not_product_only),
    notes: typeof d.notes === 'string' ? d.notes.trim() : '',
  };
}

export function reviewPasses(s: ReviewScores, min = 4): boolean {
  return SCORE_KEYS.every((k) => s[k] >= min);
}
