'use client';

import Link from 'next/link';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useApp, useCatalog } from '@/components/AppProvider';
import { PageHeader } from '@/components/PageHeader';
import { PageSkeleton } from '@/components/Shell';
import { Disclaimer } from '@/components/Disclaimer';
import { CAT_CLASS, CAT_EMOJI, CAT_LABEL } from '@/lib/labels';
import { monthsLabel } from '@/lib/age';

export default function MilestonePage() {
  return <Suspense fallback={<PageSkeleton />}><MilestoneDetail /></Suspense>;
}

/** Milestone detail with a builds-toward timeline (SDD BMi-2, §4.4). */
function MilestoneDetail() {
  const id = useSearchParams().get('id') ?? '';
  const { catalog, error } = useCatalog();
  const { state, toggleSeen } = useApp();
  if (!catalog) return error ? <p className="note">Couldn&apos;t load milestones. Check your connection.</p> : <PageSkeleton />;
  const m = catalog.msById.get(id);
  if (!m) {
    return (
      <>
        <PageHeader back={{ href: '/milestones/', label: 'Milestones' }} />
        <p className="empty">Milestone not found. <Link href="/milestones/">All milestones</Link></p>
      </>
    );
  }
  const acts = catalog.msToActs.get(m.id) ?? [];
  const next = catalog.milestones
    .filter((x) => x.category === m.category && x.month > m.month)
    .sort((a, b) => a.month - b.month)[0];
  const seen = state.milestonesSeen.includes(m.id);

  return (
    <div className="narrow">
      <PageHeader back={{ href: '/milestones/', label: 'Milestones' }} />
      <header className={`mhead c-${CAT_CLASS[m.category]}`}>
        <span className="badge"><span aria-hidden="true">{CAT_EMOJI[m.category]}</span> {CAT_LABEL[m.category]}</span>
        <span className="badge">By {m.month} months</span>
        <h1>{m.text}</h1>
        <p className="meta" style={{ color: 'var(--ink)' }}>
          {acts.length} {acts.length === 1 ? 'activity builds' : 'activities build'} toward this
        </p>
      </header>

      <button type="button" className="btn secondary" aria-pressed={seen} onClick={() => toggleSeen(m.id)} style={{ marginBottom: 6 }}>
        {seen ? '✓ We’ve seen this' : 'Mark as seen'}
      </button>

      <h2 className="sec">Activities that build toward it</h2>
      {acts.length === 0 ? (
        <p className="muted">No activities linked yet.</p>
      ) : (
        <ol className="tl">
          {acts.map((a) => (
            <li key={a.id}>
              <Link href={`/activity/?id=${a.id}`} className="tcard">
                <span className="mo">{monthsLabel(a.month)}{a.month < m.month ? ' · builds toward' : ''}</span>
                <span className="t" style={{ display: 'block' }}>{a.title}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}

      {next && (
        <>
          <h2 className="sec">Next in {CAT_LABEL[m.category].toLowerCase()}</h2>
          <Link href={`/milestone/?id=${next.id}`} className="card nextm">
            <span className={`dot c-${CAT_CLASS[next.category]}`} aria-hidden="true">{CAT_EMOJI[next.category]}</span>
            <span style={{ flex: 1 }}>{next.text} <span className="meta">· by {next.month} months</span></span>
            <span aria-hidden="true">→</span>
          </Link>
        </>
      )}
      <Disclaimer />
    </div>
  );
}
