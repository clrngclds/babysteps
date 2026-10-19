export const MAX_MONTHS = 36;
export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
export const MONTH_SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));

export interface YM {
  year: number;
  month: number; // 1-12
}

/** Current year/month in Asia/Singapore. */
export function nowSG(now: Date = new Date()): YM {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit' })
    .formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get('year'), month: get('month') };
}

/** Today's date in Singapore as YYYY-MM-DD. */
export function todaySG(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now);
}

export function parseBirth(birth: string | null | undefined): YM | null {
  if (!birth) return null;
  const m = /^(\d{4})-(\d{2})$/.exec(birth);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

export function formatBirth(ym: YM): string {
  return `${ym.year}-${String(ym.month).padStart(2, '0')}`;
}

/** Raw age in months (born month = month 0). Can be negative for future dates. */
export function rawAgeMonths(birth: YM, now: YM): number {
  return (now.year - birth.year) * 12 + (now.month - birth.month);
}

export interface AgeInfo {
  /** age used for content, clamped to 0..36 */
  months: number;
  /** true if the real age is over 36 months */
  over: boolean;
  raw: number;
}

export function ageInfo(birth: YM, now: YM = nowSG()): AgeInfo {
  const raw = rawAgeMonths(birth, now);
  return { raw, months: Math.max(0, Math.min(MAX_MONTHS, raw)), over: raw > MAX_MONTHS };
}

export type BirthError = 'future' | 'invalid' | null;

export function validateBirth(birth: YM, now: YM = nowSG()): BirthError {
  if (!Number.isInteger(birth.year) || !Number.isInteger(birth.month) || birth.month < 1 || birth.month > 12) return 'invalid';
  if (rawAgeMonths(birth, now) < 0) return 'future';
  return null;
}

/** "June 2025" */
export function birthLabel(ym: YM, short = false): string {
  return `${(short ? MONTH_SHORT : MONTH_NAMES)[ym.month - 1]} ${ym.year}`;
}

export function monthsLabel(n: number): string {
  return `${n} month${n === 1 ? '' : 's'}`;
}
