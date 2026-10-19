# baby steps

Mobile-first PWA for Singapore parents of children aged 0–36 months: milestones (CDC 2022), play
ideas by month, Singapore outings, and an in-browser swipe recommender. Phase 1 is a local MVP:
a fully static Next.js export with no server and no accounts. All user state stays on the device.

Spec: `SDD_baby_development_app.md` (v0.3.3). Visual design: Option B "Garden".

## Requirements
- Node 20+ (built and tested on Node 22), npm 10
- Python 3 for `npm run serve` (or use any static file server)

## Commands
```sh
npm install
npm run dev        # builds the catalog, then starts next dev on http://localhost:3000
npm test           # Vitest unit tests (catalog, recommender, search, outings, filters, state, age, visit ping)
npm run build      # catalog -> next build (static export to out/) -> generates out/sw.js
npm run serve      # serves out/ on http://localhost:3000
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
```

## Privacy
Birth month/year, saves, swipes, filters and "tried it" feedback live in one IndexedDB record
(`bd-state-v1`). Nothing is sent anywhere. The only network call that could carry data is the
`visitPing()` stub (`{day_first, month_first}`), which is disabled unless `NEXT_PUBLIC_VISIT_URL`
is set at build time. It is unset in Phase 1. Fonts are self-hosted. No third-party requests.
