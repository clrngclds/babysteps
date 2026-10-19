#!/usr/bin/env bash
# Idempotent deploy of the baby steps web app (SDD §5.5) to Cloud Run. Safe to re-run.
#   deploy/deploy.sh              # create/update everything, build a new image, deploy
#   IMAGE=<uri> deploy/deploy.sh  # skip the build and deploy an existing image
# Needs: gcloud (authenticated), node + npm (for the catalog build), curl, jq.
set -euo pipefail

PROJECT="${PROJECT:-dc-test2-489503}"
REGION="${REGION:-asia-southeast1}"
SERVICE="${SERVICE:-web}"
REPO="babysteps"
CONTENT_BUCKET="${PROJECT}-babysteps-content"
BUILD_BUCKET="${PROJECT}-babysteps-build"
WEB_SA="babysteps-web@${PROJECT}.iam.gserviceaccount.com"
BUILD_SA="babysteps-build@${PROJECT}.iam.gserviceaccount.com"
DATASET="babysteps"
TABLE="visits"
EXCLUSION="babysteps-visit-requests"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

log() { printf '\n==> %s\n' "$*"; }
token() { gcloud auth print-access-token; }

# REST call helper: api METHOD URL [JSON_BODY] -> prints body, sets HTTP_CODE
api() {
  local method=$1 url=$2 body=${3:-}
  local tmp; tmp=$(mktemp)
  if [[ -n "$body" ]]; then
    HTTP_CODE=$(curl -sS -o "$tmp" -w '%{http_code}' -X "$method" -H "Authorization: Bearer $(token)" \
      -H 'content-type: application/json' "$url" -d "$body")
  else
    HTTP_CODE=$(curl -sS -o "$tmp" -w '%{http_code}' -X "$method" -H "Authorization: Bearer $(token)" "$url")
  fi
  cat "$tmp"; rm -f "$tmp"
}

retry() { # retry N cmd...: new service accounts take a few seconds to become usable in IAM
  local n=$1; shift
  for ((i = 1; i <= n; i++)); do "$@" && return 0; sleep $((i * 5)); done
  return 1
}

gcloud config set project "$PROJECT" >/dev/null 2>&1 || true

log "Enabling APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  bigquery.googleapis.com storage.googleapis.com iam.googleapis.com logging.googleapis.com \
  monitoring.googleapis.com --project "$PROJECT"

log "Service accounts"
ensure_sa() {
  local email=$1 name=${1%%@*} display=$2
  gcloud iam service-accounts describe "$email" --project "$PROJECT" >/dev/null 2>&1 ||
    gcloud iam service-accounts create "$name" --project "$PROJECT" --display-name "$display"
}
ensure_sa "$WEB_SA" "baby steps web (Cloud Run runtime)"
ensure_sa "$BUILD_SA" "baby steps image builds (Cloud Build)"

log "Artifact Registry repo ${REPO} (keep latest 5 images)"
AR="https://artifactregistry.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/repositories"
CLEANUP='{"keep-latest-5":{"id":"keep-latest-5","action":"KEEP","mostRecentVersions":{"keepCount":5}},
          "delete-others":{"id":"delete-others","action":"DELETE","condition":{"tagState":"ANY"}}}'
api GET "${AR}/${REPO}" >/dev/null
if [[ "$HTTP_CODE" == 404 ]]; then
  api POST "${AR}?repositoryId=${REPO}" \
    "{\"format\":\"DOCKER\",\"description\":\"baby steps images\",\"cleanupPolicyDryRun\":false,\"cleanupPolicies\":${CLEANUP}}"
  [[ "$HTTP_CODE" == 200 ]] || { echo "repo create failed ($HTTP_CODE)"; exit 1; }
  for _ in $(seq 1 20); do api GET "${AR}/${REPO}" >/dev/null; [[ "$HTTP_CODE" == 200 ]] && break; sleep 3; done
else
  echo "repo exists"
fi

log "Buckets"
if ! gcloud storage buckets describe "gs://${CONTENT_BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${CONTENT_BUCKET}" --project "$PROJECT" --location "$REGION" \
    --uniform-bucket-level-access --public-access-prevention
fi
cat >/tmp/babysteps-content-lifecycle.json <<'JSON'
{"rule":[{"action":{"type":"Delete"},"condition":{"isLive":false,"daysSinceNoncurrentTime":30}}]}
JSON
gcloud storage buckets update "gs://${CONTENT_BUCKET}" --versioning --public-access-prevention \
  --uniform-bucket-level-access --lifecycle-file=/tmp/babysteps-content-lifecycle.json

