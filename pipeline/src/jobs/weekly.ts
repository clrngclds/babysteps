/**
 * Weekly job (Mon 06:00 SGT): content-watch -> gates -> publish -> link check -> date confirmation
 * -> coverage guard -> digest. SDD §8.3–§8.7.
 */
import { addDays } from '../config';
import { readJson, writeJson } from '../gcp/storage';
import { info, warn } from '../log';
import { discoverSource, fetchPage, resolveOfficialUrl } from '../fetch/discover';
import { hostOf, isOfficialUrl, sourceForUrl } from '../fetch/sources';
import { extractDates } from '../fetch/parsers';
import { extractCandidates } from '../extract/extract';
import { reviewCandidate } from '../extract/review';
import { g8Quotas, loveveryShare, runCandidateGates } from '../gates/gates';
import { loadContent, loadSeen, PATHS, recentQuarantine, repoContent, saveSeen, seedContent } from '../content/store';
import { retireRecords } from '../content/merge';
import { confirmDates, linkCheck, rankPagesForCell, splitRetirements, thinCells, type LinkHealth } from '../maintenance/maintenance';
import { digest } from './digest';
import { finalize, newReport, pool, quarantineOutcomes, saveReport, titleOf, type JobDeps } from './common';
import type { Candidate, ContentSet, DiscoveredItem, GateContext, GateOutcome, Outing, OutingDraft, PageContext, RunReport, SourceConfig, SourcesFile } from '../types';
import { DEFAULT_QUOTAS } from '../types';

export async function ensureContent(deps: JobDeps): Promise<ContentSet> {
  const existing = await loadContent(deps.bucket);
  if (existing) return existing;
  const repo = repoContent(deps.repoRoot);
  await seedContent(deps.bucket, repo);
  info('seeded content/ from repo data (migrated)', { event: 'content_seeded', activities: repo.activities.length, outings: repo.outings.length });
  return repo;
}

/**
 * Pages on `official_domains` (sources.yaml) that aren't a listed source get a synthetic tier-1
 * source, so the per-source quota and the G3 allow-list still apply to them.
 */
function officialSource(sf: SourcesFile, url: string, via: SourceConfig): SourceConfig | undefined {
  if (!isOfficialUrl(sf, url)) return undefined;
  const host = hostOf(url);
  return { id: `official:${host}`, name: host, tier: 1, kind: via.kind, detection: 'listing', urls: [url], domains: [host] };
}

interface Extracted {
  c: Candidate;
  page: PageContext;
}

/** Fetch -> (tier 2: resolve official page) -> extract. Returns candidates with their page. */
async function processItem(deps: JobDeps, item: DiscoveredItem, content: ContentSet, today: string, report: RunReport, skips: Record<string, number>): Promise<Extracted[]> {
  const skip = (why: string) => {
    skips[why] = (skips[why] ?? 0) + 1;
    return [];
  };
  let source: SourceConfig | undefined = deps.sources.sources.find((s) => s.id === item.sourceId);
  if (!source) return skip('unknown source');
  let url = item.url;
  let discoveredVia: string | undefined;
  if (source.tier === 2) {
    const art = await fetchPage(deps.fetcher, item.url);
    if ('error' in art) return skip('tier-2 article fetch failed');
    const official = resolveOfficialUrl(art, item, deps.sources);
    if (!official) return skip('tier-2: no official/organizer page found');
    const t1 = sourceForUrl(deps.sources, official) ?? officialSource(deps.sources, official, source);
    if (!t1 || t1.tier !== 1) return skip('tier-2: official page is not a tier-1 source');
    discoveredVia = source.id;
    source = t1;
    url = official;
  }
  const page = await fetchPage(deps.fetcher, url);
  if ('error' in page) return skip(`page fetch failed (${page.status || page.error})`);
  report.reached_gemini += 1;
  try {
    const r = await extractCandidates(deps.llm, page, source, { milestones: content.milestones, today, discoveredVia });
    if (r.blocked) skips[`blocked by safety filter`] = (skips['blocked by safety filter'] ?? 0) + 1;
    if (!r.candidates.length) skips['no usable activity/event on page'] = (skips['no usable activity/event on page'] ?? 0) + 1;
    return r.candidates.map((c) => ({ c, page }));
  } catch (e) {
    report.failures.push(`extract ${url}: ${(e as Error).message}`.slice(0, 300));
    return skip('extraction error');
  }
}

