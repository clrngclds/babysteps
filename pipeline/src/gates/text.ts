/**
 * Text helpers shared by the gates: normalisation (so quote/dash/space variants compare equal),
 * tokens, title keywords and a title/summary similarity score for duplicate detection (G6).
 */

const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff\u00ad]/g;
const SINGLE_QUOTES = /[\u2018\u2019\u201a\u201b\u2032\u02bc\u0060\u00b4]/g;
const DOUBLE_QUOTES = /[\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb]/g;
const DASHES = /[\u2010-\u2015\u2212\u2e3a\u2e3b\ufe58\ufe63\uff0d]/g;
const SPACES = /[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;

/**
 * Lowercase; curly quotes, dashes, ellipsis and non-breaking/odd spaces -> ASCII; zero-width
 * characters and soft hyphens removed; accents stripped ("purée" -> "puree"); whitespace collapsed.
 * Both sides of every comparison go through this, so it only needs to be consistent, not pretty.
 */
export function normalizeText(s: string): string {
  if (!s) return '';
  return s
    .replace(ZERO_WIDTH, '')
    .replace(/\u2026/g, '...')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, '-')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(SPACES, ' ')
    .toLowerCase()
    .trim();
}

/** Words (letters/digits, inner apostrophes kept: "child's") of the normalised text. Punctuation is dropped. */
export function tokens(s: string): string[] {
  return normalizeText(s).match(/[a-z0-9]+(?:'[a-z0-9]+)*/g) ?? [];
}

/**
 * Function words plus words that appear in almost every activity title ("baby", "play", "activity")
 * or only soften it ("first", "simple", "new"), which would otherwise make unrelated titles look alike
 * and rewordings ("Open cup sips" / "First sips from an open cup") look different.
 */
export const STOPWORDS = new Set(
  (
    'a an and are as at be but by can for from has have how in into is it its of off on onto or our out over ' +
    'so than that the their them then there these they this those through to too up us use using was we were ' +
    'what when where which while who why will with without you your yours his her hers him she he i me my ' +
    'all any each every few more most other some such no not only own same just also very about after before ' +
    "again around do does doing done get gets let lets make makes it's let's " +
    'baby babies babys toddler toddlers toddlers little play plays playing activity activities game games ' +
    'fun easy simple quick first new mini idea ideas month months old year years'
  ).split(/\s+/),
);

/** Light plural/possessive folding so "blocks"/"block", "berries"/"berry", "child's"/"child" compare equal. */
export function stem(w: string): string {
  let s = w.replace(/'s$/, '').replace(/'/g, '');
  if (s.length > 4 && s.endsWith('ies')) s = s.slice(0, -3) + 'y';
  else if (s.length > 4 && /(ss|x|ch|sh)es$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  return s;
}

/** Content words of a title: no stopwords, nothing shorter than 3 letters, de-duplicated, in order. */
export function keywords(title: string): string[] {
  const out: string[] = [];
  for (const t of tokens(title)) {
    const w = t.replace(/'s$/, '');
    if (w.length < 3 || STOPWORDS.has(w) || STOPWORDS.has(t) || /^\d+$/.test(w)) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

function contentStems(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokens(s)) {
    const w = t.replace(/'s$/, '');
    if (w.length < 2 || STOPWORDS.has(w) || STOPWORDS.has(t)) continue;
    out.add(stem(w));
  }
  return out;
}

function trigrams(s: string): Set<string> {
  const clean = ` ${tokens(s).join(' ')} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= clean.length; i++) out.add(clean.slice(i, i + 3));
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

/**
 * Similarity in [0, 1] = max of two scores:
 *  - Jaccard of content-word sets (stopwords removed, plurals folded). Catches reordered rewordings:
 *    "Laundry basket sleigh ride" vs "Sleigh ride in a laundry basket" = 1.0.
 *  - Dice coefficient of character trigrams over the normalised words. Catches near-identical strings
 *    that word sets score low, e.g. one-letter edits ("Peg and cup" vs "Egg and cup" = 0.73, still < 0.8).
 * G6 treats >= 0.8 as a duplicate. Two different activities that share a theme
 * ("Treasure basket of kitchen items" vs "Treasure basket of natural items") stay well below that;
 * tests/pipeline/gates.test.ts pins pairs from the real dataset.
 */
export function similarity(a: string, b: string): number {
  const na = tokens(a).join(' ');
  const nb = tokens(b).join(' ');
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const wa = contentStems(a);
  const wb = contentStems(b);
  const union = wa.size + wb.size - overlap(wa, wb);
  const jaccard = union ? overlap(wa, wb) / union : 0;
  const ta = trigrams(a);
  const tb = trigrams(b);
  const dice = ta.size + tb.size ? (2 * overlap(ta, tb)) / (ta.size + tb.size) : 0;
  return Math.max(jaccard, dice);
}
