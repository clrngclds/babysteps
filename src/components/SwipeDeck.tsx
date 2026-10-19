'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { Activity, Milestone } from '@/lib/types';
import type { SwipeDir } from '@/lib/state';
import { CAT_CLASS, CAT_EMOJI, CAT_LABEL, SETTING_LABEL } from '@/lib/labels';
import { activityEmoji } from '@/lib/emoji';

const THRESHOLD = 90;

function usePrefersReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduce(mq.matches);
    const on = () => setReduce(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduce;
}

interface Props {
  cards: Activity[];
  milestoneFor: (a: Activity) => Milestone | undefined;
  onSwipe: (a: Activity, dir: SwipeDir) => void;
  progress: string;
}

/**
 * Swipe deck (SDD RC-2): right = they'd like it (also saves), left = not for us, up = not ready.
 * Every gesture has a button. Pointer events cover mouse, touch and pen.
 */
export function SwipeDeck({ cards, milestoneFor, onSwipe, progress }: Props) {
  const reduce = usePrefersReducedMotion();
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [leaving, setLeaving] = useState<SwipeDir | null>(null);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const top = cards[0];

  const commit = (dir: SwipeDir) => {
    if (!top || leaving) return;
    if (reduce) { onSwipe(top, dir); setDrag(null); return; }
    setLeaving(dir);
    window.setTimeout(() => { onSwipe(top, dir); setLeaving(null); setDrag(null); }, 230);
  };

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('a,button')) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ x: 0, y: 0 });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!start.current || start.current.id !== e.pointerId) return;
    setDrag({ x: e.clientX - start.current.x, y: e.clientY - start.current.y });
  };
  const onUp = (e: React.PointerEvent) => {
    if (!start.current || start.current.id !== e.pointerId) return;
    const d = { x: e.clientX - start.current.x, y: e.clientY - start.current.y };
    start.current = null;
    if (d.x > THRESHOLD) commit('like');
    else if (d.x < -THRESHOLD) commit('pass');
    else if (d.y < -THRESHOLD && Math.abs(d.x) < THRESHOLD) commit('not_ready');
    else setDrag(null);
  };

  let transform = '';
  let transition = 'transform .2s ease-out';
  if (leaving) {
    const off = leaving === 'like' ? 'translate(140%, 0) rotate(18deg)' : leaving === 'pass' ? 'translate(-140%, 0) rotate(-18deg)' : 'translate(0, -130%)';
    transform = off;
    transition = 'transform .23s ease-in';
  } else if (drag) {
    transform = `translate(${drag.x}px, ${Math.min(drag.y, 40)}px)${reduce ? '' : ` rotate(${drag.x / 18}deg)`}`;
    transition = start.current ? 'none' : transition;
  }
  const likeO = drag ? Math.max(0, Math.min(1, drag.x / THRESHOLD)) : leaving === 'like' ? 1 : 0;
  const passO = drag ? Math.max(0, Math.min(1, -drag.x / THRESHOLD)) : leaving === 'pass' ? 1 : 0;
  const readyO = drag ? Math.max(0, Math.min(1, -drag.y / THRESHOLD)) * (Math.abs(drag.x) < THRESHOLD ? 1 : 0) : leaving === 'not_ready' ? 1 : 0;

  if (!top) return <p className="empty">No more ideas for this age right now. Check back next month.</p>;

  return (
    <div>
      <div className="stack" aria-roledescription="card deck">
        {cards[2] && <div className="sc b2" aria-hidden="true" />}
        {cards[1] && <div className="sc b1" aria-hidden="true" />}
        <article
          key={top.id}
          className={`sc top${drag ? ' dragging' : ''}`}
          style={{ transform, transition }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={() => { start.current = null; setDrag(null); }}
          aria-label={top.title}
        >
          <div className={`art c-${CAT_CLASS[top.category]}`} aria-hidden="true">{activityEmoji(top)}</div>
          <div className="body">
            <span className="badge"><span aria-hidden="true">{CAT_EMOJI[top.category]}</span> {CAT_LABEL[top.category]}</span>
            <h3>{top.title}</h3>
            <p className="meta">
              {top.duration_min} min · {SETTING_LABEL[top.setting]}
              {milestoneFor(top) ? <> · Builds toward &ldquo;{milestoneFor(top)!.text.toLowerCase()}&rdquo;</> : null}
            </p>
            <Link href={`/activity/?id=${top.id}`} className="linkbtn" style={{ paddingLeft: 0 }}>How to play →</Link>
          </div>
          <span className="stamp like" style={{ opacity: likeO }} aria-hidden="true">♥ Like</span>
          <span className="stamp pass" style={{ opacity: passO }} aria-hidden="true">✕ Not for us</span>
          <span className="stamp ready" style={{ opacity: readyO }} aria-hidden="true">⏳ Not ready</span>
        </article>
      </div>
      <div className="btns">
        <button type="button" className="sbtn" data-swipe="pass" aria-label="Not for us" onClick={() => commit('pass')}>✕</button>
        <button type="button" className="sbtn nr" data-swipe="not_ready" aria-label="Not ready yet" onClick={() => commit('not_ready')}>⏳</button>
        <button type="button" className="sbtn y" data-swipe="like" aria-label="They'd like it (saves it)" onClick={() => commit('like')}>♥</button>
      </div>
      <div className="btnlabels" aria-hidden="true"><span>Not for us</span><span>Not ready</span><span>They&apos;d like it</span></div>
      <p className="prog" aria-live="polite">{progress}</p>
    </div>
  );
}
