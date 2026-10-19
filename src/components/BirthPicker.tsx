'use client';

import { useId, useState } from 'react';
import { MONTH_NAMES, formatBirth, nowSG, parseBirth, validateBirth, rawAgeMonths } from '@/lib/age';

interface Props {
  initial?: string | null;
  submitLabel: string;
  onSubmit: (birth: string) => void;
  onCancel?: () => void;
}

/** Two pickers: birth month + year (SDD CP-1). Rejects future dates (CP-5). */
export function BirthPicker({ initial, submitLabel, onSubmit, onCancel }: Props) {
  const now = nowSG();
  const init = parseBirth(initial ?? null);
  const [month, setMonth] = useState<string>(init ? String(init.month) : '');
  const [year, setYear] = useState<string>(init ? String(init.year) : '');
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  // 0–36 months plus a few extra years so older children can still be entered (content clamps at 36).
  const years = Array.from({ length: 6 }, (_, i) => now.year - i);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!month || !year) { setError('Pick a month and a year.'); return; }
    const ym = { year: Number(year), month: Number(month) };
    const err = validateBirth(ym, now);
    if (err === 'future') { setError('That date is in the future. Pick the month your child was born.'); return; }
    if (err) { setError('Pick a valid month and year.'); return; }
    setError(null);
    onSubmit(formatBirth(ym));
  };

  const ym = month && year ? { year: Number(year), month: Number(month) } : null;
  const over = ym && validateBirth(ym, now) === null && rawAgeMonths(ym, now) > 36;

  return (
    <form onSubmit={submit} noValidate>
      <div className="pickers">
        <div className="field">
          <label htmlFor={`${id}-m`}>Month</label>
          <select id={`${id}-m`} value={month} onChange={(e) => { setMonth(e.target.value); setError(null); }} aria-describedby={error ? `${id}-err` : undefined}>
            <option value="" disabled>Month</option>
            {MONTH_NAMES.map((n, i) => <option key={n} value={i + 1}>{n}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-y`}>Year</label>
          <select id={`${id}-y`} value={year} onChange={(e) => { setYear(e.target.value); setError(null); }} aria-describedby={error ? `${id}-err` : undefined}>
            <option value="" disabled>Year</option>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>
      {error && <p className="err" id={`${id}-err`} role="alert">{error}</p>}
      {over && !error && <p className="note" style={{ marginTop: 12 }}>baby steps covers 0–36 months. We&apos;ll show ideas for 36 months.</p>}
      <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
        {onCancel && <button type="button" className="btn secondary" onClick={onCancel} style={{ flex: 1 }}>Cancel</button>}
        <button type="submit" className="btn" style={{ flex: 2 }}>{submitLabel}</button>
      </div>
    </form>
  );
}
