'use client';

import { useState } from 'react';
import { useApp } from '@/components/AppProvider';
import { PageHeader } from '@/components/PageHeader';
import { BirthPicker } from '@/components/BirthPicker';
import { birthLabel, monthsLabel } from '@/lib/age';
import { VISIT_URL } from '@/lib/analytics';

export default function SettingsPage() {
  const { birth, age, state, setBirth, clearData, setViewMonth } = useApp();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);

  return (
    <div className="narrow">
      <PageHeader title="Settings" noSettings />

      <section className="card">
        <h2 className="sec">Your child</h2>
        {!editing ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <p>
              {birth ? <>Born <strong>{birthLabel(birth)}</strong> · {monthsLabel(age?.months ?? 0)}{age?.over ? ' (app covers 0–36 months)' : ''}</> : 'No birth month saved.'}
            </p>
            <button type="button" className="btn secondary" onClick={() => setEditing(true)}>Change</button>
          </div>
        ) : (
          <BirthPicker
            initial={state.birth}
            submitLabel="Save"
            onSubmit={(b) => { setBirth(b); setViewMonth(null); setEditing(false); }}
            onCancel={() => setEditing(false)}
          />
        )}
      </section>

      <section className="card">
        <h2 className="sec">Privacy</h2>
        <p><strong>Saved on this phone only.</strong> Your child&apos;s birth month, saved ideas, swipes and filters stay in this browser. There&apos;s no account, and nothing about you or your child is sent to us. Searches are not stored or sent.</p>
        <p className="muted" style={{ marginTop: 8, fontSize: 13.5 }}>
          {VISIT_URL
            ? 'The only thing the app sends is an anonymous \u201csomeone visited today\u201d count, at most once a day, with no ID, birth month or page. Request logs for it are not kept.'
            : 'The only thing the app may send is an anonymous \u201csomeone visited today\u201d count, with no ID. It is switched off in this build.'}
        </p>
        <h3 style={{ fontSize: 15, marginTop: 14 }}>Things that erase your data</h3>
        <ul style={{ paddingLeft: 20, fontSize: 14, marginTop: 4 }}>
          <li>Clearing your browser data, switching browser or phone, or private browsing.</li>
          <li>On iPhone, Safari can delete site data after about 7 days without a visit. Add baby steps to your Home Screen to avoid this.</li>
        </ul>
      </section>

      <section className="card">
        <h2 className="sec">Clear my data</h2>
        <p style={{ marginBottom: 12 }}>Deletes everything stored on this device: birth month, saved ideas, swipes, filters and the offline copy.</p>
        {!confirm ? (
          <button type="button" className="btn danger" onClick={() => setConfirm(true)}>Clear my data</button>
        ) : (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="btn secondary" onClick={() => setConfirm(false)}>Cancel</button>
            <button type="button" className="btn danger" onClick={() => clearData()}>Yes, delete everything</button>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="sec">About and sources</h2>
        <p style={{ fontSize: 14 }}>
          Milestones: CDC &ldquo;Learn the Signs. Act Early.&rdquo; checklists (2022).{' '}
          <a href="https://www.cdc.gov/act-early/milestones/index.html" target="_blank" rel="noopener noreferrer">cdc.gov</a>.
          Activities are summarised in our own words, each with a link to its source. Outings link to their official pages.
          This app gives no medical advice.
        </p>
        <p className="meta" style={{ marginTop: 8 }}>Catalog version {state.catalogVersion ?? '–'}</p>
      </section>
    </div>
  );
}
