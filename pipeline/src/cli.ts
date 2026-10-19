/**
 * baby steps content pipeline CLI (one container image, one subcommand per job).
 *
 *   weekly                 content-watch -> gates -> publish/stage -> link check -> date confirm -> coverage -> digest
 *   daily                  event expiry (publishes if content changed and AUTO_PUBLISH=true)
 *   monthly                venue re-check
 *   rollback [--to N]      repoint catalog/latest.json at version N (default: the previous version)
 *   publish-staged DATE    publish content/staged/DATE.json after a manual look (works with AUTO_PUBLISH=false)
 *   status                 latest version, content counts, job health, config
 *   validate               run full catalog validation (G9) on content/
 *   seed-content [--force] seed content/ from the image's data/*.json (migrated); never overwrites without --force
 *   migrate-repo           backfill lifecycle fields in the local repo's data/*.json (dev tool)
 *
 * Config comes from env vars (pipeline/src/config.ts): AUTO_PUBLISH, GEMINI_MODEL, CONTENT_BUCKET, SITE_URL, ...
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, sgtToday } from './config';
import { GcsBucket, readJson } from './gcp/storage';
import { error, info } from './log';
import { createFetcher } from './fetch/http';
import { loadSourcesFile } from './fetch/sources';
import { loadSafetyRules } from './gates/safety';
import { createVertexLlm } from './extract/vertex';
import { loadContent, PATHS, repoContent, saveContent, seedContent } from './content/store';
import { migrateActivities, migrateOutings } from './content/migrate';
import { publishCatalog, readLatest, rollback, validateForPublish } from './publish/publish';
import { jobFinished, jobStarted, readJobHealth } from './jobs/job-health';
import { runWeekly } from './jobs/weekly';
import { runDaily, runMonthly } from './jobs/daily-monthly';
import { applyStaged } from './content/merge';
import type { JobDeps } from './jobs/common';
import type { StagedFile } from './types';

const HELP = `usage: pipeline <command>
  weekly | daily | monthly        run a scheduled job
  rollback [--to N]               repoint catalog/latest.json (default: previous version)
  publish-staged YYYY-MM-DD       publish a staged file
  status | validate               inspect
  seed-content [--force]          seed content/ from data/*.json
  migrate-repo                    backfill lifecycle fields in local data/*.json`;

/** Repo root: /app in the image, or the checkout when run with tsx. */
export function findRoot(): string {
  const candidates = [process.env.PIPELINE_ROOT, process.cwd(), resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), resolve(dirname(fileURLToPath(import.meta.url)), '..')];
  for (const c of candidates) if (c && existsSync(join(c, 'pipeline', 'sources.yaml'))) return c;
  return process.cwd();
}

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]) {
  const cmd = argv[0];
  const cfg = loadConfig();
  const root = findRoot();
  const bucket = new GcsBucket(cfg.bucket);
  const now = new Date();
  const today = cfg.today ?? sgtToday(now);

  const deps = (): JobDeps => ({
    cfg,
    bucket,
    fetcher: createFetcher({ hostDelayMs: cfg.hostDelayMs }),
    llm: createVertexLlm({ project: cfg.project, location: cfg.vertexLocation, model: cfg.model, thinkingBudget: cfg.thinkingBudget }),
    sources: loadSourcesFile(join(root, 'pipeline', 'sources.yaml')),
    safety: loadSafetyRules(join(root, 'pipeline', 'safety_rules.yaml')),
    repoRoot: root,
    now,
    runId: process.env.CLOUD_RUN_EXECUTION || `local-${now.toISOString()}`,
    healthFetch: fetch,
  });

  switch (cmd) {
    case 'weekly':
    case 'daily':
    case 'monthly': {
      const d = deps();
      info(`${cmd} job starting`, { event: 'pipeline_job_started', job: cmd, auto_publish: cfg.autoPublish, model: cfg.model, today });
      await jobStarted(bucket, cmd, now, process.env.CLOUD_RUN_EXECUTION);
      try {
        const run = cmd === 'weekly' ? runWeekly : cmd === 'daily' ? runDaily : runMonthly;
        const report = await run(d, today);
        await jobFinished(bucket, cmd, true, new Date());
        console.log(JSON.stringify({ severity: 'INFO', message: `${cmd} report`, report_path: PATHS.run(cmd, today) }));
        return report;
      } catch (e) {
        await jobFinished(bucket, cmd, false, new Date(), String((e as Error).stack ?? e)).catch(() => {});
        throw e;
      }
    }
    case 'rollback': {
      const to = arg('--to', argv);
      const r = await rollback(bucket, to ? Number(to) : undefined);
      info(`rolled back catalog v${r.from} -> v${r.to}`, { event: 'catalog_rollback', ...r });
      return r;
    }
    case 'publish-staged': {
      const date = argv[1];
      if (!date) throw new Error('usage: publish-staged YYYY-MM-DD');
      const staged = await readJson<StagedFile>(bucket, PATHS.staged(date));
      if (!staged) throw new Error(`no staged file for ${date}`);
      const content = await loadContent(bucket);
      if (!content) throw new Error('content/ not seeded');
      const next = applyStaged(content, staged);
      const r = await publishCatalog(bucket, next, { now, health: { siteUrl: cfg.siteUrl } });
      if (!r.ok) throw new Error(`publish failed: ${r.errors.join('; ')}`);
      await saveContent(bucket, next);
      info(`published staged ${date} as catalog v${r.version}`, { event: 'catalog_published', version: r.version, counts: r.counts });
      return r;
    }
    case 'status': {
      const [latest, content, health] = await Promise.all([readLatest(bucket), loadContent(bucket), readJobHealth(bucket)]);
      const s = {
        config: { ...cfg },
        latest: latest?.pointer ?? null,
        content: content
          ? {
              activities: content.activities.length,
              published_activities: content.activities.filter((a) => a.status !== 'retired').length,
              outings: content.outings.length,
              published_outings: content.outings.filter((o) => o.status !== 'retired').length,
            }
          : null,
        jobs: health,
      };
      console.log(JSON.stringify(s, null, 2));
      return s;
    }
    case 'validate': {
      const content = await loadContent(bucket);
      if (!content) throw new Error('content/ not seeded');
      const v = validateForPublish(content);
      console.log(JSON.stringify({ errors: v.errors, warnings: v.warnings.length }, null, 2));
      if (v.errors.length) process.exitCode = 1;
      return v;
    }
    case 'seed-content': {
      const r = await seedContent(bucket, repoContent(root), argv.includes('--force'));
      info(`seed-content: ${r}`, { event: 'content_seeded', result: r });
      return r;
    }
    case 'migrate-repo': {
      const p = (f: string) => join(root, 'data', f);
      const acts = migrateActivities(JSON.parse(readFileSync(p('activities.json'), 'utf8')));
      const outs = migrateOutings(JSON.parse(readFileSync(p('sg_outings.json'), 'utf8')));
      writeFileSync(p('activities.json'), JSON.stringify(acts, null, 2) + '\n');
      writeFileSync(p('sg_outings.json'), JSON.stringify(outs, null, 2) + '\n');
      console.log(`migrated ${acts.length} activities, ${outs.length} outings`);
      return null;
    }
    default:
      console.error(HELP);
      throw new Error(`unknown command: ${cmd ?? '(none)'}`);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain || process.env.PIPELINE_CLI === '1') {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (e) => {
      error(`pipeline failed: ${(e as Error).message}`, { event: 'pipeline_error', stack: String((e as Error).stack ?? e).slice(0, 2000) });
      process.exit(1);
    },
  );
}

export { main };
