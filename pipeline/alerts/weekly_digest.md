What this email is: the weekly summary of the baby steps content pipeline: what it published, retired and quarantined, any failures, the catalog version, and visitor counts. Informational only; no action is needed.

- Week ending: ${log.extracted_label.week_ending}
- AUTO_PUBLISH: ${log.extracted_label.auto_publish}
- Published: ${log.extracted_label.published}
- Staged (not live): ${log.extracted_label.staged}
- Retired: ${log.extracted_label.retired}
- Quarantined: ${log.extracted_label.quarantined}
- Failures: ${log.extracted_label.failures}
- Catalog version: v${log.extracted_label.catalog_version}
- Gemini cost this week (USD): ${log.extracted_label.est_cost_usd}

Visitors (anonymous counts, Singapore dates; one device = one visitor):
- ${log.extracted_label.visitors_past}
- ${log.extracted_label.visitors_prev}
- ${log.extracted_label.visitors_month}

${log.extracted_label.summary}

Details in the content bucket: state/runs/, content/staged/, content/quarantine/.
