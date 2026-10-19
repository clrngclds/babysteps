/**
 * Canonical content and pipeline state in the content bucket.
 *   content/activities.json, content/milestones.json, content/sg_outings.json  canonical records
 *   content/quarantine/{date}.json   failed candidates with reasons (debug only)
 *   content/staged/{date}.json       what would have been published when AUTO_PUBLISH=false
 *   state/seen_urls.json             discovery state
 *   state/link_health.json           consecutive link-check failures per item
 *   state/source_health.json         consecutive weeks with fetch errors per source
 *   state/runs/{job}/{date}.json     run reports (digest input)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Bucket } from '../gcp/storage';
import { readJson, writeJson } from '../gcp/storage';
import type { ContentSet, MilestonesFile, QuarantineFile, RunReport, SeenState, StagedFile, Activity, Outing } from '../types';
import { migrateActivities, migrateOutings } from './migrate';

export const PATHS = {
  activities: 'content/activities.json',
  milestones: 'content/milestones.json',
  outings: 'content/sg_outings.json',
  quarantine: (date: string) => `content/quarantine/${date}.json`,
  staged: (date: string) => `content/staged/${date}.json`,
  seen: 'state/seen_urls.json',
  linkHealth: 'state/link_health.json',
  sourceHealth: 'state/source_health.json',
  run: (job: string, date: string) => `state/runs/${job}/${date}.json`,
  latest: 'catalog/latest.json',
};

export async function loadContent(b: Bucket): Promise<ContentSet | null> {
  const [activities, milestones, outings] = await Promise.all([
    readJson<Activity[]>(b, PATHS.activities),
    readJson<MilestonesFile>(b, PATHS.milestones),
    readJson<Outing[]>(b, PATHS.outings),
  ]);
  if (!activities || !milestones || !outings) return null;
  return { activities, milestones, outings };
}

export async function saveContent(b: Bucket, c: ContentSet): Promise<void> {
  // Milestones never change in the pipeline; activities and outings are written together.
  await writeJson(b, PATHS.activities, c.activities);
  await writeJson(b, PATHS.outings, c.outings);
  await writeJson(b, PATHS.milestones, c.milestones);
}

/** Repo data/*.json (bundled in the image), migrated. */
export function repoContent(root: string): ContentSet {
  const read = (f: string) => JSON.parse(readFileSync(join(root, 'data', f), 'utf8'));
  return {
    activities: migrateActivities(read('activities.json')),
    milestones: read('milestones.json'),
    outings: migrateOutings(read('sg_outings.json')),
  };
}

/**
 * Seeds content/ from the repo data if it isn't there yet. Never overwrites existing canonical
 * content unless `force` is set. Returns what happened.
 */
export async function seedContent(b: Bucket, repo: ContentSet, force = false): Promise<'seeded' | 'exists'> {
  const existing = await b.read(PATHS.activities);
  if (existing && !force) return 'exists';
  await saveContent(b, repo);
  return 'seeded';
}

export async function loadSeen(b: Bucket): Promise<SeenState> {
  return (await readJson<SeenState>(b, PATHS.seen)) ?? { version: 1, initialized: {}, urls: {} };
}

export const saveSeen = (b: Bucket, s: SeenState) => writeJson(b, PATHS.seen, s);

/** Appends entries to the day's quarantine file (several jobs may write on the same day). */
export async function appendQuarantine(b: Bucket, file: QuarantineFile): Promise<void> {
  if (!file.entries.length) return;
  const prev = await readJson<QuarantineFile>(b, PATHS.quarantine(file.date));
  const merged: QuarantineFile = prev ? { ...file, entries: [...prev.entries, ...file.entries] } : file;
  await writeJson(b, PATHS.quarantine(file.date), merged);
}

export const saveStaged = (b: Bucket, s: StagedFile) => writeJson(b, PATHS.staged(s.date), s);
export const saveRun = (b: Bucket, r: RunReport) => writeJson(b, PATHS.run(r.job, r.date), r);

/** Quarantine files from the last `days` days (newest first), for retries and the digest. */
export async function recentQuarantine(b: Bucket, sinceDate: string): Promise<QuarantineFile[]> {
  const names = (await b.list('content/quarantine/')).filter((n) => n.endsWith('.json'));
  const wanted = names.filter((n) => n.slice('content/quarantine/'.length, -5) >= sinceDate).sort().reverse();
  const files = await Promise.all(wanted.map((n) => readJson<QuarantineFile>(b, n)));
  return files.filter((f): f is QuarantineFile => !!f);
}
