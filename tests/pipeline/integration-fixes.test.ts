/** Fixes made after the first live dry run (2026-10-19). */
import { describe, it, expect } from 'vitest';
import { g2Grounding } from '../../pipeline/src/gates/gates';
import { outingSystemPrompt, activitySystemPrompt, REVIEW_SYSTEM } from '../../pipeline/src/extract/prompts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Candidate, PageContext } from '../../pipeline/src/types';

const ms = JSON.parse(readFileSync(join(__dirname, '..', '..', 'data', 'milestones.json'), 'utf8'));

const pageText =
  '[Early READ Fiesta] Pre-Fiesta Pop-Up Booth at Choa Chu Kang Library\nIn-Person\nAbout the Event\n' +
  'Join us at the Pop-up Booth at Choa Chu Kang Library (Level 5). This booth is part of the pre-Fiesta publicity for Early READ Fiesta 2026/2027.';
const page: PageContext = { url: 'https://nlb.libcal.com/event/1', finalUrl: 'https://nlb.libcal.com/event/1', title: 't', text: pageText, html: '', fetchedAt: 'now' };

const outing = (name: string, summary: string): Candidate => ({
  kind: 'outing',
  draft: {
    name, type: 'event', summary, location: 'Choa Chu Kang Public Library', region: 'west', min_age_months: 0, max_age_months: 36,
    categories: ['language'], play_type: ['reading'], setting: 'indoor', rain_ok: true, price_note: 'Free.', booking_required: false,
    start_date: '2026-11-07', end_date: '2026-11-07', recurrence: null, dates_confirmed: true, url: page.url, notes: '', paid: false,
  },
  supporting_quote: 'Join us at the Pop-up Booth at Choa Chu Kang Library (Level 5).',
  source_id: 'nlb-libcal', page_url: page.url, extracted_at: 'now', attempts: 1,
});

describe('dry-run fixes', () => {
  it("an outing's official name may match the page; its summary may not copy 12+ words", () => {
    const ok = outing('Early READ Fiesta Pre-Fiesta Pop-Up Booth at Choa Chu Kang Library', 'A library booth with reading activities ahead of the Early READ Fiesta.');
    expect(g2Grounding(ok, page)).toEqual([]);
    const copied = outing('Early READ booth', 'This booth is part of the pre-Fiesta publicity for Early READ Fiesta 2026/2027 at the library.');
    expect(g2Grounding(copied, page).map((f) => f.reason).join(' ')).toContain('summary copies');
  });

  it('prompts require single-line quotes and realistic outing ages; the reviewer checks unsupported ages', () => {
    expect(activitySystemPrompt(ms)).toContain('single line of the page text');
    expect(outingSystemPrompt()).toContain('single line of the page text');
    expect(outingSystemPrompt()).toContain('Skip attractions built for older children or adults');
    expect(REVIEW_SYSTEM).toContain('does not support the age range');
  });
});

import { MemoryBucket, readJson as readJ } from '../../pipeline/src/gcp/storage';
import { saveStaged, PATHS as P } from '../../pipeline/src/content/store';
import type { StagedFile } from '../../pipeline/src/types';

describe('staged files', () => {
  it('a second job on the same day merges into the staged file instead of replacing it', async () => {
    const b = new MemoryBucket();
    const base: StagedFile = { date: '2026-10-19', run_id: 'weekly-1', auto_publish: false, activities: [{ id: 'act-a' } as never], outings: [], retire: [], update: [{ id: 'sg-x', reason: 'dates' }], validation: { ok: true, errors: [], warnings: 0 } };
    await saveStaged(b, base);
    await saveStaged(b, { ...base, run_id: 'daily-1', activities: [], retire: [{ id: 'sg-old', reason: 'event ended' }], update: [] });
    const s = (await readJ<StagedFile>(b, P.staged('2026-10-19')))!;
    expect(s.run_id).toBe('weekly-1,daily-1');
    expect(s.activities.map((a) => a.id)).toEqual(['act-a']);
    expect(s.retire.map((r) => r.id)).toEqual(['sg-old']);
    expect(s.update.map((r) => r.id)).toEqual(['sg-x']);
  });
});
