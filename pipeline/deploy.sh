#!/usr/bin/env bash
# Idempotent deploy of the Phase 3 content pipeline (SDD §8) to dc-test2-489503. Safe to re-run.
#   pipeline/deploy.sh                      # build a new image, update jobs, schedules and alerts
#   IMAGE=<uri> pipeline/deploy.sh          # skip the build, deploy an existing image
#   AUTO_PUBLISH=true pipeline/deploy.sh    # set the kill switch explicitly (otherwise the current value is kept;
#                                           # a first deploy defaults to false)
# Needs: gcloud (authenticated), curl, jq. No Docker: Cloud Build builds the image.
set -euo pipefail

PROJECT="${PROJECT:-dc-test2-489503}"
REGION="${REGION:-asia-southeast1}"
REPO="babysteps"
CONTENT_BUCKET="${PROJECT}-babysteps-content"
BUILD_BUCKET="${PROJECT}-babysteps-build"
BUILD_SA="babysteps-build@${PROJECT}.iam.gserviceaccount.com"
PIPE_SA="babysteps-pipeline@${PROJECT}.iam.gserviceaccount.com"
SCHED_SA="babysteps-scheduler@${PROJECT}.iam.gserviceaccount.com"
CHANNEL="${CHANNEL:-projects/${PROJECT}/notificationChannels/13065892833494038230}"
SITE_URL="${SITE_URL:-https://web-312918712586.asia-southeast1.run.app}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-2.5-flash}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# job name | CLI arg | cron (Asia/Singapore) | task timeout | memory
JOBS=(
  "babysteps-weekly|weekly|0 6 * * 1|10800s|1Gi"
  "babysteps-daily|daily|0 5 * * *|1800s|512Mi"
  "babysteps-monthly|monthly|0 7 1 * *|3600s|512Mi"
)

log() { printf '\n==> %s\n' "$*"; }
token() { gcloud auth print-access-token; }
api() { # api METHOD URL [BODY] -> body on stdout, HTTP_CODE set
  local method=$1 url=$2 body=${3:-} tmp; tmp=$(mktemp)
  if [[ -n "$body" ]]; then
    HTTP_CODE=$(curl -sS -o "$tmp" -w '%{http_code}' -X "$method" -H "Authorization: Bearer $(token)" \
      -H 'content-type: application/json' "$url" -d "$body")
  else
    HTTP_CODE=$(curl -sS -o "$tmp" -w '%{http_code}' -X "$method" -H "Authorization: Bearer $(token)" "$url")
  fi
  cat "$tmp"; rm -f "$tmp"
}
retry() { local n=$1; shift; for ((i = 1; i <= n; i++)); do "$@" && return 0; sleep $((i * 5)); done; return 1; }

log "Enabling APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  aiplatform.googleapis.com cloudscheduler.googleapis.com logging.googleapis.com monitoring.googleapis.com \
  iam.googleapis.com --project "$PROJECT"

log "Service accounts"
ensure_sa() {
  gcloud iam service-accounts describe "$1" --project "$PROJECT" >/dev/null 2>&1 ||
    gcloud iam service-accounts create "${1%%@*}" --project "$PROJECT" --display-name "$2"
}
ensure_sa "$PIPE_SA" "baby steps content pipeline (Cloud Run Jobs)"
ensure_sa "$SCHED_SA" "baby steps scheduler (starts pipeline jobs)"

log "IAM: ${PIPE_SA} (least privilege)"
retry 5 gcloud storage buckets add-iam-policy-binding "gs://${CONTENT_BUCKET}" \
  --member "serviceAccount:${PIPE_SA}" --role roles/storage.objectAdmin >/dev/null
# bigquery.jobUser: run the digest's read-only visitor query (SDD §9.1).
for role in roles/aiplatform.user roles/logging.logWriter roles/bigquery.jobUser; do
  retry 5 gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:${PIPE_SA}" \
    --role "$role" --condition=None >/dev/null
