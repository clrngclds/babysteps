# baby steps: Phase 3 content pipeline

Implements SDD §8: sources (§8.2), content-watch (§8.3), gates G1–G9 (§8.4), auto-publish and rollback (§8.5), maintenance (§8.6), visibility (§8.7) and guardrails (§8.8). Hosting follows §5.5, schemas §6.2, versioning §6.5 and the `paid` rule §3.8. Deployed to project `dc-test2-489503`, region `asia-southeast1`, on 2026-10-19.

**Status:** deployed with **AUTO_PUBLISH=false**. Every job runs, but changes go to `content/staged/{date}.json` and the live catalog stays on v2 until `safety_rules.yaml` has been reviewed and the switch is turned on.

## Architecture

```
Cloud Scheduler (3 jobs, Asia/Singapore)
  ├─ Mon 06:00  babysteps-weekly ─┐
  ├─ daily 05:00 babysteps-daily ─┼─► Cloud Run Jobs, one image (pipeline CLI), SA babysteps-pipeline
  └─ 1st 07:00  babysteps-monthly ┘        │
                                            ├─ fetch: sources.yaml → feeds / sitemaps / listing pages (browser UA, robots.txt, 1 req / 2 s / host)
                                            ├─ Gemini 2.5 Flash on Vertex AI (asia-southeast1): extraction + reviewer
                                            ├─ gates G1–G9 (scripts/catalog-lib.ts does all validation)
                                            └─ gs://dc-test2-489503-babysteps-content
                                                  content/   canonical records, staged/, quarantine/
                                                  state/     seen URLs, link/source/job health, run reports
                                                  catalog/   v{N}/ + latest.json  ◄── web service reads it (≤30 s)
Cloud Logging ─► log-based alert policies ─► email channel (doralyn@google.com)
```

**Weekly** (`weekly`):
1. Discovery: new URLs since the last run. A source's first run only records URLs; it processes just the items dated in the last 30 days.
2. Fetch each page. Tier-2 articles are resolved to the official or organizer page, or skipped.
3. Gemini extraction with structured output.
4. Gates, in order: G1, G3, G2, G4, G6, G7, then G5 (the AI reviewer), then G8 quotas. Fixable failures from last week are retried, up to 4 attempts.
5. Link check: 2 failed weeks in a row retires the item. A retirement that would drop a month × category below 2 is deferred until the coverage guard fills the cell.
6. Date confirmation.
7. Coverage guard.
8. Merge, then G9 full catalog validation, then publish (or stage). Publishing writes `catalog/v{N+1}/`, then `latest.json`, then health-checks the live site; if the check fails, it rolls back automatically.
9. Weekly digest.

**Daily** (`daily`): event expiry. Published events whose end date (or start date, if there is no end date) has passed are set to `retired`. The job also publishes any content change that isn't live yet.

**Monthly** (`monthly`): venue re-check. Gemini compares each stored venue with its current page.
- Closures, with a quote verified on the page, are retired.
- Changes such as renames or new prices go through the gates as updates.
- Unchanged venues get `last_verified` updated.

**Code** (TypeScript, Node 22, in this repo; reuses `scripts/catalog-lib.ts` for validation and catalog builds):

| Path | What |
|---|---|
| `pipeline/sources.yaml` | All §8.2.1/§8.2.2 sources, tiers, detection, filters (verified 2026-10-19) |
| `pipeline/safety_rules.yaml` | G4 deterministic safety rules, written for review |
| `pipeline/src/fetch/` | Polite fetcher, robots.txt, RSS/Atom/sitemap/listing parsers, discovery + seen state, tier-2 resolution |
| `pipeline/src/extract/` | Vertex AI REST client, response schemas, prompts, extraction, G5 reviewer, venue compare |
| `pipeline/src/gates/` | G1–G9, safety rule engine, text similarity, quotas |
| `pipeline/src/content/` | Migration, canonical store, merge / ids, staged merge |
| `pipeline/src/publish/` | Publish, live health check, rollback |
| `pipeline/src/maintenance/` | Link check, expiry, date confirmation, coverage guard |
| `pipeline/src/jobs/` | weekly / daily / monthly runners, job health, digest |
| `pipeline/src/cli.ts` | CLI entry point (one subcommand per job + admin commands) |
| `pipeline/Dockerfile`, `cloudbuild.yaml`, `deploy.sh`, `auto-publish.sh` | Image, build, deploy, kill switch |

