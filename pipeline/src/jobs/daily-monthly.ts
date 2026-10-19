/**
 * Daily job (05:00 SGT): event expiry publish (SDD §8.6). Also publishes any other content change
 * that is not live yet (e.g. the Phase 3 migration), subject to G9 and AUTO_PUBLISH.
 * Monthly job (1st, 07:00 SGT): venue re-check with a Gemini diff (SDD §8.6).
 */
import { info } from '../log';
import { fetchPage } from '../fetch/discover';
import { sourceForUrl } from '../fetch/sources';
import { compareVenue } from '../extract/venue';
import { normalizeText } from '../gates/text';
import { expiredEvents } from '../maintenance/maintenance';
import { finalize, newReport, quarantineOutcomes, saveReport, type JobDeps } from './common';
import { ensureContent, gateAll } from './weekly';
import type { Candidate, Outing, OutingDraft, PageContext, RunReport } from '../types';

export async function runDaily(deps: JobDeps, today: string): Promise<RunReport> {
  const report = newReport('daily', deps, today);
  const content = await ensureContent(deps);
  const expired = expiredEvents(content.outings, today);
  report.maintenance = { expired: expired.map((e) => e.id) };
  info(`event expiry: ${expired.length} events ended`, { event: 'event_expiry', expired: expired.length });
  await finalize(deps, report, content, { accepted: [], retire: expired, patches: new Map(), quarantine: [] });
  await saveReport(deps, report);
  return report;
}

/** Outing fields the model may fill, taken from a stored outing (for venue updates). */
export function outingToDraft(o: Outing): OutingDraft {
  const { id: _id, added_at: _a, status: _s, origin: _o, last_verified: _l, ...draft } = o;
  return draft as OutingDraft;
}

export async function runMonthly(deps: JobDeps, today: string): Promise<RunReport> {
  const report = newReport('monthly', deps, today);
  const content = await ensureContent(deps);
  const venues = content.outings.filter((o) => o.type === 'venue' && (!o.status || o.status === 'published'));
  const retire: { id: string; reason: string }[] = [];
  const updates: { c: Candidate; page: PageContext }[] = [];
  const patches = new Map<string, Partial<Outing>>();
  const results: Record<string, string> = {};

  for (const o of venues) {
    const page = await fetchPage(deps.fetcher, o.url);
    if ('error' in page) {
      results[o.id] = `fetch failed (${page.status || page.error}); link check handles it`;
      continue;
    }
    report.reached_gemini += 1;
    try {
      const v = await compareVenue(deps.llm, o, page);
      const quoteOnPage = !!v.supporting_quote && normalizeText(page.text).includes(normalizeText(v.supporting_quote));
      results[o.id] = `${v.status}: ${v.reason}`.slice(0, 200);
      if (v.status === 'unchanged') patches.set(o.id, { last_verified: today });
      else if (v.status === 'closed' && quoteOnPage) retire.push({ id: o.id, reason: `venue closed: ${v.reason}`.slice(0, 200) });
      else if (v.status === 'changed' && Object.keys(v.changes ?? {}).length) {
        const source = sourceForUrl(deps.sources, page.finalUrl) ?? sourceForUrl(deps.sources, o.url);
        const draft = { ...outingToDraft(o), ...v.changes } as OutingDraft;
        updates.push({
          c: {
            kind: 'outing',
            draft,
            supporting_quote: v.supporting_quote,
            source_id: source?.id ?? 'unknown',
            page_url: page.finalUrl,
            extracted_at: deps.now.toISOString(),
            attempts: 1,
            purpose: 'venue-update',
            replaces_id: o.id,
          },
          page,
        });
      }
    } catch (e) {
      report.failures.push(`venue ${o.id}: ${(e as Error).message}`.slice(0, 300));
    }
  }
  report.candidates = updates.length;
  const gated = await gateAll(deps, updates, content, today);
  const quarantine = quarantineOutcomes(report, gated.failed, deps.now);
  report.maintenance = { venues_checked: venues.length, results, closed: retire.map((r) => r.id), changed: gated.passed.map((c) => c.replaces_id) };
  await finalize(deps, report, content, { accepted: gated.passed, retire, patches, quarantine });
  await saveReport(deps, report);
  return report;
}