done
# Dataset-level roles/bigquery.dataViewer on the visit counts (READER is the legacy name the API returns).
BQ="https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}"
VISITS_DATASET="${VISITS_DATASET:-babysteps}"
grant_dataset_reader() {
  local ds etag body
  ds=$(api GET "${BQ}/datasets/${VISITS_DATASET}")
  [[ "$HTTP_CODE" == 200 ]] || { echo "dataset ${VISITS_DATASET} read failed (${HTTP_CODE})"; return 1; }
  if jq -e --arg sa "$PIPE_SA" '.access[] | select(.userByEmail == $sa and (.role == "READER" or .role == "roles/bigquery.dataViewer"))' <<<"$ds" >/dev/null; then
    echo "dataset ${VISITS_DATASET}: dataViewer grant exists"; return 0
  fi
  etag=$(jq -r .etag <<<"$ds")
  body=$(jq -c --arg sa "$PIPE_SA" '{access: (.access + [{role: "READER", userByEmail: $sa}])}' <<<"$ds")
  HTTP_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X PATCH -H "Authorization: Bearer $(token)" -H 'content-type: application/json' \
    -H "If-Match: ${etag}" "${BQ}/datasets/${VISITS_DATASET}" -d "$body")
  [[ "$HTTP_CODE" == 200 ]] && echo "dataset ${VISITS_DATASET}: dataViewer granted"
}
retry 5 grant_dataset_reader

