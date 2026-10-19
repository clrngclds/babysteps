'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useCatalog } from './AppProvider';
import { CloseIcon } from './icons';
import { CAT_CLASS, CAT_EMOJI, CAT_LABEL, REGION_LABEL } from '@/lib/labels';
import { activityEmoji, outingEmoji } from '@/lib/emoji';
import { buildIndex, type SearchIndex, type GroupedResults } from '@/lib/search';

const PER_GROUP = 6;

/**
 * Header search (SDD §3.7). The query lives only in this component's memory:
 * it is not put in the URL, not stored, and not sent anywhere.
 */
export default function SearchOverlay({ onClose }: { onClose: () => void }) {
  const { catalog } = useCatalog();
  const { age } = useApp();
  const [q, setQ] = useState('');
  const [more, setMore] = useState<Record<string, boolean>>({});
  const input = useRef<HTMLInputElement>(null);

  const index: SearchIndex | null = useMemo(
    () => (catalog ? buildIndex({ activities: catalog.activities, milestones: catalog.milestones, outings: catalog.outings }) : null),
    [catalog],
  );
  const res: GroupedResults = useMemo(
    () => (index ? index.search(q, age?.months ?? null) : { milestones: [], activities: [], outings: [] }),
    [index, q, age],
  );

  useEffect(() => {
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const o = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = o; };
  }, [onClose]);

  const total = res.milestones.length + res.activities.length + res.outings.length;
  const slice = <T,>(k: string, l: T[]) => (more[k] ? l : l.slice(0, PER_GROUP));
  const moreBtn = (k: string, n: number) =>
    n > PER_GROUP && !more[k] ? (
      <button type="button" className="linkbtn" onClick={() => setMore((m) => ({ ...m, [k]: true }))}>Show all {n}</button>
    ) : null;

  return (
    <div className="search-ov" role="dialog" aria-modal="true" aria-label="Search" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="search-panel">
        <div className="search-bar">
          <label htmlFor="q" className="sr-only">Search activities, milestones, outings</label>
          <input
            id="q"
            ref={input}
            type="search"
            inputMode="search"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Search activities, milestones, outings"
            value={q}
            onChange={(e) => { setQ(e.target.value); setMore({}); }}
          />
          <button type="button" className="heart" aria-label="Close search" onClick={onClose} style={{ color: 'var(--ink)' }}>
            <CloseIcon />
          </button>
        </div>
        <div className="search-res" aria-live="polite" onClick={(e) => { if ((e.target as HTMLElement).closest('a')) onClose(); }}>
          {!catalog && <p className="empty">Loading…</p>}
          {catalog && !q.trim() && (
            <p className="empty">Try “crawl”, “water”, “blocks”, “library” or “zoo”. Works offline.</p>
          )}
          {catalog && q.trim() && total === 0 && <p className="empty">No matches for “{q.trim()}”.</p>}

          {res.milestones.length > 0 && (
            <section>
              <h2>Milestones <span className="meta">({res.milestones.length})</span></h2>
              {slice('m', res.milestones).map((m) => (
                <Link key={m.id} href={`/milestone/?id=${m.id}`} className="rrow">
                  <span className={`dot c-${CAT_CLASS[m.category]}`} aria-hidden="true">{CAT_EMOJI[m.category]}</span>
                  <span><span className="t">{m.text}</span><br /><span className="meta">{CAT_LABEL[m.category]} · by {m.month} months</span></span>
                </Link>
              ))}
              {moreBtn('m', res.milestones.length)}
            </section>
          )}
          {res.activities.length > 0 && (
            <section>
              <h2>Activities <span className="meta">({res.activities.length})</span></h2>
              {slice('a', res.activities).map((a) => (
                <Link key={a.id} href={`/activity/?id=${a.id}`} className="rrow">
                  <span className={`dot c-${CAT_CLASS[a.category]}`} aria-hidden="true">{activityEmoji(a)}</span>
                  <span><span className="t">{a.title}</span><br /><span className="meta">{a.month} months · {CAT_LABEL[a.category]}</span></span>
                </Link>
              ))}
              {moreBtn('a', res.activities.length)}
            </section>
          )}
          {res.outings.length > 0 && (
            <section>
              <h2>Outings <span className="meta">({res.outings.length})</span></h2>
              {slice('o', res.outings).map((o) => (
                <Link key={o.id} href={`/outing/?id=${o.id}`} className="rrow">
                  <span className="dot c-lang" aria-hidden="true">{outingEmoji(o)}</span>
                  <span><span className="t">{o.name}</span><br /><span className="meta">{REGION_LABEL[o.region]}{o.paid ? ' · ' : ''}</span>{o.paid && <span className="paid">Paid</span>}</span>
                </Link>
              ))}
              {moreBtn('o', res.outings.length)}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
