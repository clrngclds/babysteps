'use client';

import { useApp } from './AppProvider';
import { BirthPicker } from './BirthPicker';
import { LockIcon } from './icons';
import { VISIT_URL } from '@/lib/analytics';

export function Onboarding() {
  const { setBirth } = useApp();
  return (
    <main className="onb">
      <div className="logo" aria-label="baby steps">baby <span>steps</span></div>
      <h1>When was your little one born?</h1>
      <p className="lead">We&apos;ll show milestones and play ideas for their age, from 0 to 36 months.</p>
      <BirthPicker submitLabel="Continue" onSubmit={setBirth} />
      <p className="privacy"><LockIcon style={{ flex: 'none', marginTop: 1 }} /> Saved on this phone only. No account, no name.{VISIT_URL ? ' We only count anonymous visits.' : ' Nothing is sent to us.'}</p>
    </main>
  );
}
