/** Shared plumbing for the weekly / daily / monthly jobs: dependencies, finalize (publish or stage), reports. */
import { buildCatalog } from '../../../scripts/catalog-lib';
import type { PipelineConfig } from '../config';
import { estimateCost } from '../config';
import type { Bucket } from '../gcp/storage';
import { readJson } from '../gcp/storage';
import { info, warn } from '../log';
import { mergeCandidates, patchOutings, retireRecords } from '../content/merge';
import { appendQuarantine, saveContent, saveRun, saveStaged } from '../content/store';
import { publishCatalog, readLatest, toRaw, validateForPublish } from '../publish/publish';
import type {
  Candidate,
  ContentSet,
  Fetcher,
  GateId,
  GateOutcome,
  Llm,
  LlmUsage,
  Outing,
  QuarantineEntry,
  RunReport,
  SafetyRulesFile,
  SourcesFile,
} from '../types';
import { MAX_ATTEMPTS } from '../types';

export interface JobDeps {
  cfg: PipelineConfig;
  bucket: Bucket;
  fetcher: Fetcher;
  llm: Llm;
  sources: SourcesFile;
  safety: SafetyRulesFile;
  /** Repo root inside the image (data/*.json for the first seed). */
  repoRoot: string;
  now: Date;
  runId: string;
  /** fetch used for the post-publish health check (tests inject a stub). null = skip the check. */
  healthFetch: typeof fetch | null;
}

export function newReport(job: RunReport['job'], deps: JobDeps, today: string): RunReport {
  return {
    run_id: deps.runId,
    job,
    date: today,
    auto_publish: deps.cfg.autoPublish,
    discovered: [],
    reached_gemini: 0,
    candidates: 0,
    gate_failures: { G1: 0, G2: 0, G3: 0, G4: 0, G5: 0, G6: 0, G7: 0, G8: 0, G9: 0 },
    gate_failure_reasons: [],
    passed: 0,
    published: [],
    staged: [],
    retired: [],
    quarantined: 0,
    catalog_version: null,
    published_version: null,
    llm_usage: {},
    est_cost_usd: 0,
    failures: [],
  };
}

export const titleOf = (c: Candidate) => ('title' in c.draft ? c.draft.title : (c.draft as { name: string }).name);

/** Records gate failures in the report and turns them into quarantine entries. */
export function quarantineOutcomes(report: RunReport, outcomes: GateOutcome[], now: Date): QuarantineEntry[] {
  const out: QuarantineEntry[] = [];
  for (const o of outcomes) {
    if (!o.failures.length) continue;
    const gates = new Set<GateId>();
    for (const f of o.failures) {
      gates.add(f.gate);
      report.gate_failure_reasons.push({ gate: f.gate, reason: f.reason, title: titleOf(o.candidate), source: o.candidate.source_id });
    }
    for (const g of gates) report.gate_failures[g] += 1;
    const retry = o.failures.every((f) => f.fixable) && o.candidate.attempts < MAX_ATTEMPTS;
    out.push({ candidate: o.candidate, failures: o.failures, quarantined_at: now.toISOString(), retry });
  }
  return out;
}

/** True when building `next` gives different activities/outings files than the live catalog version. */
export async function catalogDiffers(b: Bucket, next: ContentSet): Promise<{ differs: boolean; version: number | null }> {
  const latest = await readLatest(b);
  if (!latest) return { differs: true, version: null };
  const v = latest.pointer.version;
  const built = buildCatalog(toRaw(next), v, '');
  for (const f of ['activities.json', 'outings.json']) {
    const live = await readJson<unknown>(b, `catalog/v${v}/${f}`);
    if (JSON.stringify(live) !== JSON.stringify(built.files[f])) return { differs: true, version: v };
  }
  return { differs: false, version: v };
}

export interface Changes {
  accepted: Candidate[];
  retire: { id: string; reason: string }[];
  patches: Map<string, Partial<Outing>>;
  quarantine: QuarantineEntry[];
}

/**
 * Applies the run's changes: merge -> retire -> patch -> G9 -> publish (AUTO_PUBLISH) or stage.
 * Canonical content/ is only written after a successful publish, so a rolled-back or staged run
 * leaves content/ unchanged.
 */
