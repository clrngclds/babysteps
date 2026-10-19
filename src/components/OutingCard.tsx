'use client';

import Link from 'next/link';
import type { Outing } from '@/lib/types';
import { REGION_LABEL } from '@/lib/labels';
import { dateLabel } from '@/lib/outings';
import { outingEmoji } from '@/lib/emoji';

/** Outing card: thumbnail, date, title, place, and Paid only when paid (SDD §3.8, §4.4). */
export function OutingCard({ o, today }: { o: Outing; today: string }) {
  return (
    <article className="card ev">
      <div className="thumb c-lang" aria-hidden="true">{outingEmoji(o)}</div>
      <div style={{ minWidth: 0 }}>
        <p className="date">{dateLabel(o, today)}{o.type === 'event' && !o.dates_confirmed ? ' · dates TBC' : ''}</p>
        <h4><Link href={`/outing/?id=${o.id}`}>{o.name}</Link></h4>
        <p className="meta">{o.location} · {REGION_LABEL[o.region]}</p>
        {o.paid && <p style={{ marginTop: 4 }}><span className="paid">Paid</span></p>}
      </div>
    </article>
  );
}

