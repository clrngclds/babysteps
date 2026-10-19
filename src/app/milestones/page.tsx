'use client';

import Link from 'next/link';
import { useApp, useCatalog } from '@/components/AppProvider';
import { PageHeader } from '@/components/PageHeader';
import { PageSkeleton } from '@/components/Shell';
import { Disclaimer } from '@/components/Disclaimer';
import { CATEGORIES } from '@/lib/types';
import { CAT_CHIP, CAT_CLASS, CAT_EMOJI, CAT_LABEL } from '@/lib/labels';

/** Milestone index grouped by category, then checkpoint age (SDD BMi-1). */
export default function MilestonesPage() {
  const { catalog, error } = useCatalog();
  const { age, state } = useApp();
  if (!catalog) return error ? <p className="note">Couldn&apos;t load milestones. Check your connection.</p> : <PageSkeleton />;
  const cps = catalog.milestonesFile.checkpoints_months;
  const ageM = age?.months ?? 0;
  const nextCp = cps.find((c) => c >= ageM) ?? 36;
  const cats = CATEGORIES.filter((c) => catalog.milestones.some((m) => m.category === c));

  return (
    <div className="narrow mindex">
      <PageHeader title="Milestones" sub={`CDC checklists · next checkpoint for your child: ${nextCp} months`} />
      <nav className="chips" aria-label="Jump to category">
        {cats.map((c) => (
          <a key={c} href={`#cat-${c}`} className="chip" style={{ textDecoration: 'none' }}>
            <span><span aria-hidden="true">{CAT_EMOJI[c]}</span> {CAT_CHIP[c]}</span>
          </a>
        ))}
      </nav>
      {cats.map((c) => (
        <section key={c} id={`cat-${c}`} className="card" style={{ scrollMarginTop: 90 }}>
          <h2 className="sec"><span><span aria-hidden="true">{CAT_EMOJI[c]}</span> {CAT_LABEL[c]}</span></h2>
          {cps.map((cp) => {
            const list = catalog.milestones.filter((m) => m.category === c && m.month === cp);
            if (!list.length) return null;
            return (
              <div key={cp}>
                <h3 className="cp">By {cp} months{cp === nextCp ? ' · coming up' : ''}</h3>
                {list.map((m) => {
                  const seen = state.milestonesSeen.includes(m.id);
                  return (
                    <Link key={m.id} href={`/milestone/?id=${m.id}`} className={`mrow${seen ? ' seen' : ''}`}>
                      <span className={`dot c-${CAT_CLASS[c]}`} aria-hidden="true">{seen ? '✓' : CAT_EMOJI[c]}</span>
                      <span>{m.text}{seen && <span className="sr-only"> (seen)</span>}</span>
                      <span className="chev" aria-hidden="true">›</span>
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </section>
      ))}
      <Disclaimer />
    </div>
  );
}
