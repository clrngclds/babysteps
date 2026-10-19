'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp, useCatalog } from '@/components/AppProvider';
import { PageHeader } from '@/components/PageHeader';
import { PageSkeleton } from '@/components/Shell';
import { SwipeDeck } from '@/components/SwipeDeck';
import { ActivityCard } from '@/components/ActivityCard';
import { birthLabel } from '@/lib/age';
import { swipeCount, type SwipeDir } from '@/lib/state';
import { computeTagAffinity, nextDeck, recommend, type Pick, type RecInput } from '@/lib/recommender';
import type { Activity } from '@/lib/types';

const PICKS_AFTER = 8;
const AGE_OK_KEY = 'bs-age-confirmed';

export default function ForYouPage() {
  const { catalog, error } = useCatalog();
  const { age, birth, state, swipe, setTagAffinity } = useApp();
  const [tab, setTab] = useState<'discover' | 'saved'>('discover');
  const [confirmed, setConfirmed] = useState(false);
  const [view, setView] = useState<'deck' | 'picks'>(() => (swipeCount(state) >= PICKS_AFTER ? 'picks' : 'deck'));
  const [deck, setDeck] = useState<Activity[] | null>(null);
  const [sessionSwipes, setSessionSwipes] = useState(0);

  // Age gate (RC-1): confirm once per session, and again if the birth month changes.
  useEffect(() => {
    try { setConfirmed(sessionStorage.getItem(AGE_OK_KEY) === state.birth); } catch { /* ignore */ }
  }, [state.birth]);
  const confirm = () => {
    try { sessionStorage.setItem(AGE_OK_KEY, state.birth ?? ''); } catch { /* ignore */ }
    setConfirmed(true);
  };

  const ageM = age?.months ?? 0;
  const input = useMemo<RecInput | null>(() => {
    if (!catalog) return null;
    return {
      activities: catalog.activities,
      milestones: catalog.milestones,
      checkpoints: catalog.milestonesFile.checkpoints_months,
      ageMonths: ageM,
      interactions: state.interactions,
      favorites: state.favorites,
      milestonesSeen: state.milestonesSeen,
      hidePaid: state.filters.hidePaid,
      now: Date.now(),
    };
  }, [catalog, ageM, state.interactions, state.favorites, state.milestonesSeen, state.filters.hidePaid]);

  // Build a deck when needed (seed deck on first run, re-ranked deck afterwards).
  useEffect(() => {
    if (input && view === 'deck' && (deck === null || deck.length === 0)) setDeck(nextDeck(input, 8));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, view, deck]);

  // Rebuild the deck if Hide paid or the age changes.
  useEffect(() => { setDeck(null); }, [state.filters.hidePaid, ageM]);

  // Picks are computed when the list opens and then frozen, so saving a pick doesn't reshuffle it.
  const [picks, setPicks] = useState<Pick[] | null>(null);
  useEffect(() => {
    if (view !== 'picks') { setPicks(null); return; }
    if (input && picks === null) setPicks(recommend(input, 10));
  }, [view, input, picks]);

  // Keep the stored tagAffinity snapshot (§6.3) in step with the interaction history.
  useEffect(() => {
    if (!catalog) return;
    setTagAffinity(computeTagAffinity(state.interactions, catalog.actById, Date.now()));
  }, [catalog, state.interactions, setTagAffinity]);

  const onSwipe = useCallback((a: Activity, dir: SwipeDir) => {
    swipe(a.id, dir);
    setDeck((d) => (d ? d.filter((x) => x.id !== a.id) : d));
    setSessionSwipes((n) => {
      const next = n + 1;
      const total = swipeCount(state) + 1;
      if (next % PICKS_AFTER === 0 || total === PICKS_AFTER) setView('picks');
      return next;
    });
  }, [swipe, state]);

  if (!catalog) return error ? <p className="note">Couldn&apos;t load activities. Check your connection.</p> : <PageSkeleton />;
  const savedList = state.favorites.map((id) => catalog.actById.get(id)).filter((a): a is Activity => !!a);
  const ageText = `${ageM}-month-old`;
  const total = swipeCount(state);

  return (
    <div className="narrow">
      <PageHeader title="For You" sub="Swipe to tell us what they’d enjoy" />
      <div className="seg" role="tablist" aria-label="For You">
        <button type="button" role="tab" data-tab="discover" aria-selected={tab === 'discover'} onClick={() => setTab('discover')}>Discover</button>
        <button type="button" role="tab" data-tab="saved" aria-selected={tab === 'saved'} onClick={() => setTab('saved')}>Saved ({savedList.length})</button>
      </div>

      {tab === 'saved' && (
        <div role="tabpanel">
          {savedList.length === 0 ? (
            <p className="empty">Nothing saved yet. Tap ♡ on any activity, or swipe right on one they&apos;d like.</p>
          ) : (
            <div className="agrid">{savedList.map((a) => <ActivityCard key={a.id} a={a} showMonth />)}</div>
          )}
        </div>
      )}

      {tab === 'discover' && !confirmed && (
        <section className="card gate" role="tabpanel" aria-labelledby="gate-t">
          <span style={{ fontSize: 40 }} aria-hidden="true">🌱</span>
          <h2 id="gate-t">Recommending for a {ageText}</h2>
          <p className="muted">Born {birth ? birthLabel(birth) : '–'}. Ideas are picked for this age.</p>
          {age?.over && <p className="note" style={{ marginTop: 10 }}>The app covers 0–36 months, so ideas are for 36 months.</p>}
          <div className="actions">
            <button type="button" className="btn" data-confirm-age onClick={confirm}>Yes, show ideas</button>
            <Link href="/settings/" className="btn secondary">Change birth month</Link>
          </div>
        </section>
      )}

      {tab === 'discover' && confirmed && (
        <div role="tabpanel">
          <div className="agebar">
            <span>For a {ageText} · born {birth ? birthLabel(birth, true) : ''}</span>
            <Link href="/settings/" className="linkbtn">Change</Link>
          </div>

          {view === 'deck' && deck && (
            <SwipeDeck
              cards={deck}
              milestoneFor={(a) => a.milestone_ids.map((m) => catalog.msById.get(m)).find((m) => !!m)}
              onSwipe={onSwipe}
              progress={
                total < PICKS_AFTER
                  ? `${total} of ${PICKS_AFTER} · picks appear after ${PICKS_AFTER} swipes`
                  : `${sessionSwipes % PICKS_AFTER} of ${PICKS_AFTER} until your picks refresh`
              }
            />
          )}
          {view === 'deck' && total >= PICKS_AFTER && (
            <p style={{ textAlign: 'center', marginTop: 4 }}>
              <button type="button" className="linkbtn" onClick={() => setView('picks')}>See your picks</button>
            </p>
          )}

          {view === 'picks' && (
            <section aria-labelledby="picks-t">
              <h2 className="sec" id="picks-t">Picked for you</h2>
              {picks && picks.length === 0 && <p className="empty">You&apos;ve seen every idea for this age. Check back next month.</p>}
              <div className="agrid">
                {(picks ?? []).map((p) => <ActivityCard key={p.activity.id} a={p.activity} reason={p.reason} />)}
              </div>
              <button type="button" className="btn block" style={{ marginTop: 14 }} onClick={() => { setDeck(null); setView('deck'); }}>
                Keep swiping
              </button>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
