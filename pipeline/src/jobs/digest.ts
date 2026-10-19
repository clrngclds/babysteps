/**
 * Weekly digest (SDD §8.7). Google Cloud only: the job writes ONE structured log entry
 *   {"event":"weekly_digest", published, retired, quarantined, staged, failures, catalog_version,
 *    visitors_*, summary}
 * and a log-based alert policy (pipeline/deploy.sh) emails it to the owner's notification channel,
 * putting these values in the notification text via label extractors. The email template and the
 * extractors live in pipeline/alerts/. The full numbers stay in state/runs/weekly/{date}.json.
 * Visitor numbers come from the anonymous visit counts in BigQuery (SDD §9.1).
 */
import { addDays } from '../config';
import { readJson } from '../gcp/storage';
import { log } from '../log';
import { PATHS } from '../content/store';
import { readJobHealth } from './job-health';
import { readLatest } from '../publish/publish';
import type { RunReport } from '../types';
import type { JobDeps } from './common';
import type { VisitCounts, VisitStats } from '../gcp/bigquery';

/** First line of the digest email (pipeline/alerts/weekly_digest.md starts with it; a test checks). */
export const DIGEST_INTRO =
  'What this email is: the weekly summary of the baby steps content pipeline: what it published, retired and quarantined, any failures, the catalog version, and visitor counts. Informational only; no action is needed.';

export interface VisitorFields {
  /** week_first=true rows, past 7 days (devices, each counted once per ISO week) */
  visitors_7d: number | null;
  /** day_first=true rows, past 7 days (visitor-days) */
  visitor_days_7d: number | null;
  visitors_prev_7d: number | null;
  visitor_days_prev_7d: number | null;
  /** month_first=true rows since the 1st (SGT) */
  visitors_month: number | null;
  /** true when the past-7-days weekly count is complete (7 full days of week_first data, no old-client pings) */
  visitors_complete: boolean;
  /** One line each for the email. Visitor-days are included while the weekly count is partial. */
  visitors_past_text: string;
  visitors_prev_text: string;
  visitors_month_text: string;
}

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
  visitors_7d: number | null;
  visitor_days_7d: number | null;
  visitors_prev_7d: number | null;
  visitor_days_prev_7d: number | null;
  visitors_month: number | null;
  visitors_complete: boolean;
  visitors_past_text: string;
  visitors_prev_text: string;
  visitors_month_text: string;
}

/** Why a window's weekly count is partial, or [] if it is complete. */
export function partialReasons(w: VisitCounts & { start: string }, weekFirstSince: string | null): string[] {
  const out: string[] = [];
  if (!weekFirstSince) out.push('weekly counting has no data yet');
  else if (weekFirstSince >= w.start) out.push(`weekly counting started ${weekFirstSince}`);
  if (w.legacy_rows > 0) out.push(`${w.legacy_rows} ping${w.legacy_rows === 1 ? '' : 's'} from older app versions without the week flag`);
  return out;
}

function windowLine(label: string, w: VisitCounts & { start: string; end: string }, weekFirstSince: string | null): string {
  const reasons = partialReasons(w, weekFirstSince);
  const head = `${label} (${w.start} to ${w.end}): ${w.visitors} visitor${w.visitors === 1 ? '' : 's'} (week_first: devices, each counted once per week`;
  if (!reasons.length) return `${head}).`;
  return `${head}; partial: ${reasons.join(', ')}) and ${w.visitor_days} visitor-day${w.visitor_days === 1 ? '' : 's'} (day_first: devices, each counted once per day they visited).`;
}

/** Visitor numbers and their email lines. `stats` null = not configured; an Error = the query failed. */
export function visitorFields(stats: VisitStats | Error | null): VisitorFields {
  if (!stats || stats instanceof Error) {
    const why = stats ? `Visitor counts unavailable (${stats.message.slice(0, 200)}).` : 'Visitor counts not configured.';
    return {
      visitors_7d: null, visitor_days_7d: null, visitors_prev_7d: null, visitor_days_prev_7d: null, visitors_month: null,
      visitors_complete: false, visitors_past_text: why, visitors_prev_text: '-', visitors_month_text: '-',
    };
  }
  return {
    visitors_7d: stats.current.visitors,
    visitor_days_7d: stats.current.visitor_days,
    visitors_prev_7d: stats.previous.visitors,
    visitor_days_prev_7d: stats.previous.visitor_days,
    visitors_month: stats.month.visitors,
    visitors_complete: partialReasons(stats.current, stats.week_first_since).length === 0,
    visitors_past_text: windowLine('Past 7 days', stats.current, stats.week_first_since),
    visitors_prev_text: windowLine('Previous 7 days', stats.previous, stats.week_first_since),
    visitors_month_text: `This month (${stats.month.start} to ${stats.month.end}): ${stats.month.visitors} visitor${stats.month.visitors === 1 ? '' : 's'} (month_first: devices, each counted once per month).`,
  };
}

const MAX_SUMMARY = 900; // label values are capped; keep the email readable

export function buildDigest(
  reports: RunReport[],
  failedJobs: string[],
  catalogVersion: number | null,
  today: string,
  autoPublish: boolean,
  visitors: VisitStats | Error | null = null,
): DigestEntry {
  const published = reports.flatMap((r) => r.published);
  const staged = reports.flatMap((r) => r.staged);
  const retired = reports.flatMap((r) => r.retired);
  const quarantined = reports.reduce((n, r) => n + r.quarantined, 0);
  const failures = [...failedJobs, ...reports.flatMap((r) => r.failures.map((f) => `${r.job}: ${f}`))];
  if (visitors instanceof Error) failures.push(`visitor counts: ${visitors.message.slice(0, 120)}`);
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
    ...visitorFields(visitors),
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
  let visitors: VisitStats | Error | null = null;
  if (deps.visitStats) {
    try {
      visitors = await deps.visitStats(today);
    } catch (e) {
      visitors = e instanceof Error ? e : new Error(String(e));
    }
  }
  const entry = buildDigest(reports, failedJobs, latest?.pointer.version ?? null, today, deps.cfg.autoPublish, visitors);
  log('NOTICE', `Weekly digest: ${entry.summary}`, { ...entry });
  return entry;
}
