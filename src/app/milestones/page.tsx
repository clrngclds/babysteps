'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useApp, useCatalog } from '@/components/AppProvider';
import { PageHeader } from '@/components/PageHeader';
import { PageSkeleton } from '@/components/Shell';
import { Disclaimer } from '@/components/Disclaimer';
import { Sheet } from '@/components/Sheet';
import { CATEGORIES, type Milestone } from '@/lib/types';
import { CAT_CLASS, CAT_EMOJI, CAT_LABEL } from '@/lib/labels';
import { pickCheckpoints, viewForCheckpoint } from '@/lib/checkpoints';

type Cat = (typeof CATEGORIES)[number];

function byArea(list: Milestone[]): [Cat, Milestone[]][] {
  return CATEGORIES.map((c) => [c, list.filter((m) => m.category === c)] as [Cat, Milestone[]]).filter(([, l]) => l.length);
}

/** Milestones page (SDD BMi-1, v0.4): "Working on now" + "Coming next", earlier and other ages collapsed. */
export default function MilestonesPage() {
  const { catalog, error } = useCatalog();
  const { age, state, toggleSeen } = useApp();
  const [chosen, setChosen] = useState<number | null>(null);
  const [showNextAll, setShowNextAll] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);
  const [browse, setBrowse] = useState(false);
  if (!catalog) return error ? <p className="note">Couldn&apos;t load milestones. Check your connection.</p> : <PageSkeleton />;

  const cps = catalog.milestonesFile.checkpoints_months;
  const childView = pickCheckpoints(cps, age?.months ?? 0);
  const view = chosen == null ? childView : viewForCheckpoint(cps, chosen);
  const at = (cp: number) => catalog.milestones.filter((m) => m.month === cp);
  const seen = (id: string) => state.milestonesSeen.includes(id);

  const row = (m: Milestone, withToggle: boolean) => {
    const s = seen(m.id);
    return (
      <div key={m.id} className={`mrow2${s ? ' seen' : ''}`}>
        <Link href={`/milestone/?id=${m.id}`} className="mlink">
          <span>{m.text}</span>
          <span className="chev" aria-hidden="true">›</span>
        </Link>
        {withToggle && (
          <button type="button" className={`seenbtn${s ? ' on' : ''}`} aria-pressed={s} aria-label={s ? `Seen: ${m.text}. Tap to undo` : `Mark as seen: ${m.text}`} onClick={() => toggleSeen(m.id)}>
            <span aria-hidden="true">✓</span>
          </button>
        )}
      </div>
    );
  };

  const nowList = at(view.current);
  const nextList = view.next != null ? at(view.next) : [];

  return (
    <div className="mpage">
      <PageHeader title="Milestones" sub="Baby steps in your child’s development" />
      {chosen != null && (
        <p className="backto">
          <button type="button" className="textbtn" onClick={() => setChosen(null)}>‹ Back to {age?.months ?? 0} months</button>
        </p>
      )}

      <div className="mgrid">
        <section className="card mnow" aria-labelledby="mnow-h">
          <h2 id="mnow-h" className="mhead"><span className="mkicker">{chosen == null ? 'Working on now' : 'Milestones'}</span> by {view.current} months</h2>
          {byArea(nowList).map(([c, list]) => (
            <div key={c} className="agrp">
              <h3 className="ahead">
                <span className={`dot c-${CAT_CLASS[c]}`} aria-hidden="true">{CAT_EMOJI[c]}</span>
                <span>{CAT_LABEL[c]}</span>
                <span className="acount">{list.filter((m) => seen(m.id)).length} of {list.length} seen</span>
              </h3>
              {list.map((m) => row(m, true))}
            </div>
          ))}
        </section>

        {view.next != null && (
          <section className="mnext" aria-labelledby="mnext-h">
            <h2 id="mnext-h" className="mhead"><span className="mkicker">Coming next</span> by {view.next} months</h2>
            {byArea(nextList).map(([c, list]) => (
              <div key={c} className="agrp">
                <h3 className="ahead">
                  <span className={`dot c-${CAT_CLASS[c]}`} aria-hidden="true">{CAT_EMOJI[c]}</span>
                  <span>{CAT_LABEL[c]}</span>
                  <span className="acount">{list.length}</span>
                </h3>
                {(showNextAll ? list : list.slice(0, 1)).map((m) => row(m, false))}
              </div>
            ))}
            <button type="button" className="textbtn" aria-expanded={showNextAll} onClick={() => setShowNextAll((v) => !v)}>
              {showNextAll ? 'Show less' : `Show all ${nextList.length}`}
            </button>
          </section>
        )}
      </div>

      <div className="mmore">
        {view.earlier.length > 0 && (
          <button type="button" className="textbtn" aria-expanded={showEarlier} onClick={() => setShowEarlier((v) => !v)}>
            {showEarlier ? 'Hide earlier milestones' : 'Earlier milestones'}
          </button>
        )}
        <button type="button" className="textbtn" onClick={() => setBrowse(true)}>Browse other ages</button>
      </div>

      {showEarlier && (
        <section className="mearlier" aria-label="Earlier milestones">
          {view.earlier.map((cp) => (
            <div key={cp} className="agrp">
              <h3 className="ahead"><span>By {cp} months</span></h3>
              {at(cp).map((m) => row(m, true))}
            </div>
          ))}
        </section>
      )}

      {browse && (
        <Sheet title="Browse other ages" onClose={() => setBrowse(false)}>
          <div className="cpchips">
            {cps.map((cp) => (
              <button
                key={cp}
                type="button"
                className={`chip${cp === view.current ? ' on' : ''}`}
                aria-pressed={cp === view.current}
                onClick={() => { setChosen(cp === childView.current ? null : cp); setShowNextAll(false); setShowEarlier(false); setBrowse(false); }}
              >
                <span>{cp} months</span>
              </button>
            ))}
          </div>
        </Sheet>
      )}

      <Disclaimer />
    </div>
  );
}
