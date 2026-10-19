'use client';

import { useMemo, useState } from 'react';
import { useApp, useCatalog } from '@/components/AppProvider';
import { PageHeader } from '@/components/PageHeader';
import { PageSkeleton } from '@/components/Shell';
import { REGIONS, type Region } from '@/lib/types';
import { OutingCard } from '@/components/OutingCard';
import { REGION_LABEL } from '@/lib/labels';
import { filterOutings, weekendRange } from '@/lib/outings';
import { monthsLabel, todaySG } from '@/lib/age';

export default function OutingsPage() {
  const { catalog, error } = useCatalog();
  const { age, state, setFilters } = useApp();
  const [weekend, setWeekend] = useState(false);
  const [rainOk, setRainOk] = useState(false);
  const [region, setRegion] = useState<Region | 'all'>('all');
  const today = todaySG();
  const ageM = age?.months ?? 0;
  const hidePaid = state.filters.hidePaid;

  const list = useMemo(
    () => (catalog ? filterOutings(catalog.outings, { age: ageM, today, weekend, rainOk, region, hidePaid }) : []),
    [catalog, ageM, today, weekend, rainOk, region, hidePaid],
  );
  if (!catalog) return error ? <p className="note">Couldn&apos;t load outings. Check your connection.</p> : <PageSkeleton />;

  const [sat, sun] = weekendRange(today);
  const events = list.filter((o) => o.type !== 'venue');
  const venues = list.filter((o) => o.type === 'venue');

  return (
    <div className="narrow">
      <PageHeader title="Outings" sub={`Singapore · for ${monthsLabel(ageM)}`} />
      <div className="chips" role="group" aria-label="Outing filters">
        <button type="button" className="chip" aria-pressed={weekend} onClick={() => setWeekend(!weekend)}><span>This weekend</span></button>
        <button type="button" className="chip" aria-pressed={rainOk} onClick={() => setRainOk(!rainOk)}><span><span aria-hidden="true">☂️</span> Rain-OK</span></button>
        <label className="chip">
          <span className="sr-only">Region</span>
          <select value={region} className={region !== 'all' ? 'on' : ''} onChange={(e) => setRegion(e.target.value as Region | 'all')}>
            <option value="all">Region</option>
            {REGIONS.map((r) => <option key={r} value={r}>{REGION_LABEL[r]}</option>)}
          </select>
        </label>
        <button type="button" className="chip" aria-pressed={hidePaid} onClick={() => setFilters({ ...state.filters, hidePaid: !hidePaid })}><span>Hide paid</span></button>
      </div>
      {weekend && <p className="meta" style={{ margin: '4px 0 8px' }}>Showing what&apos;s on {sat === sun ? 'today' : `Sat ${+sat.slice(8)} – Sun ${+sun.slice(8)}`}, plus places open most days.</p>}

      {list.length === 0 && <p className="empty">Nothing matches these filters. Try another region or turn a filter off.</p>}
      {events.length > 0 && (
        <>
          <h2 className="sec">Events and programmes</h2>
          {events.map((o) => <OutingCard key={o.id} o={o} today={today} />)}
        </>
      )}
      {venues.length > 0 && (
        <>
          <h2 className="sec">Places to go</h2>
          {venues.map((o) => <OutingCard key={o.id} o={o} today={today} />)}
        </>
      )}
      <p className="meta" style={{ marginTop: 16 }}>Past events are hidden automatically. Check the official page before you go.</p>
    </div>
  );
}
