'use client';

import Link from 'next/link';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useCatalog } from '@/components/AppProvider';
import { PageHeader } from '@/components/PageHeader';
import { PageSkeleton } from '@/components/Shell';
import { CAT_LABEL, REGION_LABEL } from '@/lib/labels';
import { outingEmoji } from '@/lib/emoji';
import { dateRangeLong, isPast } from '@/lib/outings';
import { todaySG } from '@/lib/age';

export default function OutingPage() {
  return <Suspense fallback={<PageSkeleton />}><OutingDetail /></Suspense>;
}

const TYPE_LABEL = { venue: 'Place to go', programme: 'Regular programme', event: 'Event' } as const;

function OutingDetail() {
  const id = useSearchParams().get('id') ?? '';
  const { catalog, error } = useCatalog();
  if (!catalog) return error ? <p className="note">Couldn&apos;t load outings. Check your connection.</p> : <PageSkeleton />;
  const o = catalog.outById.get(id);
  if (!o) {
    return (
      <>
        <PageHeader back={{ href: '/outings/', label: 'Outings' }} />
        <p className="empty">Outing not found. <Link href="/outings/">All outings</Link></p>
      </>
    );
  }
  const range = dateRangeLong(o);
  const past = isPast(o, todaySG());

  return (
    <div className="narrow">
      <PageHeader back={{ href: '/outings/', label: 'Outings' }} />
      <div className="dhero c-lang" aria-hidden="true">{outingEmoji(o)}</div>
      <p className="meta">{TYPE_LABEL[o.type]} · {REGION_LABEL[o.region]}</p>
      <h1 style={{ fontSize: 28, lineHeight: 1.15, margin: '4px 0 8px' }}>
        {o.name} {o.paid && <span className="paid" style={{ fontFamily: 'var(--font-body)' }}>Paid</span>}
      </h1>
      {past && <p className="note" style={{ marginBottom: 10 }}>This event has ended.</p>}
      <p>{o.summary}</p>

      <dl className="card" style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 14px', fontSize: 14 }}>
        {range && (<><dt className="muted">When</dt><dd style={{ margin: 0 }}>{range}{o.recurrence ? ` · ${o.recurrence}` : ''}</dd></>)}
        {!range && o.recurrence && (<><dt className="muted">When</dt><dd style={{ margin: 0 }}>{o.recurrence}</dd></>)}
        <dt className="muted">Where</dt><dd style={{ margin: 0 }}>{o.location}</dd>
        <dt className="muted">Ages</dt><dd style={{ margin: 0 }}>{o.min_age_months}–{o.max_age_months} months{o.max_age_months >= 36 ? '+' : ''}</dd>
        <dt className="muted">Weather</dt><dd style={{ margin: 0 }}>{o.rain_ok ? 'Rain-OK (indoor or covered)' : 'Outdoor, check the weather'}</dd>
        {o.booking_required && (<><dt className="muted">Booking</dt><dd style={{ margin: 0 }}>Booking required</dd></>)}
        {o.paid && o.price_note && (<><dt className="muted">Price</dt><dd style={{ margin: 0 }}>{o.price_note}</dd></>)}
        {o.categories.length > 0 && (<><dt className="muted">Good for</dt><dd style={{ margin: 0 }}>{o.categories.map((c) => CAT_LABEL[c]).join(', ')}</dd></>)}
      </dl>

      {o.type === 'event' && !o.dates_confirmed && (
        <p className="note" style={{ marginBottom: 12 }}>Dates are estimated from previous years. Check the official page before you go.</p>
      )}
      {o.notes && <p className="meta" style={{ marginBottom: 14 }}>{o.notes}</p>}

      <a className="btn block" href={o.url} target="_blank" rel="noopener noreferrer">Official page ↗</a>
      {o.last_verified && <p className="meta" style={{ marginTop: 10 }}>Last checked {o.last_verified}.</p>}
    </div>
  );
}
