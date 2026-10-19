# Deploying baby steps (Phase 2)

Design: SDD §5.5 (hosting in `dc-test2-489503`), §6.5 (catalog versions), §9.1 (visit counts).
One Cloud Run service, `web`, serves the static export, the catalog (from a private bucket) and
`POST /api/visit`. It is public through `--no-invoker-iam-check`; there is no `allUsers` binding.

```sh
deploy/deploy.sh                  # create or update everything, build an image, deploy
IMAGE=<uri> deploy/deploy.sh      # redeploy an existing image without building
```
Needs gcloud (authenticated), node + npm (to build the catalog), curl and jq. Docker is not
needed: images are built by Cloud Build. Every step checks before it creates, so the script can be
re-run at any time. `PROJECT`, `REGION` and `SERVICE` can be overridden through environment variables.

## What the script manages

| Resource | Name | Notes |
|---|---|---|
| APIs | run, cloudbuild, artifactregistry, bigquery, storage, iam, logging, monitoring | `gcloud services enable` |
| Artifact Registry (Docker) | `asia-southeast1/babysteps` | Cleanup policy: keep the 5 most recent versions, delete the rest |
| Bucket | `gs://dc-test2-489503-babysteps-content` | asia-southeast1, uniform access, public access prevention, versioning; noncurrent versions deleted after 30 days |
| Bucket | `gs://dc-test2-489503-babysteps-build` | Cloud Build source staging; objects deleted after 7 days |
| Service account | `babysteps-web@` | Cloud Run runtime identity |
| Service account | `babysteps-build@` | Cloud Build identity for image builds |
| BigQuery | dataset `babysteps` (asia-southeast1), table `visits` | `date DATE, day_first BOOL, month_first BOOL`, day-partitioned on `date` |
| Cloud Run | `web` (asia-southeast1) | 1 vCPU, 512Mi, concurrency 80, 0–5 instances, CPU only during requests |
| Log exclusion | `_Default` sink, `babysteps-visit-requests` | Drops Cloud Run request logs for `/api/visit` on `web` |

## IAM

| Member | Role | Scope |
|---|---|---|
| `babysteps-web@` | `roles/storage.objectViewer` | content bucket |
| `babysteps-web@` | `roles/bigquery.dataEditor` (WRITER) | dataset `babysteps` |
| `babysteps-build@` | `roles/storage.objectViewer` | build staging bucket |
| `babysteps-build@` | `roles/artifactregistry.writer` | project (the deploying user can't set repo-level IAM) |
| `babysteps-build@` | `roles/logging.logWriter` | project |

`roles/bigquery.jobUser` is not granted: inserts use `tabledata.insertAll`, which needs only table write access.

## Catalog publishing (Phase 3 contract)
- The server reads `catalog/latest.json` and `catalog/v{N}/…` from the content bucket using its
  service account. `latest.json` is cached in memory for 30 s; versioned files are cached until the
  instance stops (max 500 entries). If the bucket can't be read, it serves the last copy it had,
  then the copy baked into the image.
- To publish: write a complete `catalog/v{N+1}/`, then overwrite `catalog/latest.json`. No redeploy.
  Instances pick it up within about 30 s. Rollback: point `latest.json` back at an older version.
- `deploy.sh` only seeds the bucket. It never overwrites an existing `catalog/v{N}/` and only
  writes `latest.json` if the bucket's version is lower than the repo's.

## Endpoints and headers
- `/health`: liveness. `/healthz` is also handled, but run.app reserves it (Cloud Run known issue:
  paths ending in "z" return a Google 404), so use `/health` against the live URL.
- `POST /api/visit`: `application/json`, body exactly `{"day_first": bool, "month_first": bool}`,
  max 256 bytes, same origin if `Origin` is sent. 204 on success; 400/403/405/413/415 otherwise;
  503 if BigQuery rejects the insert.
- Cache-Control: `/_next/static/*` and `/catalog/v{N}/*` 1 year immutable; `latest.json`, `sw.js`,
  HTML, RSC `.txt` and the manifest `no-cache`; icons 30 days.
- CSP is same-origin only. Each HTML page carries sha256 hashes of its inline Next bootstrap scripts
  (no `'unsafe-inline'` for scripts); `style-src-attr 'unsafe-inline'` covers the skeleton `style=""` attributes.

## Reports
```sql
-- daily visitors
SELECT date, COUNTIF(day_first) AS daily_visitors
FROM `dc-test2-489503.babysteps.visits` GROUP BY date ORDER BY date DESC;
-- monthly visitors
SELECT DATE_TRUNC(date, MONTH) AS month, COUNTIF(month_first) AS monthly_visitors
FROM `dc-test2-489503.babysteps.visits` GROUP BY month ORDER BY month DESC;
```

## Notes
- The `bq` CLI fails on this workstation (mTLS client-certificate bug), so the script calls the
  BigQuery REST API with curl instead.
- New exclusions on the `_Default` sink took about 3–4 minutes to take effect.
- Local run: `npm run build && npm run precompress && npm run serve` (port 3000). Without
  `CONTENT_BUCKET` the catalog comes from `out/`; `/api/visit` returns 503 without GCP credentials.

## Phase 3: content pipeline
The automated content pipeline (SDD §8) is deployed separately by `pipeline/deploy.sh` as three Cloud Run Jobs
(`babysteps-weekly`, `babysteps-daily`, `babysteps-monthly`) that publish through the contract above. See
`pipeline/PIPELINE_NOTES.md` for resources, IAM, schedules, the AUTO_PUBLISH kill switch and rollback.