**Data changes (migration):**
- `data/activities.json` (620) and `data/sg_outings.json` (62) are backfilled with `added_at: "2026-10-18"`, `status: "published"` and `origin: "seed"`. They are appended at the end of each record; field order and `paid` are unchanged.
- The first job run seeded `content/` in the bucket from this data. From now on, `content/` is canonical and the repo's `data/` is a snapshot.
- `scripts/catalog-lib.ts` validates the new fields: ISO `added_at`, `status` published|retired, `origin` seed|pipeline. The fields are optional, so old data still validates.
- The record checks are exported as `validateActivity` / `validateOuting`, and `buildCatalog` drops retired outings.
- Web app: retired outings are filtered on load, and `isNew` ignores `origin: seed`, so the 620 seed activities don't show "New this week".

## GCP resources created (all labelled `app=babysteps`)

| Resource | Name | Notes |
|---|---|---|
| API enabled | `cloudscheduler.googleapis.com` | Other APIs used were already enabled |
| Service account | `babysteps-pipeline@dc-test2-489503.iam.gserviceaccount.com` | Runtime identity of the 3 jobs |
| Service account | `babysteps-scheduler@dc-test2-489503.iam.gserviceaccount.com` | Used by Cloud Scheduler to start the jobs |
| Cloud Run Job | `babysteps-weekly` | args `weekly`, 1 vCPU, 1 GiB, timeout 3 h, 0 retries |
| Cloud Run Job | `babysteps-daily` | args `daily`, 1 vCPU, 512 MiB, timeout 30 min, 0 retries |
| Cloud Run Job | `babysteps-monthly` | args `monthly`, 1 vCPU, 512 MiB, timeout 1 h, 0 retries |
| Cloud Scheduler | `babysteps-weekly`, `babysteps-daily`, `babysteps-monthly` (asia-southeast1) | HTTP POST to the Cloud Run Admin API `jobs/{job}:run`, OAuth as `babysteps-scheduler` |
| Container image | `asia-southeast1-docker.pkg.dev/dc-test2-489503/babysteps/pipeline:<sha>-<time>` | In the existing `babysteps` repo (keep-latest-5 cleanup policy) |
| Alert policy | babysteps pipeline: weekly digest | Log match `jsonPayload.event="weekly_digest"`, label extractors, email |
| Alert policy | babysteps pipeline: job failed 2 runs in a row | Log match `pipeline_job_failed_repeatedly` |
| Alert policy | babysteps pipeline: source failing 3 weeks | Log match `source_failing` |
| Alert policy | babysteps pipeline: publish failed or rolled back | Log match `catalog_publish_failed` |
| Alert policy | babysteps web: 5xx responses | `run.googleapis.com/request_count`, service `web`, 5xx > 5 in 5 min |
| Bucket prefixes | `content/`, `state/` in `gs://dc-test2-489503-babysteps-content` | `catalog/` is written only through publish/rollback |

Build-time resources reused (not changed): Cloud Build with `babysteps-build@` and the staging bucket `gs://dc-test2-489503-babysteps-build/source`, the Artifact Registry repo `babysteps`, and the notification channel `13065892833494038230`. The `web` service, its service account and the bucket settings were not touched.

## IAM grants (all to service accounts created here; no human roles changed)