export async function finalize(deps: JobDeps, report: RunReport, content: ContentSet, ch: Changes): Promise<void> {
  const today = report.date;
  const merged = mergeCandidates(content, ch.accepted, today);
  let next = retireRecords(merged.content, new Set(ch.retire.map((r) => r.id)));
  next = patchOutings(next, ch.patches);
  report.retired = ch.retire;

  const g9 = validateForPublish(next);
  const { differs, version } = await catalogDiffers(deps.bucket, next);
  report.catalog_version = version;
  const stagedList = [
    ...merged.addedActivities.map((a) => ({ title: a.title, kind: 'activity' as const, month: a.month, category: a.category, source: a.source_name, url: a.source_url })),
    ...merged.addedOutings.map((o) => ({ title: o.name, kind: 'outing' as const, source: new URL(o.url).hostname, url: o.url })),
  ];

  if (g9.errors.length) {
    report.failures.push(`G9 catalog validation failed (${g9.errors.length} errors): ${g9.errors.slice(0, 3).join('; ')}`);
    report.gate_failures.G9 += ch.accepted.length;
    for (const c of ch.accepted)
      ch.quarantine.push({
        candidate: c,
        failures: [{ gate: 'G9', reason: `merged catalog failed validation: ${g9.errors[0]}`, fixable: true }],
        quarantined_at: deps.now.toISOString(),
        retry: c.attempts < MAX_ATTEMPTS,
      });
  } else if (!differs) {
    info('no catalog changes this run', { job: report.job });
  } else if (deps.cfg.autoPublish) {
    const r = await publishCatalog(deps.bucket, next, {
      now: deps.now,
      health: deps.healthFetch ? { siteUrl: deps.cfg.siteUrl, fetchImpl: deps.healthFetch } : null,
    });
    if (r.ok) {
      await saveContent(deps.bucket, next);
      report.published_version = r.version;
      report.catalog_version = r.version;
      report.published = [
        ...merged.addedActivities.map((a) => ({ id: a.id, title: a.title, kind: 'activity' as const })),
        ...merged.addedOutings.map((o) => ({ id: o.id, title: o.name, kind: 'outing' as const })),
      ];
      info(`published catalog v${r.version}`, { event: 'catalog_published', version: r.version, counts: r.counts });
    } else {
      report.failures.push(`publish failed${r.rolledBack ? ' (rolled back)' : ''}: ${r.errors.join('; ')}`);
      warn('publish failed', { event: 'catalog_publish_failed', ...r });
    }
  } else {
    report.staged = stagedList;
    await saveStaged(deps.bucket, {
      date: today,
      run_id: deps.runId,
      auto_publish: false,
      activities: merged.addedActivities,
      outings: merged.addedOutings,
      retire: ch.retire,
      update: [...merged.updated, ...[...ch.patches.keys()].map((id) => ({ id, reason: 'dates confirmed / re-verified' }))],
      validation: { ok: true, errors: [], warnings: g9.warnings.length },
    });
    info('AUTO_PUBLISH=false: changes staged, nothing published', { event: 'catalog_staged', job: report.job, staged: stagedList.length, retire: ch.retire.length });
  }
  report.passed = ch.accepted.length;
  report.quarantined = ch.quarantine.length;
  await appendQuarantine(deps.bucket, { date: today, run_id: deps.runId, entries: ch.quarantine });
}

export function finishReport(deps: JobDeps, report: RunReport): RunReport {
  report.llm_usage = deps.llm.usage();
  const total: LlmUsage = { calls: 0, promptTokens: 0, outputTokens: 0, thoughtsTokens: 0 };
  for (const u of Object.values(report.llm_usage)) {
    total.calls += u.calls;
    total.promptTokens += u.promptTokens;
    total.outputTokens += u.outputTokens;
    total.thoughtsTokens += u.thoughtsTokens;
  }
  report.est_cost_usd = Math.round(estimateCost(deps.llm.model, total) * 10000) / 10000;
  return report;
}

export async function saveReport(deps: JobDeps, report: RunReport) {
  await saveRun(deps.bucket, finishReport(deps, report));
  info(`${report.job} run finished`, {
    event: 'pipeline_run_report',
    job: report.job,
    reached_gemini: report.reached_gemini,
    candidates: report.candidates,
    passed: report.passed,
    published: report.published.length,
    staged: report.staged.length,
    retired: report.retired.length,
    quarantined: report.quarantined,
    gate_failures: report.gate_failures,
    est_cost_usd: report.est_cost_usd,
    failures: report.failures,
  });
}

/** Runs fn over items with at most `n` in flight. */
export async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}