/** Runs the per-candidate gates in order, so in-run duplicates are caught. */
export async function gateAll(deps: JobDeps, items: Extracted[], content: ContentSet, today: string, excludeIds: Set<string> = new Set()) {
  const passed: Candidate[] = [];
  const failed: GateOutcome[] = [];
  for (const { c, page } of items) {
    // Venue updates are compared against the catalog without the record they replace.
    const base = c.replaces_id || excludeIds.size
      ? { ...content, outings: content.outings.filter((o) => o.id !== c.replaces_id && !excludeIds.has(o.id)) }
      : content;
    const ctx: GateContext = {
      content: base,
      sources: deps.sources,
      safety: deps.safety,
      page,
      today,
      review: (cand, p) => reviewCandidate(deps.llm, cand, p),
    };
    const out = await runCandidateGates(c, ctx, passed);
    if (out.failures.length) failed.push(out);
    else passed.push(out.candidate);
  }
  return { passed, failed };
}

/** Quarantined candidates from the previous week that may be retried (fixable, attempts < 4). */
async function retryItems(deps: JobDeps, content: ContentSet, today: string, report: RunReport): Promise<Extracted[]> {
  const files = await recentQuarantine(deps.bucket, addDays(today, -7));
  const entries = files.filter((f) => f.date < today).flatMap((f) => f.entries).filter((e) => e.retry);
  const seen = new Set<string>();
  const out: Extracted[] = [];
  for (const e of entries) {
    const key = `${e.candidate.page_url}|${titleOf(e.candidate)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const page = await fetchPage(deps.fetcher, e.candidate.page_url);
    if ('error' in page) continue;
    const quotaOnly = e.failures.every((f) => f.gate === 'G8' || f.gate === 'G9');
    if (quotaOnly) {
      out.push({ c: { ...e.candidate, attempts: e.candidate.attempts + 1 }, page });
      continue;
    }
    // Re-extract so a page that now shows dates (or has been fixed) gives a fresh draft.
    const source =
      deps.sources.sources.find((s) => s.id === e.candidate.source_id) ??
      (e.candidate.source_id.startsWith('official:') ? officialSource(deps.sources, e.candidate.page_url, { kind: e.candidate.kind } as SourceConfig) : undefined);
    if (!source) continue;
    report.reached_gemini += 1;
    try {
      const r = await extractCandidates(deps.llm, page, source, { milestones: content.milestones, today, discoveredVia: e.candidate.discovered_via });
      for (const c of r.candidates) out.push({ c: { ...c, attempts: e.candidate.attempts + 1 }, page });
    } catch (err) {
      report.failures.push(`retry extract ${e.candidate.page_url}: ${(err as Error).message}`.slice(0, 300));
    }
  }
  if (out.length) info(`retrying ${out.length} quarantined candidates`, { event: 'quarantine_retry' });
  return out;
}

/** Consecutive weeks with discovery errors per source; logs source_failing at 3 (SDD §8.7). */
async function updateSourceHealth(deps: JobDeps, report: RunReport, today: string) {
  type H = Record<string, { error_weeks: number; last_error?: string; last_run: string }>;
  const h = (await readJson<H>(deps.bucket, PATHS.sourceHealth)) ?? {};
  for (const s of report.discovered) {
    const prev = h[s.sourceId];
    if (s.errors.length) {
      const weeks = prev?.last_run === today ? prev.error_weeks : (prev?.error_weeks ?? 0) + 1;
      h[s.sourceId] = { error_weeks: weeks, last_error: s.errors[0].slice(0, 300), last_run: today };
      if (weeks >= 3)
        warn(`source ${s.sourceId} has returned errors ${weeks} weeks in a row`, { event: 'source_failing', source: s.sourceId, error_weeks: weeks, last_error: s.errors[0].slice(0, 300) });
    } else h[s.sourceId] = { error_weeks: 0, last_run: today };
  }
  await writeJson(deps.bucket, PATHS.sourceHealth, h);
}

/** Date confirmation: confirm stored dates, or re-extract when the page now shows different dates. */
async function dateConfirmation(deps: JobDeps, content: ContentSet, today: string, report: RunReport) {
  const checks = await confirmDates(content, deps.fetcher, today);
  const patches = new Map<string, Partial<Outing>>();
  const updates: Extracted[] = [];
  for (const d of checks) {
    if (d.result === 'confirmed' && d.patch) patches.set(d.id, d.patch);
    if (d.result !== 'not_found' || !d.page || !extractDates(d.page.text, today).length || updates.length >= 10) continue;
    const o = content.outings.find((x) => x.id === d.id)!;
    const source = sourceForUrl(deps.sources, d.page.finalUrl) ?? sourceForUrl(deps.sources, o.url);
    if (!source) continue;
    report.reached_gemini += 1;
    try {
      const r = await extractCandidates(deps.llm, d.page, { ...source, kind: 'outing' }, { milestones: content.milestones, today });
      // Keep the extracted edition that matches the stored outing's name best and has dates.
      const best = r.candidates.find((c) => (c.draft as OutingDraft).start_date && (c.draft as OutingDraft).dates_confirmed);
      if (best) updates.push({ c: { ...best, purpose: 'venue-update', replaces_id: o.id }, page: d.page });
    } catch (e) {
      report.failures.push(`date-confirm extract ${o.url}: ${(e as Error).message}`.slice(0, 300));
    }
  }
  return { patches, updates, confirmed: [...patches.keys()], notFound: checks.filter((c) => c.result === 'not_found').length };
}

/** Coverage guard: for cells that are (or would be) thin, extract focused candidates from tier-1 pages. */
async function coverageGuard(deps: JobDeps, content: ContentSet, deferred: { month: number; category: string }[], today: string, report: RunReport): Promise<Extracted[]> {
  const cells = [...thinCells(content.activities), ...deferred.map((d) => ({ ...d, count: 1 }))];
  const unique = [...new Map(cells.map((c) => [`${c.month}|${c.category}`, c])).values()].slice(0, 3);
  if (!unique.length) return [];
  const seen = await loadSeen(deps.bucket);
  const t1 = deps.sources.sources.filter((s) => s.tier === 1 && s.kind === 'activity' && s.enabled !== false);
  const out: Extracted[] = [];
  for (const cell of unique) {
    // Known pages: seen URLs from tier-1 activity sources plus source pages of nearby activities.
    const pages = [
      ...Object.entries(seen.urls).filter(([, v]) => t1.some((s) => s.id === v.source)).map(([url, v]) => ({ url, date: v.first_seen })),
      ...content.activities.filter((a) => a.category === cell.category && Math.abs(a.month - cell.month) <= 3).map((a) => ({ url: a.source_url, title: a.title })),
    ];
    for (const url of rankPagesForCell(pages, cell, 3)) {
      const source = sourceForUrl(deps.sources, url);
      if (!source || source.kind !== 'activity') continue;
      const page = await fetchPage(deps.fetcher, url);
      if ('error' in page) continue;
      report.reached_gemini += 1;
      try {
        const r = await extractCandidates(deps.llm, page, source, { milestones: content.milestones, today, focus: { month: cell.month, category: cell.category } });
        for (const c of r.candidates)
          if ('month' in c.draft && c.draft.month === cell.month && c.draft.category === cell.category) out.push({ c: { ...c, purpose: 'coverage' }, page });
      } catch (e) {
        report.failures.push(`coverage extract ${url}: ${(e as Error).message}`.slice(0, 300));
      }
    }
  }
  info(`coverage guard: ${unique.length} thin cells, ${out.length} focused candidates`, { event: 'coverage_guard', cells: unique });
  return out;
}

export async function runWeekly(deps: JobDeps, today: string): Promise<RunReport> {
  const report = newReport('weekly', deps, today);
  const content = await ensureContent(deps);
  const seen = await loadSeen(deps.bucket);
  const runFrequency = Number(today.slice(8, 10)) <= 7 ? 'monthly' : 'weekly'; // first Monday also checks monthly sources

  // 1. content-watch: discovery
  const enabled = deps.sources.sources.filter((s) => s.enabled !== false);
  const results = await Promise.all(
    enabled.map((s) => discoverSource(s, deps.fetcher, seen, { today, firstRunWindowDays: deps.cfg.firstRunWindowDays, runFrequency })),
  );
  report.discovered = results.map((r) => r.stats);
  await saveSeen(deps.bucket, seen);
  await updateSourceHealth(deps, report, today);
  const items = results.flatMap((r) => r.items);
  info(`discovered ${items.length} new items`, { event: 'discovery', items: items.length });

  // 2. extract (new items + retries), then gates
  const skips: Record<string, number> = {};
  const extracted = (await pool(items, 6, (it) => processItem(deps, it, content, today, report, skips))).flat();
  const retries = await retryItems(deps, content, today, report);
  const all = [...extracted, ...retries];
  report.candidates = all.length;
  const gated = await gateAll(deps, all, content, today);
  report.skips = skips;

  // 3. maintenance: link check, date confirmation, coverage guard
  const health = (await readJson<LinkHealth>(deps.bucket, PATHS.linkHealth)) ?? { urls: {} };
  const links = await linkCheck(content, deps.fetcher, health, today);
  await writeJson(deps.bucket, PATHS.linkHealth, health);
  const split = splitRetirements(content, links.retire);
  for (const d of split.deferred) warn(`retirement of ${d.id} deferred: it would drop month ${d.month} ${d.category} below 2`, { event: 'retire_deferred', ...d });

  const dates = await dateConfirmation(deps, content, today, report);
  const dateGated = await gateAll(deps, dates.updates, content, today);

  const afterRetire = retireRecords(content, new Set(split.now.map((r) => r.id)));
  const coverage = await coverageGuard(deps, afterRetire, split.deferred, today, report);
  const covGated = await gateAll(deps, coverage, content, today);
  report.candidates += dates.updates.length + coverage.length;

  // 4. quotas (G8) on new items; updates bypass quotas
  const fresh = [...gated.passed, ...covGated.passed];
  const quota = g8Quotas(fresh, DEFAULT_QUOTAS, { loveveryShare: loveveryShare(content.activities) });
  const quarantine = quarantineOutcomes(report, [...gated.failed, ...dateGated.failed, ...covGated.failed, ...quota.rejected], deps.now);

  // Deferred retirements go ahead if accepted coverage candidates refill their cell.
  const refill = new Map<string, number>();
  for (const c of quota.accepted) if (c.purpose === 'coverage' && 'month' in c.draft) refill.set(`${c.draft.month}|${c.draft.category}`, (refill.get(`${c.draft.month}|${c.draft.category}`) ?? 0) + 1);
  const retire = [...split.now];
  for (const d of split.deferred) {
    const k = `${d.month}|${d.category}`;
    if ((refill.get(k) ?? 0) > 0) {
      refill.set(k, refill.get(k)! - 1);
      retire.push({ id: d.id, reason: d.reason });
    }
  }

  await finalize(deps, report, content, {
    accepted: [...quota.accepted, ...dateGated.passed],
    retire,
    patches: dates.patches,
    quarantine,
  });
  report.maintenance = {
    links_checked: links.checked,
    links_failing: links.failing.length,
    retire_deferred: split.deferred.map((d) => d.id),
    dates_confirmed: dates.confirmed,
    dates_not_found: dates.notFound,
    coverage_candidates: coverage.length,
  };
  await saveReport(deps, report);
  await digest(deps, report, today);
  return report;
}
