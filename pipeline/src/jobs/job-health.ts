/**
 * Consecutive-failure tracking for the alert "a job fails 2 runs in a row" (SDD §8.7).
 * state/job_health.json records each job's last status. A run that never finished (timeout, OOM,
 * crash) is still "running" when the next run starts and is counted as a failure then.
 * When the count reaches 2 the job logs event=pipeline_job_failed_repeatedly (ERROR), which a
 * log-based alert policy turns into an email.
 */
import type { Bucket } from '../gcp/storage';
import { readJson, writeJson } from '../gcp/storage';
import { error, info } from '../log';

export const JOB_HEALTH = 'state/job_health.json';

export interface JobState {
  status: 'running' | 'succeeded' | 'failed';
  consecutive_failures: number;
  started_at: string;
  finished_at?: string;
  last_error?: string;
  execution?: string;
}

export type JobHealth = Record<string, JobState>;

export async function jobStarted(b: Bucket, job: string, now: Date, execution?: string): Promise<JobState> {
  const all = (await readJson<JobHealth>(b, JOB_HEALTH)) ?? {};
  const prev = all[job];
  let consecutive = prev?.consecutive_failures ?? 0;
  if (prev?.status === 'running') {
    consecutive += 1; // previous run died without reporting
    reportFailure(job, consecutive, `previous run (${prev.execution ?? prev.started_at}) did not finish`);
  }
  const state: JobState = { status: 'running', consecutive_failures: consecutive, started_at: now.toISOString(), execution };
  all[job] = state;
  await writeJson(b, JOB_HEALTH, all);
  return state;
}

export async function jobFinished(b: Bucket, job: string, ok: boolean, now: Date, err?: string): Promise<JobState> {
  const all = (await readJson<JobHealth>(b, JOB_HEALTH)) ?? {};
  const cur = all[job] ?? { status: 'running', consecutive_failures: 0, started_at: now.toISOString() };
  const consecutive = ok ? 0 : cur.consecutive_failures + 1;
  const state: JobState = {
    ...cur,
    status: ok ? 'succeeded' : 'failed',
    consecutive_failures: consecutive,
    finished_at: now.toISOString(),
    last_error: ok ? undefined : err,
  };
  all[job] = state;
  await writeJson(b, JOB_HEALTH, all);
  if (!ok) reportFailure(job, consecutive, err ?? 'unknown error');
  else info('job succeeded', { event: 'pipeline_job_succeeded', job });
  return state;
}

function reportFailure(job: string, consecutive: number, reason: string) {
  error(`pipeline job ${job} failed (${consecutive} in a row): ${reason}`, {
    event: consecutive >= 2 ? 'pipeline_job_failed_repeatedly' : 'pipeline_job_failed',
    job,
    consecutive_failures: consecutive,
    reason: reason.slice(0, 500),
  });
}

export async function readJobHealth(b: Bucket): Promise<JobHealth> {
  return (await readJson<JobHealth>(b, JOB_HEALTH)) ?? {};
}
