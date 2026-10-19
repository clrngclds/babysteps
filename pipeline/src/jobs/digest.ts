/**
 * Weekly digest (SDD §8.7). Google Cloud only: the job writes ONE structured log entry
 *   {"event":"weekly_digest", published, retired, quarantined, staged, failures, catalog_version, summary}
 * and a log-based alert policy (pipeline/deploy.sh) emails it to the owner's notification channel,
 * putting these values in the notification text via label extractors.
 * The full numbers stay in state/runs/weekly/{date}.json.
 */
import { addDays } from '../config';
import { readJson } from '../gcp/storage';
import { log } from '../log';
import { PATHS } from '../content/store';
import { readJobHealth } from './job-health';
import { readLatest } from '../publish/publish';
import type { RunReport } from '../types';
import type { JobDeps } from './common';

export interface DigestEntry {
  event: 'weekly_digest';
  week_ending: string;
  auto_publish: boolean;
  published: number;
  staged: number;
  retired: number;
  quarantined: number;
  failures: number;
  catalog_version: number | null;
  est_cost_usd: number;
  summary: string;
}

const MAX_SUMMARY = 900; // label values are capped; keep the email readable

export function buildDigest(reports: RunReport[], failedJobs: string[], catalogVersion: number | null, today: string, autoPublish: boolean): DigestEntry {
  const published = reports.flatMap((r) => r.published);
  const staged = reports.flatMap((r) => r.staged);
  const retired = reports.flatMap((r) => r.retired);
  const quarantined = reports.reduce((n, r) => n + r.quarantined, 0);
  const failures = [...failedJobs, ...reports.flatMap((r) => r.failures.map((f) => `${r.job}: ${f}`))];
  const cost = reports.reduce((n, r) => n + r.est_cost_usd, 0);
  const list = (xs: string[], n = 6) => (xs.length ? xs.slice(0, n).join('; ') + (xs.length > n ? `; +${xs.length - n} more` : '') : 'none');
  const parts = [
    autoPublish ? `Published: ${list(published.map((p) => p.title))}.` : `AUTO_PUBLISH is off. Staged (not live): ${list(staged.map((s) => s.title))}.`,
    `Retired: ${list(retired.map((r) => `${r.id} (${r.reason})`), 4)}.`,
    `Quarantined: ${quarantined} (debug only, no action needed).`,
    `Failures: ${list(failures, 3)}.`,
    `Catalog: v${catalogVersion ?? '?'}. Gemini cost this week: ~$${cost.toFixed(2)}.`,
  ];
  let summary = parts.join(' ');
  if (summary.length > MAX_SUMMARY) summary = summary.slice(0, MAX_SUMMARY - 1) + '…';
  return {
    event: 'weekly_digest',
    week_ending: today,
    auto_publish: autoPublish,
    published: published.length,
    staged: staged.length,
    retired: retired.length,
    quarantined,
    failures: failures.length,
    catalog_version: catalogVersion,
    est_cost_usd: Math.round(cost * 100) / 100,
    summary,
  };
}

/** Collects the last 7 days of run reports (all jobs) and logs the digest entry. */
export async function digest(deps: JobDeps, current: RunReport, today: string): Promise<DigestEntry> {
  const reports: RunReport[] = [current];
  // This weekly run plus the daily/monthly runs of the past 7 days (last week's weekly run was in last week's digest).
  for (const job of ['daily', 'monthly'] as const) {
    for (let i = 0; i < 7; i++) {
      const r = await readJson<RunReport>(deps.bucket, PATHS.run(job, addDays(today, -i)));
      if (r) reports.push(r);
    }
  }
  const health = await readJobHealth(deps.bucket);
  const failedJobs = Object.entries(health)
    .filter(([, s]) => s.status === 'failed' || s.consecutive_failures > 0)
    .map(([job, s]) => `${job} failed ${s.consecutive_failures}x (${(s.last_error ?? '').slice(0, 80)})`);
  const latest = await readLatest(deps.bucket);
  const entry = buildDigest(reports, failedJobs, latest?.pointer.version ?? null, today, deps.cfg.autoPublish);
  log('NOTICE', `Weekly digest: ${entry.summary}`, { ...entry });
  return entry;
}
