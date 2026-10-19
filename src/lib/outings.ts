import type { Outing, Region } from './types';

const DAY = 86_400_000;
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const toUTC = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const fromUTC = (t: number) => new Date(t).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => fromUTC(toUTC(d) + n * DAY);
const weekday = (d: string) => new Date(toUTC(d)).getUTCDay();
const dm = (d: string) => `${+d.slice(8, 10)} ${MON[+d.slice(5, 7) - 1]}`;

/** The coming (or current) Saturday–Sunday for a SG date string. */
export function weekendRange(today: string): [string, string] {
  const wd = weekday(today);
  if (wd === 6) return [today, addDays(today, 1)];
  if (wd === 0) return [today, today];
  const sat = addDays(today, 6 - wd);
  return [sat, addDays(sat, 1)];
}

export function isPast(o: Outing, today: string): boolean {
  const end = o.end_date ?? o.start_date;
  return end !== null && end < today;
}

export function isThisWeekend(o: Outing, today: string): boolean {
  const [s, e] = weekendRange(today);
  if (o.type === 'venue') return true;
  if (o.type === 'programme') return /weekend|sat|sun/i.test(o.recurrence ?? '');
  if (!o.start_date) return false;
  const end = o.end_date ?? o.start_date;
  return o.start_date <= e && end >= s;
}

export function fitsAge(o: Outing, age: number): boolean {
  return o.min_age_months <= age && age <= o.max_age_months;
}

export interface OutingFilter {
  age: number;
  today: string;
  weekend: boolean;
  rainOk: boolean;
  region: Region | 'all';
  hidePaid: boolean;
}

const typeRank = { event: 0, programme: 1, venue: 2 } as const;

export function filterOutings(list: Outing[], f: OutingFilter): Outing[] {
  return list
    .filter(
      (o) =>
        !isPast(o, f.today) &&
        fitsAge(o, f.age) &&
        (!f.weekend || isThisWeekend(o, f.today)) &&
        (!f.rainOk || o.rain_ok) &&
        (f.region === 'all' || o.region === f.region) &&
        (!f.hidePaid || !o.paid),
    )
    .sort(
      (a, b) =>
        typeRank[a.type] - typeRank[b.type] ||
        (a.start_date ?? '').localeCompare(b.start_date ?? '') ||
        a.name.localeCompare(b.name),
    );
}

/** Short date line for cards, e.g. "Sat 21 Nov", "From 20 Nov", "Until 8 Nov", "Regular programme". */
export function dateLabel(o: Outing, today: string): string {
  if (o.type === 'venue') return 'Open most days';
  if (o.type === 'programme') return 'Regular programme';
  if (!o.start_date) return 'Dates to be confirmed';
  const end = o.end_date ?? o.start_date;
  if (end === o.start_date) return `${WD[weekday(o.start_date)]} ${dm(o.start_date)}`;
  const span = (toUTC(end) - toUTC(o.start_date)) / DAY;
  if (o.start_date <= today) return `Until ${dm(end)}`;
  if (span <= 3) return `${WD[weekday(o.start_date)]} ${dm(o.start_date)} – ${WD[weekday(end)]} ${dm(end)}`;
  return `From ${dm(o.start_date)}`;
}

/** Long date range for the detail page. */
export function dateRangeLong(o: Outing): string | null {
  if (!o.start_date) return null;
  const end = o.end_date ?? o.start_date;
  const f = (d: string) => `${WD[weekday(d)]} ${dm(d)} ${d.slice(0, 4)}`;
  return end === o.start_date ? f(o.start_date) : `${f(o.start_date)} – ${f(end)}`;
}
