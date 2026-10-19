'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useApp, useCatalog } from '@/components/AppProvider';
import { PageHeader } from '@/components/PageHeader';
import { PageSkeleton } from '@/components/Shell';
import { SaveButton } from '@/components/ActivityCard';
import { CAT_CLASS, CAT_LABEL, ENERGY_LABEL, ROLE_LABEL, SETTING_LABEL, howToSteps } from '@/lib/labels';
import { activityEmoji } from '@/lib/emoji';
import { lastTried, type TriedResult } from '@/lib/state';
import { monthsLabel } from '@/lib/age';

export default function ActivityPage() {
  return <Suspense fallback={<PageSkeleton />}><ActivityDetail /></Suspense>;
}

const TRIED_LABEL: Record<TriedResult, string> = { enjoyed: 'They enjoyed it', meh: 'Meh', not_ready: 'Not ready yet' };

function ActivityDetail() {
  const id = useSearchParams().get('id') ?? '';
  const { catalog, error } = useCatalog();
  const { state, tried } = useApp();
  const [asking, setAsking] = useState(false);

  if (!catalog) return error ? <p className="note">Couldn&apos;t load activities. Check your connection.</p> : <PageSkeleton />;
  const a = catalog.actById.get(id);
  if (!a) {
    return (
      <>
        <PageHeader back={{ href: '/', label: 'Playtime' }} />
        <p className="empty">This activity isn&apos;t available any more. <Link href="/">Back to Playtime</Link></p>
      </>
    );
  }
  const ms = a.milestone_ids.map((m) => catalog.msById.get(m)).filter((m) => !!m);
  const t = lastTried(state, a.id);

  return (
    <div className="narrow">
      <PageHeader back={{ href: '/', label: 'Playtime' }} />
      <div className={`dhero c-${CAT_CLASS[a.category]}`} aria-hidden="true">{activityEmoji(a)}</div>
      <div className="dtitle">
        <h1>{a.title}</h1>
        <SaveButton activity={a} />
      </div>
      <p className="meta" style={{ marginTop: 4 }}>{monthsLabel(a.month)} · {CAT_LABEL[a.category]}</p>
      <div className="facts">
        <span>{a.duration_min} min</span>
        <span>{SETTING_LABEL[a.setting]}</span>
        <span>{ENERGY_LABEL[a.energy]}</span>
        <span>{ROLE_LABEL[a.parent_role]}</span>
      </div>
      <p>{a.summary}</p>

      {a.safety_notes && (
        <div className="safety" role="note">
          <strong>Safety</strong>
          {a.safety_notes}
        </div>
      )}

      <h2 className="sec">How to</h2>
      <ol className="steps">{howToSteps(a.how_to).map((s, i) => <li key={i}>{s}</li>)}</ol>

      {a.materials.length > 0 && (
        <>
          <h2 className="sec">You&apos;ll need</h2>
          <ul className="materials">{a.materials.map((m) => <li key={m}>{m}</li>)}</ul>
        </>
      )}

      {ms.length > 0 && (
        <>
          <h2 className="sec">Builds toward</h2>
          {ms.map((m) => (
            <Link key={m!.id} href={`/milestone/?id=${m!.id}`} className="ms">
              <span className={`dot c-${CAT_CLASS[m!.category]}`} aria-hidden="true">🌱</span>
              <span>{m!.text} <span className="meta">· by {m!.month} months</span></span>
            </Link>
          ))}
        </>
      )}

      <h2 className="sec">Tried it?</h2>
      {!asking ? (
        <div className="tried">
          <SaveButton activity={a} withLabel />
          <button type="button" className="btn secondary" onClick={() => setAsking(true)}>
            {t ? `Tried: ${TRIED_LABEL[t]}` : 'We tried it'}
          </button>
        </div>
      ) : (
        <div>
          <p style={{ marginBottom: 8 }}>Did they enjoy it?</p>
          <div className="tried" role="group" aria-label="Did they enjoy it?">
            {(['enjoyed', 'meh', 'not_ready'] as TriedResult[]).map((r) => (
              <button key={r} type="button" className="btn secondary" onClick={() => { tried(a.id, r); setAsking(false); }}>
                {r === 'enjoyed' ? '😊 Yes' : r === 'meh' ? '😐 Meh' : '⏳ Not ready'}
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="source">
        Source: <a href={a.source_url} target="_blank" rel="noopener noreferrer">{a.source_name}</a>
      </p>
    </div>
  );
}