if ! gcloud storage buckets describe "gs://${BUILD_BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BUILD_BUCKET}" --project "$PROJECT" --location "$REGION" \
    --uniform-bucket-level-access --public-access-prevention
fi
cat >/tmp/babysteps-build-lifecycle.json <<'JSON'
{"rule":[{"action":{"type":"Delete"},"condition":{"age":7}}]}
JSON
gcloud storage buckets update "gs://${BUILD_BUCKET}" --lifecycle-file=/tmp/babysteps-build-lifecycle.json

log "BigQuery dataset ${DATASET} and table ${TABLE}"
BQ="https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}"
api POST "${BQ}/datasets" "{\"datasetReference\":{\"projectId\":\"${PROJECT}\",\"datasetId\":\"${DATASET}\"},
  \"location\":\"${REGION}\",\"description\":\"baby steps anonymous visit counts (SDD 9.1)\"}" >/dev/null
[[ "$HTTP_CODE" == 200 || "$HTTP_CODE" == 409 ]] || { echo "dataset create failed ($HTTP_CODE)"; exit 1; }
api POST "${BQ}/datasets/${DATASET}/tables" "{\"tableReference\":{\"projectId\":\"${PROJECT}\",\"datasetId\":\"${DATASET}\",\"tableId\":\"${TABLE}\"},
  \"description\":\"One row per anonymous visit ping: Singapore date + first-open-today/this-week/this-month flags. No IP, UA or ID.\",
  \"timePartitioning\":{\"type\":\"DAY\",\"field\":\"date\"},
  \"schema\":{\"fields\":[
    {\"name\":\"date\",\"type\":\"DATE\",\"mode\":\"REQUIRED\",\"description\":\"Visit date in Asia/Singapore\"},
    {\"name\":\"day_first\",\"type\":\"BOOL\",\"mode\":\"REQUIRED\"},
    {\"name\":\"month_first\",\"type\":\"BOOL\",\"mode\":\"REQUIRED\"},
    {\"name\":\"week_first\",\"type\":\"BOOL\",\"mode\":\"NULLABLE\",\"description\":\"First visit in this ISO week (SGT). NULL from clients older than 2026-10-19\"}]}}" >/dev/null
[[ "$HTTP_CODE" == 200 || "$HTTP_CODE" == 409 ]] || { echo "table create failed ($HTTP_CODE)"; exit 1; }
# Tables created before week_first existed: add the column in place (schema update, no recreate).
# This runs before the service deploy, so the new server never inserts into a table without it.
ensure_week_first() {
  local t etag body
  t=$(api GET "${BQ}/datasets/${DATASET}/tables/${TABLE}")
  # (api runs in a subshell here, so HTTP_CODE isn't set: check the body instead)
  jq -e '.schema.fields' <<<"$t" >/dev/null || { echo "table read failed: $(jq -r '.error.message // .' <<<"$t")"; return 1; }
  if jq -e '.schema.fields[] | select(.name == "week_first")' <<<"$t" >/dev/null; then
    echo "column week_first exists"; return 0
  fi
  etag=$(jq -r .etag <<<"$t")
  body=$(jq -c '{schema: {fields: (.schema.fields + [{name: "week_first", type: "BOOL", mode: "NULLABLE",
    description: "First visit in this ISO week (SGT). NULL from clients older than 2026-10-19"}])}}' <<<"$t")
  HTTP_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X PATCH -H "Authorization: Bearer $(token)" -H 'content-type: application/json' \
    -H "If-Match: ${etag}" "${BQ}/datasets/${DATASET}/tables/${TABLE}" -d "$body")
  [[ "$HTTP_CODE" == 200 ]] && echo "column week_first added"
}
retry 3 ensure_week_first

log "IAM: ${WEB_SA}"
retry 5 gcloud storage buckets add-iam-policy-binding "gs://${CONTENT_BUCKET}" \
  --member "serviceAccount:${WEB_SA}" --role roles/storage.objectViewer >/dev/null