if [[ -z "${IMAGE:-}" ]]; then
  TAG="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)-$(date -u +%Y%m%d%H%M%S)"
  [[ -z "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]] || TAG="${TAG}-dirty"
  IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/pipeline:${TAG}"
  log "Building ${IMAGE} with Cloud Build"
  gcloud builds submit "$ROOT" --project "$PROJECT" --region "$REGION" \
    --config "$ROOT/pipeline/cloudbuild.yaml" --substitutions "_IMAGE=${IMAGE}" \
    --service-account "projects/${PROJECT}/serviceAccounts/${BUILD_SA}" \
    --gcs-source-staging-dir "gs://${BUILD_BUCKET}/source"
fi

# Kill switch: keep the deployed value unless AUTO_PUBLISH is given; a first deploy is always false.
if [[ -z "${AUTO_PUBLISH:-}" ]]; then
  AUTO_PUBLISH=$(gcloud run jobs describe babysteps-weekly --project "$PROJECT" --region "$REGION" --format=json 2>/dev/null |
    jq -r '[.spec.template.spec.template.spec.containers[0].env[]? | select(.name=="AUTO_PUBLISH") | .value][0] // "false"' 2>/dev/null || echo false)
  AUTO_PUBLISH=${AUTO_PUBLISH:-false}
fi
log "AUTO_PUBLISH=${AUTO_PUBLISH}"
ENV_VARS="AUTO_PUBLISH=${AUTO_PUBLISH},GEMINI_MODEL=${GEMINI_MODEL},CONTENT_BUCKET=${CONTENT_BUCKET},SITE_URL=${SITE_URL},GCP_PROJECT=${PROJECT}"

log "Cloud Run Jobs, invoker grants and schedules"
for spec in "${JOBS[@]}"; do
  IFS='|' read -r JOB CMD CRON TIMEOUT MEM <<<"$spec"
  verb=create
  gcloud run jobs describe "$JOB" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1 && verb=update
  gcloud run jobs "$verb" "$JOB" --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
    --args "$CMD" --service-account "$PIPE_SA" --tasks 1 --max-retries 0 --task-timeout "$TIMEOUT" \
    --cpu 1 --memory "$MEM" --set-env-vars "$ENV_VARS" --labels app=babysteps,component=pipeline
  retry 5 gcloud run jobs add-iam-policy-binding "$JOB" --project "$PROJECT" --region "$REGION" \
    --member "serviceAccount:${SCHED_SA}" --role roles/run.invoker >/dev/null

  URI="https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/${JOB}:run"
  sverb=create
  gcloud scheduler jobs describe "$JOB" --project "$PROJECT" --location "$REGION" >/dev/null 2>&1 && sverb=update
  gcloud scheduler jobs "$sverb" http "$JOB" --project "$PROJECT" --location "$REGION" \
    --schedule "$CRON" --time-zone "Asia/Singapore" --uri "$URI" --http-method POST \
    --oauth-service-account-email "$SCHED_SA" --oauth-token-scope https://www.googleapis.com/auth/cloud-platform \
    --attempt-deadline 180s --description "baby steps pipeline: ${CMD}" >/dev/null
  echo "${JOB}: '${CRON}' Asia/Singapore -> ${CMD}"
done

log "Alert policies (email: ${CHANNEL})"
MON="https://monitoring.googleapis.com/v3/projects/${PROJECT}"
upsert_policy() { # upsert_policy JSON  (matched on displayName)
  local body=$1 name existing
  name=$(jq -r .displayName <<<"$body")
  local filter
  filter=$(jq -rn --arg n "$name" '"display_name=\"" + $n + "\"" | @uri')
  existing=$(api GET "${MON}/alertPolicies?filter=${filter}" | jq -r '.alertPolicies[0].name // empty')
  local out
  if [[ -n "$existing" ]]; then
    out=$(api PATCH "https://monitoring.googleapis.com/v3/${existing}" "$body"; echo "@@${HTTP_CODE}")
  else
    out=$(api POST "${MON}/alertPolicies" "$body"; echo "@@${HTTP_CODE}")
  fi
  HTTP_CODE=${out##*@@}
  [[ "$HTTP_CODE" == 200 ]] || { echo "alert policy '${name}' failed (${HTTP_CODE}): ${out%@@*}"; return 1; }
  echo "ok: ${name}"
}
JOBFILTER='resource.type="cloud_run_job" AND resource.labels.job_name=~"^babysteps-"'
log_policy() { # log_policy NAME FILTER DOC LABEL_EXTRACTORS_JSON SEVERITY
  jq -n --arg name "$1" --arg filter "$2" --arg doc "$3" --argjson labels "$4" \
    --arg sev "$5" --arg ch "$CHANNEL" '{
    displayName: $name, combiner: "OR", enabled: true, notificationChannels: [$ch],
    documentation: { content: $doc, mimeType: "text/markdown", subject: $name },
    conditions: [{ displayName: $name, conditionMatchedLog: { filter: $filter, labelExtractors: $labels } }],
    alertStrategy: { notificationRateLimit: { period: "300s" }, autoClose: "1800s", notificationPrompts: ["OPENED"] } }
    + (if $sev == "" then {} else { severity: $sev } end)'
}

# Notification texts. ${log.extracted_label.X} is filled in by Cloud Monitoring from the log entry.
# Digest email text and its label extractors: pipeline/alerts/ (tests/pipeline check they match the log entry).
DOC_DIGEST=$(cat "$ROOT/pipeline/alerts/weekly_digest.md")
DIGEST_LABELS=$(jq -c . "$ROOT/pipeline/alerts/weekly_digest_labels.json")
read -r -d '' DOC_JOBFAIL <<'EOF' || true
The ${log.extracted_label.job} pipeline job has failed ${log.extracted_label.consecutive} runs in a row.

Reason: ${log.extracted_label.reason}

Logs: Cloud Run > Jobs > babysteps-${log.extracted_label.job}. A failed run never changes the live catalog.
EOF
read -r -d '' DOC_SOURCE <<'EOF' || true
Source ${log.extracted_label.source} has returned errors ${log.extracted_label.weeks} weeks in a row.

Last error: ${log.extracted_label.last_error}

Fix its URL in pipeline/sources.yaml or set enabled: false, then redeploy.
EOF
read -r -d '' DOC_PUBLISH <<'EOF' || true
A catalog publish failed (version v${log.extracted_label.version}). If the new version went live and the health check failed, latest.json was rolled back automatically (rolled back: ${log.extracted_label.rolled_back}).

Check the job logs.
EOF

upsert_policy "$(log_policy "babysteps pipeline: weekly digest" "${JOBFILTER} AND jsonPayload.event=\"weekly_digest\"" "$DOC_DIGEST" \
  "$DIGEST_LABELS" \
  "")"
upsert_policy "$(log_policy "babysteps pipeline: job failed 2 runs in a row" "${JOBFILTER} AND jsonPayload.event=\"pipeline_job_failed_repeatedly\"" "$DOC_JOBFAIL" \
  '{"job":"EXTRACT(jsonPayload.job)","consecutive":"EXTRACT(jsonPayload.consecutive_failures)","reason":"EXTRACT(jsonPayload.reason)"}' ERROR)"
upsert_policy "$(log_policy "babysteps pipeline: source failing 3 weeks" "${JOBFILTER} AND jsonPayload.event=\"source_failing\"" "$DOC_SOURCE" \
  '{"source":"EXTRACT(jsonPayload.source)","weeks":"EXTRACT(jsonPayload.error_weeks)","last_error":"EXTRACT(jsonPayload.last_error)"}' WARNING)"
