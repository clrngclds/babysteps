'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { Milestone } from '@/lib/types';
import { CATEGORIES } from '@/lib/types';
import { CAT_CLASS, CAT_EMOJI, CAT_LABEL } from '@/lib/labels';

/** "Coming up by N months" (SDD BM-2a, BM-3): milestones for the current or next checkpoint, grouped by category. */
export function MilestonesCard({ month, checkpoint, milestones }: { month: number; checkpoint: number; milestones: Milestone[] }) {
  const [all, setAll] = useState(false);
  const list = milestones.filter((m) => m.month === checkpoint);
  const title = month < checkpoint ? `Coming up by ${checkpoint} months` : `Milestones by ${checkpoint} months`;
  // collapsed: first milestone of each category (max 5)
  const shown = all ? list : CATEGORIES.map((c) => list.find((m) => m.category === c)).filter((m): m is Milestone => !!m).slice(0, 5);
  const groups = CATEGORIES.map((c) => ({ c, items: shown.filter((m) => m.category === c) })).filter((g) => g.items.length);

  return (
    <section className="card" aria-labelledby="ms-card-title">
      <h2 className="sec" id="ms-card-title">
        {title}
        {list.length > shown.length || all ? (
          <button type="button" className="linkbtn" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? 'Show less' : `See all ${list.length}`}
          </button>
        ) : null}
      </h2>
      {groups.map(({ c, items }) => (
        <div className="msgroup" key={c}>
          {all && <h3>{CAT_LABEL[c]}</h3>}
          {items.map((m) => (
            <Link key={m.id} href={`/milestone/?id=${m.id}`} className="ms">
              <span className={`dot c-${CAT_CLASS[m.category]}`} aria-hidden="true">{CAT_EMOJI[m.category]}</span>
              <span>{m.text}</span>
            </Link>
          ))}
        </div>
      ))}
      {!list.length && <p className="muted">No CDC checkpoint for this month.</p>}
    </section>
  );
}
