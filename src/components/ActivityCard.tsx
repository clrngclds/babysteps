'use client';

import Link from 'next/link';
import type { Activity } from '@/lib/types';
import { CAT_CLASS, activityMeta } from '@/lib/labels';
import { activityEmoji } from '@/lib/emoji';
import { useApp } from './AppProvider';
import { HeartIcon } from './icons';

export function SaveButton({ activity, withLabel = false }: { activity: Pick<Activity, 'id' | 'title'>; withLabel?: boolean }) {
  const { isSaved, toggleSave } = useApp();
  const saved = isSaved(activity.id);
  if (withLabel) {
    return (
      <button type="button" className="btn secondary" aria-pressed={saved} onClick={() => toggleSave(activity.id)}>
        <HeartIcon width={18} height={18} style={{ color: 'var(--sage-strong)' }} fill={saved ? 'var(--sage-strong)' : 'none'} />
        {saved ? 'Saved' : 'Save'}
      </button>
    );
  }
  return (
    <button
      type="button"
      className="heart"
      aria-pressed={saved}
      aria-label={saved ? `Unsave ${activity.title}` : `Save ${activity.title}`}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleSave(activity.id); }}
    >
      <HeartIcon />
    </button>
  );
}

export function ActivityCard({ a, reason, showMonth }: { a: Activity; reason?: string; showMonth?: boolean }) {
  return (
    <article className="acard">
      <div className={`thumb c-${CAT_CLASS[a.category]}`} aria-hidden="true">{activityEmoji(a)}</div>
      <div className="in">
        <div>
          <h4><Link href={`/activity/?id=${a.id}`}>{a.title}</Link></h4>
          <p className="meta">{showMonth ? `${a.month} mo · ` : ''}{activityMeta(a)}</p>
          {reason && <p className="reason">{reason}</p>}
        </div>
        <SaveButton activity={a} />
      </div>
    </article>
  );
}