| Member | Role | Scope |
|---|---|---|
| `babysteps-pipeline@` | `roles/storage.objectAdmin` | bucket `dc-test2-489503-babysteps-content` only |
| `babysteps-pipeline@` | `roles/aiplatform.user` | project |
| `babysteps-pipeline@` | `roles/logging.logWriter` | project |
| `babysteps-scheduler@` | `roles/run.invoker` | each of the 3 jobs (job-level policy) |

No service account keys. Tokens come from the metadata server on Cloud Run, or from `gcloud auth print-access-token` locally. No public buckets and no `allUsers` grants.

## Schedules (Asia/Singapore)

| Job | Cron | When |
|---|---|---|
| babysteps-weekly | `0 6 * * 1` | Mondays 06:00 SGT. The first Monday of each month also reads the monthly-frequency (festival) sources. |
| babysteps-daily | `0 5 * * *` | Every day 05:00 SGT |
| babysteps-monthly | `0 7 1 * *` | 1st of each month 07:00 SGT |

## How to

**Run a job now**
```sh
gcloud run jobs execute babysteps-weekly --region asia-southeast1 --project dc-test2-489503 --wait
# or through the scheduler (same path as production):
gcloud scheduler jobs run babysteps-weekly --location asia-southeast1 --project dc-test2-489503
```
Results:
- run report: `state/runs/{job}/{date}.json`
- staged changes: `content/staged/{date}.json`
- failed candidates: `content/quarantine/{date}.json`
- logs: Cloud Run > Jobs > (job) > Logs

**Admin commands.** Run them in the cloud by overriding the job args:
```sh
gcloud run jobs execute babysteps-daily --region asia-southeast1 --args=status --wait
gcloud run jobs execute babysteps-daily --region asia-southeast1 --args=validate --wait
```
Or locally, as yourself, from the repo:
```sh
export PATH=$HOME/.local/bin:$PATH && npm ci
npx tsx pipeline/src/cli.ts status
```
Commands: `weekly | daily | monthly | rollback [--to N] | publish-staged DATE | status | validate | seed-content [--force] | migrate-repo`.

**Flip AUTO_PUBLISH (kill switch)**
```sh
pipeline/auto-publish.sh true    # publish automatically when every gate passes
pipeline/auto-publish.sh false   # pause: jobs keep running, changes are staged only
```
The change applies from the next run. `pipeline/deploy.sh` keeps the deployed value unless `AUTO_PUBLISH=` is passed.

**Publish what was staged** (after looking at the file):
```sh
gcloud run jobs execute babysteps-weekly --region asia-southeast1 --args=publish-staged,2026-10-19 --wait
```
This re-validates (G9), builds `v{N+1}`, health-checks the site and saves `content/`. Field updates listed under `update` aren't in the staged file; they are applied by the next run.

**Roll back**
```sh
gcloud run jobs execute babysteps-daily --region asia-southeast1 --args=rollback --wait          # to the previous version
gcloud run jobs execute babysteps-daily --region asia-southeast1 --args=rollback,--to,2 --wait   # to v2
```
Rollback only repoints `catalog/latest.json`, and refuses incomplete version folders. Instances pick it up within about 30 s, and clients switch on their next open. Turn AUTO_PUBLISH off first if the next run shouldn't publish again.

**Add a source:** copy an entry in `pipeline/sources.yaml` (the instructions are at the top of the file). Set id, name, tier, kind, detection, urls and domains, plus optional include/exclude/keywords. Run `npx vitest run tests/pipeline/fetch.test.ts`; it validates the real file. Then run `pipeline/deploy.sh` to rebuild the image.

**Edit safety rules:** edit `pipeline/safety_rules.yaml`. The header explains block vs require_note, `below_month` and `unless`. Add `examples` for every change; `npx vitest run tests/pipeline/safety.test.ts` checks each example. Then run `pipeline/deploy.sh`. An unreadable rules file stops the run; the pipeline never publishes unchecked.

