import { InfoIcon } from './icons';

/** Fixed milestone disclaimer (SDD §9.2, BMi-4). */
export function Disclaimer() {
  return (
    <aside className="note" style={{ marginTop: 22 }} aria-label="About milestones">
      <p style={{ display: 'flex', gap: 8 }}>
        <InfoIcon style={{ flex: 'none', marginTop: 1 }} />
        <span>
          Milestones are a guide, not a test. Every child develops at their own pace. If you have any concerns, talk to
          your doctor. The developmental checks in your child&apos;s Health Booklet and{' '}
          <a href="https://www.healthhub.sg/" target="_blank" rel="noopener noreferrer">HealthHub</a> are good places to start.
        </span>
      </p>
      <p style={{ marginTop: 8, paddingLeft: 26 }}>If your child loses skills they once had, see a doctor.</p>
      <p style={{ marginTop: 8, paddingLeft: 26 }}>
        Milestones from the CDC &ldquo;Learn the Signs. Act Early.&rdquo; checklists (2022).{' '}
        <a href="https://www.cdc.gov/act-early/milestones/index.html" target="_blank" rel="noopener noreferrer">Source</a>
      </p>
    </aside>
  );
}
