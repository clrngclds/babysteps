'use client';

import { useEffect, useRef } from 'react';

/** Horizontal swipeable chip strip, months 0–36 (SDD BM-1). */
export function MonthStrip({ value, age, onChange }: { value: number; age: number; onChange: (m: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-m="${value}"]`);
    const box = ref.current;
    if (el && box) box.scrollTo({ left: el.offsetLeft - box.clientWidth / 2 + el.clientWidth / 2, behavior: 'auto' });
  }, [value]);
  return (
    <div className="months" ref={ref} role="group" aria-label="Choose a month of age">
      {Array.from({ length: 37 }, (_, m) => (
        <button
          key={m}
          data-m={m}
          type="button"
          className={`mchip${m === age ? ' age' : ''}`}
          aria-pressed={m === value}
          aria-label={`${m} months${m === age ? ' (your child)' : ''}`}
          onClick={() => onChange(m)}
        >
          <span>{m}</span>
        </button>
      ))}
    </div>
  );
}
