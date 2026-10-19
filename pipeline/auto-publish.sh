#!/usr/bin/env bash
# Kill switch (SDD §8.7): turn auto-publishing on or off for all three pipeline jobs.
#   pipeline/auto-publish.sh false   # pause publishing: jobs still run, changes go to content/staged/{date}.json
#   pipeline/auto-publish.sh true    # publish automatically when every gate passes
# Takes effect at the next job run. No rebuild needed.
set -euo pipefail
VALUE="${1:-}"
[[ "$VALUE" == true || "$VALUE" == false ]] || { echo "usage: $0 true|false"; exit 2; }
PROJECT="${PROJECT:-dc-test2-489503}"
REGION="${REGION:-asia-southeast1}"
for JOB in babysteps-weekly babysteps-daily babysteps-monthly; do
  gcloud run jobs update "$JOB" --project "$PROJECT" --region "$REGION" --update-env-vars "AUTO_PUBLISH=${VALUE}" --quiet >/dev/null
  echo "${JOB}: AUTO_PUBLISH=${VALUE}"
done
