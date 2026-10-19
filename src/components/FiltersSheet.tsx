'use client';

import { useState } from 'react';
import { DEFAULT_FILTERS, type Filters } from '@/lib/filters';
import { Sheet } from './Sheet';

type Opt<K extends keyof Filters> = { v: Filters[K]; label: string };

const SETTING: Opt<'setting'>[] = [
  { v: 'any', label: 'Any' }, { v: 'indoor', label: 'Indoor' }, { v: 'outdoor', label: 'Outdoor' },
];
const ENERGY: Opt<'energy'>[] = [
  { v: 'any', label: 'Any' }, { v: 'calm', label: 'Calm' }, { v: 'moderate', label: 'Moderate' }, { v: 'active', label: 'Active' },
];
const DURATION: Opt<'duration'>[] = [
  { v: 'any', label: 'Any' }, { v: 'le5', label: '≤5 min' }, { v: 'le15', label: '≤15 min' }, { v: 'ge15', label: '15+ min' },
];

interface Props {
  value: Filters;
  onApply: (f: Filters) => void;
  onClose: () => void;
  /** live count of matching activities for the draft filters */
  countFor?: (f: Filters) => number;
  /** outings only use Hide paid */
  paidOnly?: boolean;
}

export function FiltersSheet({ value, onApply, onClose, countFor, paidOnly }: Props) {
  const [draft, setDraft] = useState<Filters>(value);
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const group = <K extends 'setting' | 'energy' | 'duration'>(k: K, legend: string, opts: Opt<K>[]) => (
    <fieldset>
      <legend>{legend}</legend>
      <div className="seg-row">
        {opts.map((o) => (
          <button key={String(o.v)} type="button" className="chip" aria-pressed={draft[k] === o.v} onClick={() => set(k, o.v)}>
            <span>{o.label}</span>
          </button>
        ))}
      </div>
    </fieldset>
  );

  const n = countFor?.(draft);
  return (
    <Sheet title="Filters" onClose={onClose}>
      {!paidOnly && (
        <>
          {group('setting', 'Where', SETTING)}
          {group('energy', 'Energy', ENERGY)}
          {group('duration', 'How long', DURATION)}
        </>
      )}
      <div className="toggle-row">
        <div id="hidepaid-l">
          <strong>Hide paid</strong>
          <small>Hides activities that need a bought product and outings with a ticket or fee.</small>
        </div>
        <button type="button" role="switch" className="switch" aria-checked={draft.hidePaid} aria-labelledby="hidepaid-l" onClick={() => set('hidePaid', !draft.hidePaid)} />
      </div>
      <div className="sheet-actions">
        <button type="button" className="btn secondary" onClick={() => setDraft(paidOnly ? { ...draft, hidePaid: false } : { ...DEFAULT_FILTERS })}>Reset</button>
        <button type="button" className="btn" onClick={() => { onApply(draft); onClose(); }}>
          {n === undefined ? 'Apply' : `Show ${n} ${n === 1 ? 'idea' : 'ideas'}`}
        </button>
      </div>
    </Sheet>
  );
}