# Dataset-level roles/bigquery.dataEditor (WRITER is the legacy name the API returns for it).
grant_dataset_writer() {
  local ds etag
  ds=$(api GET "${BQ}/datasets/${DATASET}")
  if jq -e --arg sa "$WEB_SA" '.access[] | select(.userByEmail == $sa and (.role == "WRITER" or .role == "roles/bigquery.dataEditor"))' <<<"$ds" >/dev/null; then
    echo "dataset grant exists"; return 0
  fi
  etag=$(jq -r .etag <<<"$ds")
  local body; body=$(jq -c --arg sa "$WEB_SA" '{access: (.access + [{role: "WRITER", userByEmail: $sa}])}' <<<"$ds")
  HTTP_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X PATCH -H "Authorization: Bearer $(token)" -H 'content-type: application/json' \
    -H "If-Match: ${etag}" "${BQ}/datasets/${DATASET}" -d "$body")
  [[ "$HTTP_CODE" == 200 ]]
}
retry 5 grant_dataset_writer

log "IAM: ${BUILD_SA}"
retry 5 gcloud storage buckets add-iam-policy-binding "gs://${BUILD_BUCKET}" \
  --member "serviceAccount:${BUILD_SA}" --role roles/storage.objectViewer >/dev/null
for role in roles/artifactregistry.writer roles/logging.logWriter; do
  retry 5 gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:${BUILD_SA}" \
    --role "$role" --condition=None >/dev/null
done

log "Catalog: seed the content bucket (never overwrites a published version)"
cd "$ROOT"
[[ -d node_modules ]] || npm ci --no-audit --no-fund
npm run --silent catalog
LOCAL_V=$(jq -r .version public/catalog/latest.json)
if [[ -n "$(gcloud storage ls "gs://${CONTENT_BUCKET}/catalog/v${LOCAL_V}/" 2>/dev/null | head -1)" ]]; then
  echo "catalog/v${LOCAL_V}/ already published; leaving it as is"
else
  gcloud storage cp -r "public/catalog/v${LOCAL_V}" "gs://${CONTENT_BUCKET}/catalog/"
fi
REMOTE_V=$(gcloud storage cat "gs://${CONTENT_BUCKET}/catalog/latest.json" 2>/dev/null | jq -r '.version // 0' || echo 0)
REMOTE_V=${REMOTE_V:-0}
if (( REMOTE_V < LOCAL_V )); then
  gcloud storage cp public/catalog/latest.json "gs://${CONTENT_BUCKET}/catalog/latest.json" \
    --content-type=application/json --cache-control=no-cache
else
  echo "bucket latest.json is v${REMOTE_V} (local v${LOCAL_V}); not touching it"
fi

if [[ -z "${IMAGE:-}" ]]; then
  TAG="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)-$(date -u +%Y%m%d%H%M%S)"
  [[ -z "$(git status --porcelain 2>/dev/null)" ]] || TAG="${TAG}-dirty"
  IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/web:${TAG}"
  log "Building ${IMAGE} with Cloud Build"
  gcloud builds submit "$ROOT" --project "$PROJECT" --region "$REGION" \
    --config "$ROOT/deploy/cloudbuild.yaml" --substitutions "_IMAGE=${IMAGE}" \
    --service-account "projects/${PROJECT}/serviceAccounts/${BUILD_SA}" \
    --gcs-source-staging-dir "gs://${BUILD_BUCKET}/source"
fi

log "Deploying Cloud Run service ${SERVICE}"
gcloud run deploy "$SERVICE" --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --service-account "$WEB_SA" --no-invoker-iam-check --ingress all \
  --min-instances 0 --max-instances 5 --cpu 1 --memory 512Mi --concurrency 80 --cpu-throttling \
  --port 8080 --timeout 30s \
  --set-env-vars "CONTENT_BUCKET=${CONTENT_BUCKET},BQ_DATASET=${DATASET},BQ_TABLE=${TABLE},GCP_PROJECT=${PROJECT}" \
  --labels app=babysteps

log "Logging: exclude /api/visit request logs from the _Default sink (SDD 9.1)"
FILTER="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICE}\" AND log_id(\"run.googleapis.com/requests\") AND httpRequest.requestUrl:\"/api/visit\""
if gcloud logging sinks describe _Default --project "$PROJECT" --format=json | jq -e --arg n "$EXCLUSION" '.exclusions // [] | map(.name) | index($n)' >/dev/null; then
  gcloud logging sinks update _Default --project "$PROJECT" --update-exclusion="name=${EXCLUSION},filter=${FILTER}"
else
  gcloud logging sinks update _Default --project "$PROJECT" \
    --add-exclusion="name=${EXCLUSION},description=baby steps visit pings: do not store request logs,filter=${FILTER}"
fi

URL=$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')
log "Done: ${URL}"
# run.app reserves /healthz (Cloud Run known issue: paths ending in "z"), so probe /health.
curl -fsS "${URL}/health" && echo
