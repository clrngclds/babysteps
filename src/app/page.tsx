'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '@/components/AppProvider';
import { PageHeader } from '@/components/PageHeader';
import { MonthStrip } from '@/components/MonthStrip';
import { MilestonesCard } from '@/components/MilestonesCard';
import { ActivityCard } from '@/components/ActivityCard';
import { FiltersSheet } from '@/components/FiltersSheet';
import { FilterIcon } from '@/components/icons';
import { CATEGORIES, type ByMonthFile } from '@/lib/types';
import { CAT_CHIP, CAT_EMOJI, CAT_LABEL } from '@/lib/labels';
import { activeFilterCount, DEFAULT_FILTERS, filterActivities, filterSummary } from '@/lib/filters';
import { birthLabel, monthsLabel, todaySG } from '@/lib/age';
import { filterOutings, dateLabel } from '@/lib/outings';
import { outingEmoji } from '@/lib/emoji';

export default function PlaytimePage() {
  const { age, birth, viewMonth, setViewMonth, category, setCategory, state, setFilters, getMonth, catalog } = useApp();
  const ageM = age?.months ?? 0;
  const month = viewMonth ?? ageM;
  const [data, setData] = useState<ByMonthFile | null>(null);
  const [failed, setFailed] = useState(false);
  const [sheet, setSheet] = useState(false);
  const filters = state.filters;

  useEffect(() => {
    let alive = true;
    setFailed(false);
    getMonth(month).then((d) => alive && setData(d)).catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, [month, getMonth]);

  const current = data && data.month === month ? data : null;
  const acts = useMemo(() => (current ? filterActivities(current.activities, filters, category) : []), [current, filters, category]);
  const nFilters = activeFilterCount(filters);
  const summary = filterSummary(filters);

  const weekend = useMemo(() => {
    if (!catalog) return [];
    return filterOutings(catalog.outings, { age: ageM, today: todaySG(), weekend: true, rainOk: false, region: 'all', hidePaid: filters.hidePaid })
      .filter((o) => o.type !== 'venue')
      .slice(0, 3);
  }, [catalog, ageM, filters.hidePaid]);

  const sub = (
    <>
      {birth ? `Born ${birthLabel(birth)}` : ''}
      {current ? ` · ${current.activities.length} play ideas this month` : ''}
    </>
  );

  return (
    <>
      <PageHeader title={monthsLabel(month)} sub={sub} />
      {age?.over && (
        <p className="note" style={{ marginBottom: 12 }}>baby steps covers 0–36 months, so we&apos;re showing ideas for 36 months.</p>
      )}
      <MonthStrip value={month} age={ageM} onChange={(m) => setViewMonth(m === ageM ? null : m)} />
      {month !== ageM && (
        <p className="meta" style={{ marginTop: -6, marginBottom: 6 }}>
          Viewing {monthsLabel(month)}.{' '}
          <button type="button" className="linkbtn" onClick={() => setViewMonth(null)}>Back to {monthsLabel(ageM)}</button>
        </p>
      )}

      {failed && !current && <p className="note">Couldn&apos;t load this month. Check your connection and try again.</p>}
      {!current && !failed && (
        <div className="today-grid">
          <div className="skeleton" style={{ height: 230, marginBottom: 12 }} />
          <div><div className="skeleton" style={{ height: 80, marginBottom: 10 }} /><div className="skeleton" style={{ height: 80 }} /></div>
        </div>
      )}

      {current && (
        <div className="today-grid">
          <div className="col-ms">
            <MilestonesCard month={month} checkpoint={current.checkpoint} milestones={current.milestones} />
            {weekend.length > 0 && (
              <section className="card wide-only" aria-labelledby="wk-title">
                <h2 className="sec" id="wk-title">Out &amp; about this weekend <Link href="/outings/">All</Link></h2>
                {weekend.map((o) => (
                  <Link key={o.id} href={`/outing/?id=${o.id}`} className="ms">
                    <span className="dot c-lang" aria-hidden="true">{outingEmoji(o)}</span>
                    <span>{o.name} <span className="meta">· {dateLabel(o, todaySG())}</span></span>
                  </Link>
                ))}
              </section>
            )}
          </div>

          <div className="col-acts">
            <div className="chips" role="group" aria-label="Category and filters">
              <button type="button" className="chip filters" onClick={() => setSheet(true)} aria-haspopup="dialog">
                <span><FilterIcon /> Filters{nFilters ? ` (${nFilters})` : ''}<span className="wide-only-inline">{summary ? ` · ${summary}` : ''}</span></span>
              </button>
              <button type="button" className="chip" aria-pressed={category === 'all'} onClick={() => setCategory('all')}><span>All</span></button>
              {CATEGORIES.map((c) => (
                <button key={c} type="button" className="chip" aria-pressed={category === c} onClick={() => setCategory(category === c ? 'all' : c)}>
                  <span><span aria-hidden="true">{CAT_EMOJI[c]}</span> {CAT_CHIP[c]}</span>
                </button>
              ))}
            </div>

            {acts.length === 0 && (
              <div className="empty">
                <p>No play ideas match these filters for {monthsLabel(month)}.</p>
                <button type="button" className="btn secondary" style={{ marginTop: 12 }} onClick={() => { setFilters({ ...DEFAULT_FILTERS }); setCategory('all'); }}>
                  Clear filters
                </button>
              </div>
            )}

            {CATEGORIES.filter((c) => category === 'all' || c === category).map((c) => {
              const list = acts.filter((a) => a.category === c);
              if (!list.length) return null;
              return (
                <details key={`${month}-${c}`} className="catsec" open>
                  <summary>
                    <span aria-hidden="true">{CAT_EMOJI[c]}</span> {CAT_LABEL[c]} <span className="count">({list.length})</span>
                    <span className="chev" aria-hidden="true">›</span>
                  </summary>
                  <div className="agrid">
                    {list.map((a) => <ActivityCard key={a.id} a={a} />)}
                  </div>
                </details>
              );
            })}
          </div>
        </div>
      )}

      {sheet && current && (
        <FiltersSheet
          value={filters}
          onApply={setFilters}
          onClose={() => setSheet(false)}
          countFor={(f) => filterActivities(current.activities, f, category).length}
        />
      )}
    </>
  );
}