**Change the model:** `GEMINI_MODEL=gemini-2.5-flash-lite pipeline/deploy.sh`. flash-lite is served from Vertex location `global` (picked automatically); flash is served from asia-southeast1. Thinking is off (`GEMINI_THINKING_BUDGET=0`).

**Redeploy / update:** `pipeline/deploy.sh`. It is idempotent: it builds with Cloud Build and updates jobs, schedules, IAM and alert policies. Use `IMAGE=<uri> pipeline/deploy.sh` to skip the build.

## Visibility

- **Weekly digest.** It goes by email using Google Cloud only:
  - The weekly job writes one structured log entry: `{"event":"weekly_digest", week_ending, auto_publish, published, staged, retired, quarantined, failures, catalog_version, est_cost_usd, summary}`. The summary is ≤900 characters and lists titles, retirements and failures.
  - A log-based alert policy matches the entry, pulls each value out with label extractors, and puts them in the email via `${log.extracted_label.*}`.
  - Notification rate limit 5 min, auto-close 30 min, notify on open only.
  - Full numbers are in `state/runs/`.
- **Job fails 2 runs in a row.** Each job records its status in `state/job_health.json`.
  - A run that crashed or timed out is still marked "running" when the next run starts, and counts as a failure then.
  - At 2 consecutive failures the job logs `pipeline_job_failed_repeatedly` (ERROR), which emails.
- **Source errors 3 weeks in a row** (`state/source_health.json`) log `source_failing`, which emails.
- **Publish failed or rolled back** logs `catalog_publish_failed`, which emails.
- **web 5xx:** more than 5 server errors in 5 minutes sends an email.
- **Uptime check on `/health`:** not created, needs a role (see "needs approval").

## Dry-run results (2026-10-19)

Full report: `pipeline/reports/dry-run-2026-10-19.md`. The weekly job was started through Cloud Scheduler; it took 9 minutes and ended with no errors.
- **Discovery:** 2,298 URLs listed; 2,150 recorded without processing (first run); 67 selected.
- **Gemini:** 43 pages reached it, giving 27 candidates. 15 passed every gate (8 activities, 7 outings) and are staged; 12 were quarantined (G2: 6, G5: 3, G7: 2, G6: 1).
- **Token use:** 185k input, 11k output tokens, about $0.08.
- **Link check:** 415 URLs, 0 failing.
- **Date confirmation:** 1 of 6 events confirmed.
- **Coverage:** no gaps.
- **Daily job:** no events have ended yet. The migration was staged, and v3 was **not** published.
- **Fixed after the run:**
  - quotes that joined separate lines;
  - outing ages defaulting to 0–36;
  - outing names failing the copy check;
  - same-day staged files overwriting each other.

## Tests

`npx vitest run`: **385 tests in 13 files, all passing.** The original 107 pass unchanged and 278 are new. `npx tsc --noEmit` is clean.

| File | Covers |
|---|---|
| `tests/pipeline/fetch.test.ts` | RSS/Atom/sitemap/listing parsers with trimmed real fixtures, first-run seeding, caps, keyword filters, robots.txt, per-host rate limit (fake clock), retries, htmlToText, extractDates, tier-2 resolution, the real sources.yaml |
| `tests/pipeline/extract.test.ts` | Vertex request shape (regional vs global, schema, safety settings, thinking), JSON parsing, retries, blocked responses, usage, normalisation, reviewer threshold, venue compare, prompt content |
| `tests/pipeline/gates.test.ts`, `safety.test.ts` | Every gate: grounding (quotes, keywords, copy runs), allow-list, every safety rule using its own YAML examples, honey at 11/12 months, dedupe ±2 months, events, quotas (11→10, 6→5 per source, 31→30, Montessori priority), G9 |
| `tests/pipeline/publish.test.ts` | Migration (order, idempotence, validation), merge / ids, publish to a mock bucket (folder before pointer, health-check rollback, stale site, G9 refusal, half-written versions, generation preconditions), rollback CLI logic, job health, digest |
| `tests/pipeline/jobs.test.ts` | End-to-end weekly and daily jobs with a fake web, fake Gemini and fake site: staging vs publishing, quarantine, 2-week link retirement, expiry publish, maintenance helpers |
| `tests/pipeline/integration-fixes.test.ts`, `tests/lifecycle-fields.test.ts` | Dry-run fixes, publish-staged, staged merge; web app tolerance of the new fields |

