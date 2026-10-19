# baby steps

Mobile-first PWA for Singapore parents of children aged 0–36 months: milestones (CDC 2022), play
ideas by month, Singapore outings, and an in-browser swipe recommender. The app is a static
Next.js export with no accounts; all user state stays on the device. Phase 2 hosts it on Cloud Run
(`web`, asia-southeast1) behind a small Node server: see `deploy/README.md`.

Spec: `SDD_baby_development_app.md` (v0.3.3). Visual design: Option B "Garden".

## Requirements
- Node 20+ (built and tested on Node 22), npm 10

## Commands
```sh
npm install
npm run dev        # builds the catalog, then starts next dev on http://localhost:3000
npm test           # Vitest unit tests (catalog, recommender, search, outings, filters, state, age, visit ping)
npm run build      # catalog -> next build (static export to out/) -> generates out/sw.js
npm run precompress # optional: writes .br/.gz next to text assets in out/
npm run serve      # serves out/ with server/server.mjs on http://localhost:3000
npm run catalog    # only rebuild public/catalog/ from data/*.json
npm run typecheck
```
`CATALOG_VERSION=2 npm run catalog` writes `public/catalog/v2/` and points `latest.json` at it.
`CATALOG_STRICT=1` turns published-set coverage gaps into build errors.

The service worker is only registered in production builds (`npm run build && npm run serve`).

## Layout
```
data/                    source content (activities, milestones, sg_outings)
scripts/build-catalog.ts validate + publish data to public/catalog/v{N}/ and latest.json
scripts/catalog-lib.ts   pure validation/build logic (tested)
scripts/postbuild-sw.mjs writes out/sw.js with the precache list (template: scripts/sw-template.js)
src/app/                 routes: / (Today), /milestones, /milestone?id=, /activity?id=, /for-you, /outings, /outing?id=, /settings
src/components/          UI (shell, cards, sheets, swipe deck, search overlay, onboarding)
src/lib/recommender/     in-browser recommender (§7), pure TypeScript
src/lib/                 age, state (IndexedDB), filters, search (MiniSearch), outings, analytics stub
tests/                   Vitest
qa/                      optional headless-Chrome screenshot/audit scripts
server/                  production server: static export, bucket-backed /catalog, POST /api/visit
deploy/                  deploy.sh (idempotent GCP setup + Cloud Run deploy), cloudbuild.yaml
Dockerfile               multi-stage image (Node 22 build, slim non-root runtime)
```

## Privacy
Birth month/year, saves, swipes, filters and "tried it" feedback live in one IndexedDB record
(`bd-state-v1`). The only data sent is the once-a-day visit ping `{day_first, month_first}` to
same-origin `/api/visit` (SDD §9.1). It is enabled in production builds by `.env.production`
(`NEXT_PUBLIC_VISIT_URL=/api/visit`) and off in `next dev`. The server stores one BigQuery row
(Singapore date + the two flags) and no IP, user agent or ID; request logs for that path are
excluded from Cloud Logging. Fonts are self-hosted. No third-party requests.