upsert_policy "$(log_policy "babysteps pipeline: publish failed or rolled back" "${JOBFILTER} AND jsonPayload.event=\"catalog_publish_failed\"" "$DOC_PUBLISH" \
  '{"version":"EXTRACT(jsonPayload.version)","rolled_back":"EXTRACT(jsonPayload.rolledBack)"}' ERROR)"

P5XX=$(jq -n --arg ch "$CHANNEL" '{
  displayName: "babysteps web: 5xx responses", combiner: "OR", severity: "ERROR", enabled: true,
  notificationChannels: [$ch],
  documentation: { mimeType: "text/markdown", subject: "babysteps web: 5xx responses",
    content: "The web Cloud Run service returned more than 5 server errors (HTTP 5xx) in 5 minutes. Check Cloud Run, service web, Logs. If a catalog publish just happened, the pipeline rollback command repoints latest.json to the previous version." },
  conditions: [{ displayName: "web 5xx > 5 in 5 min", conditionThreshold: {
    filter: "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"web\" AND metric.type=\"run.googleapis.com/request_count\" AND metric.labels.response_code_class=\"5xx\"",
    aggregations: [{ alignmentPeriod: "300s", perSeriesAligner: "ALIGN_SUM", crossSeriesReducer: "REDUCE_SUM" }],
    comparison: "COMPARISON_GT", thresholdValue: 5, duration: "0s", trigger: { count: 1 } } }],
  alertStrategy: { autoClose: "3600s" } }')
upsert_policy "$P5XX"

log "Uptime check on ${SITE_URL}/health (needs roles/monitoring.uptimeCheckConfigEditor)"
HOST=${SITE_URL#https://}
UPTIME=$(jq -n --arg host "$HOST" --arg p "$PROJECT" '{ displayName: "babysteps web /health",
  monitoredResource: { type: "uptime_url", labels: { project_id: $p, host: $host } },
  httpCheck: { path: "/health", port: 443, useSsl: true, validateSsl: true, requestMethod: "GET" },
  period: "300s", timeout: "10s", selectedRegions: ["ASIA_PACIFIC", "USA_OREGON", "EUROPE"] }')
existing=$(api GET "${MON}/uptimeCheckConfigs" | jq -r '.uptimeCheckConfigs[]? | select(.displayName=="babysteps web /health") | .name' 2>/dev/null || true)
if [[ -n "$existing" ]]; then
  echo "uptime check exists: ${existing}"
else
  api POST "${MON}/uptimeCheckConfigs" "$UPTIME" >/dev/null
  if [[ "$HTTP_CODE" == 200 ]]; then
    echo "uptime check created"
  else
    echo "NEEDS APPROVAL: uptime check not created (HTTP ${HTTP_CODE}). Grant roles/monitoring.uptimeCheckConfigEditor, then re-run."
  fi
fi
# Alert on the uptime check once it exists.
UPTIME_ID=$(api GET "${MON}/uptimeCheckConfigs" | jq -r '.uptimeCheckConfigs[]? | select(.displayName=="babysteps web /health") | .name | split("/") | last' 2>/dev/null || true)
if [[ -n "$UPTIME_ID" ]]; then
  PUP=$(jq -n --arg ch "$CHANNEL" --arg id "$UPTIME_ID" '{
    displayName: "babysteps web: /health down", combiner: "OR", severity: "CRITICAL", enabled: true, notificationChannels: [$ch],
    documentation: { mimeType: "text/markdown", content: "The /health uptime check on the web service is failing from 2+ regions." },
    conditions: [{ displayName: "uptime check failing", conditionThreshold: {
      filter: ("metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.labels.check_id=\"" + $id + "\""),
      aggregations: [{ alignmentPeriod: "600s", perSeriesAligner: "ALIGN_NEXT_OLDER", crossSeriesReducer: "REDUCE_COUNT_FALSE", groupByFields: ["resource.label.*"] }],
      comparison: "COMPARISON_GT", thresholdValue: 1, duration: "600s", trigger: { count: 1 } } }] }')
  upsert_policy "$PUP"
fi

log "Done. Image: ${IMAGE}"
echo "Run a job now:  gcloud run jobs execute babysteps-weekly --region ${REGION} --project ${PROJECT} --wait"