## Estimated monthly cost

| Item | Estimate |
|---|---|
| Gemini 2.5 Flash | First run $0.08. Steady state: about 20–60 pages a week plus 37 venues a month, roughly **$0.3–1.0/month** |
| Cloud Run Jobs | About 4.3 weekly × 10 min + 30 daily × 1 min + 1 monthly × 10 min ≈ 1.6 vCPU-hours. Within the free tier: **$0** |
| Cloud Scheduler | 3 jobs: **$0** (free tier) |
| Cloud Build | About 1 min per deploy: **$0** |
| Cloud Storage | A catalog version is about 2.5 MB; weekly versions plus state come to well under 1 GB: **<$0.05** |
| Artifact Registry | Pipeline image about 80 MB × 5 kept: **<$0.05** |
| Cloud Monitoring alert policies | 5 conditions (priced per condition): **about $0.50** |
| Logging | Small volume, within the free allotment: **$0** |
| **Total** | **About $1–2 per month** |

## Needs approval

1. **Uptime check on `/health`.** The human account lacks `roles/monitoring.uptimeCheckConfigEditor` (the API returned 403). If approved:
   ```sh
   gcloud projects add-iam-policy-binding dc-test2-489503 \
     --member user:admin@doralyn.altostrat.com --role roles/monitoring.uptimeCheckConfigEditor
   pipeline/deploy.sh   # creates the "babysteps web /health" check (3 regions, every 5 min) and its alert policy
   ```
2. **Redeploy the `web` service** to ship the web-app changes. I didn't redeploy it because I didn't create it.
   - What changes: `isNew` ignores seed content, and retired outings are filtered on load.
   - Without it: once v3 is published, seed activities show "New this week" until 2026-10-25 (7 days after `added_at` 2026-10-18). After that date there's no visible effect. Retired outings are already dropped by the catalog build.
   - Command: `deploy/deploy.sh` (the Phase 2 script; it never overwrites a published catalog version).
3. **Review `pipeline/safety_rules.yaml`, then switch on publishing:** `pipeline/auto-publish.sh true`. Optionally publish today's staged candidates first with `publish-staged 2026-10-19` (see "How to").
4. **Source decisions:**
   - Montessori Academy returns 403 to Cloud Run (it works from a desktop IP), so the source-failing alert will fire after 3 weeks. Disable it or accept the alert.
   - How We Montessori, Science Centre KidsSTOP and Children's Museum are disabled (TLS/Cloudflare, AWS bot challenge, 403).
   - `gov.sg` is in `official_domains`, so tier-2 finds may resolve to any government site. G3 accepts `official_domains` as tier 1 for those pages.

## Known limits

- **Health check:** the post-publish check fetches `/health`, `/catalog/latest.json` and v{N+1} files. It doesn't load the catalog in a headless browser (SDD §8.5 mentions one). It confirms the files the app loads are served and parse.
- **First-run backlog:** sources without dates (OnePA, Esplanade, NParks, Gardens by the Bay, listing pages) contribute only from the second run, when new URLs appear. The first run recorded their current URLs without processing them.
- **Seed content vs new rules:** the safety rules flag 87 of the 620 seed activities (mostly notes that say "arm's reach" instead of "supervise", plus a few balloon, coin and necklace activities). Seed content isn't re-checked.
- **Food rule:** a general "food needs a safety note" rule was left out because it gave too many false positives. The AI reviewer (G5) covers unsafe food.
- **Tier-2 article fetches:** 10 of 31 failed from Cloud Run (blocked). Those items are skipped and the counts appear in the run report.
