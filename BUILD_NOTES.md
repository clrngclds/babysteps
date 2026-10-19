# baby steps: Phase 1 build notes

Built 2026-10-19 against SDD v0.3.3 plus the explicit product decisions in the build brief.
Stack: Next.js 15.5 (App Router, `output: 'export'`), React 19, TypeScript, plain CSS with
custom properties, `idb-keyval`, MiniSearch, Vitest 5.

## How to run
```sh
npm install
npm run dev          # http://localhost:3000 (rebuilds the catalog first)
npm test             # 80 unit tests
npm run build        # catalog -> static export in out/ -> out/sw.js
npm run serve        # python3 -m http.server 3000 --directory out
```
- The service worker registers only in production builds, so test PWA and offline behaviour with `build` + `serve`.
- Any static server works for `out/`. Routes use trailing slashes (`/milestones/`), and detail pages use query strings (`/activity/?id=…`).
- The `.npmrc` points at the public npm registry, because the build machine's global npm config used a corporate mirror. Delete it if your environment needs a different registry.

## What was built, per work item

| Item | Status | Notes |
|---|---|---|
| **P1.1 Setup** | Done | Next.js static export. Garden tokens from SDD §4.4 as CSS variables, with `sage-strong #3F7A50` for buttons, links and selected chips and `ink-muted #66736A` for secondary text. Fraunces (500–700) and DM Sans (400–700) are self-hosted from the provided latin-subset variable woff2 files via `next/font/local`. Mobile and tablet (<1200px) get a bottom nav with 4 tabs and header search and settings icons. Desktop (≥1200px) gets a left sidebar (Today, Milestones, For You, Outings, Settings) and a top search bar. Tablet (768–1199px) gets the two-column month view. Desktop gets a 320px milestones column plus a 3-column activity grid. |
| **P1.2 Catalog build** | Done | `scripts/build-catalog.ts` with pure logic in `scripts/catalog-lib.ts`. It validates unique IDs across all files, every enum, month range, sources, outing dates and age ranges, ≥2 activities per month×category, and that milestone references resolve. It drops `verified:false` items and writes `public/catalog/v1/` (`milestones.json`, `activities.json`, `outings.json`, `by_month/00–36.json`, `milestone_to_activities.json`) and `public/catalog/latest.json`. 9 tests. |
| **P1.3 Onboarding, state, Settings** | Done | Onboarding asks only for birth month and year (two selects), rejects future dates, and shows a note for children over 36 months (content is clamped to 36). One IndexedDB record, `bd-state-v1`, holds `birth: "YYYY-MM"`, interactions (capped at 2,000), favorites, milestonesSeen, tagAffinity, filters, lastPing, visit count and catalogVersion. Age is computed in Asia/Singapore time on every open. Settings lets the user change the birth month, has a privacy section ("Saved on this phone only", eviction caveats), "Clear my data" (deletes the IndexedDB record, Cache Storage and the SW registration) and about/sources. Verified in headless Chrome that state survives a reload and a new tab. |
| **P1.4 Today** | Done | Month chip strip 0–36, defaulting to the child's age, with a "Back to N months" link when viewing another month. "Coming up by N months" (or "Milestones by N months" at a checkpoint) shows one milestone per category, with "See all N" expanding the full list grouped by category. Category chips, plus a "Filters (n)" bottom sheet for setting, energy, duration (≤5 / ≤15 / 15+) and Hide paid, with a live result count. Filters are saved on the device. Activities are grouped by category in collapsible sections. Cards show a category-colour thumbnail, title, "10 min · Indoor" and ♡. On tablet and desktop, an "Out & about this weekend" card links to outings. Activity detail shows title, age, category, facts, summary, safety notes above how-to steps, materials, builds-toward milestones, ♡ Save, "We tried it" → "Did they enjoy it?" (yes / meh / not ready), and a small Source link at the bottom. There are no philosophy or cost badges. Today loads a ~5 KB `by_month` file first. The full catalog loads at idle after first paint. |
| **P1.5 Milestones** | Done | The index is grouped by category, then by checkpoint age, with jump chips and a "coming up" marker. The detail page has a category-colour header, a builds-toward timeline (sage line, `sage-strong` dots, activities sorted by month, earlier months labelled "builds toward"), the next milestone in the same category, an optional "Mark as seen" (BMi-3, fed to the recommender), and the §9.2 disclaimer with HealthHub, the Health Booklet, the "loses skills → see a doctor" note and the CDC source. |
| **P1.6 Search** | Done | Header search overlay, available on every tab (also opens with `/` on desktop). Uses MiniSearch over milestone text, activity title, summary and materials, and outing name, summary and location. Prefix matching, plural folding, and case- and punctuation-insensitive matching ("Peek-a-boo!" finds "peekaboo"; hyphenated words are indexed both split and joined). Results are grouped Milestones / Activities / Outings, with activities near the child's age ranked first. The index is built on the device from the cached catalog. MiniSearch is lazy-loaded with the overlay (5.6 KB gz). The query lives only in component state: it is not in the URL, not stored and not sent. Verified working offline. |
| **P1.7 Outings** | Done | Filters: This weekend, Rain-OK, Region (select) and Hide paid (shared with the activity toggle). Results are filtered by the child's age, and past events are hidden automatically. Cards show a date line ("Sat 21 Nov", "From 20 Nov", "Until 8 Nov", "Regular programme", "Open most days"), title, location · region, a **Paid** tag (ink background, white text) only when paid, and "dates TBC" when `dates_confirmed:false`. The detail page shows when, where, ages, weather, booking, `price_note` (paid items only), the estimated-dates note, notes and an Official page button. There is no "Free" tag anywhere. |
| **P1.8 For You** | Done | Discover and Saved (n) tabs. A mandatory age gate once per session ("Recommending for a 16-month-old · Born June 2025", with "Yes, show ideas" / "Change birth month"), then an age bar ("For a 16-month-old · born Jun 2025 · Change"). Swipe deck with pointer swipes (mouse, touch, pen): right = like + save, left = not for us, up = not ready. Three buttons (✕ / ⏳ / ♥) cover every gesture. Fly-out animation and card tilt are turned off under `prefers-reduced-motion`. After 8 swipes it shows "Picked for you" (top 10 with template reasons), then "Keep swiping" continues with a re-ranked deck. Returning users with 8 or more swipes land on picks. The Saved tab lists items newest first, with un-save. Recommender: `src/lib/recommender/`, 44 unit tests (see below). |
| **P1.9 PWA** | Done | `manifest.webmanifest` with 192 and 512 PNG icons, a maskable icon, an SVG icon and an apple-touch-icon. `out/sw.js` is generated at build time: it precaches the app shell (49 files: HTML, RSC payloads, JS, CSS, fonts, icons) and the current catalog version (41 files). Versioned catalog files are cache-first. `latest.json` is network-first and cached for offline. Navigations are network-first with a cached-shell fallback. The `latest.json` version check runs on every open: if a newer version is found, the cached version keeps showing, the new files download in the background, and the switch happens on the next screen change (verified with a mock v2). An add-to-home-screen banner appears from the 2nd session: on Chromium it uses `beforeinstallprompt`, on iOS Safari it shows Share → Add to Home Screen instructions. `navigator.storage.persist()` is requested when onboarding completes and on first save. |
| **P1.10 QA** | Done | See below. |

## Test results
`npm test`: **4 files, 80 tests, all passing.**

| File | Tests | Covers |
|---|---|---|
| `tests/recommender.test.ts` | 44 | Candidate window [age−2, age+1] and exclusions (swiped, saved, tried, unverified, Hide paid). Not-ready items return after 28 days and not before. Every interaction weight, unsave reversal for browse and swipe saves, 30-day half-life (a 30-day-old like = 0.5), score weights 0.60/0.25/0.15. Re-rank: ≥4 categories, ≤4 per category, 2 exploration slots from least-rated categories, dedupe. Seed deck of 8 covering all 6 categories. Reason templates. Real-data smoke test at ages 0, 7, 16 and 36. |
| `tests/catalog.test.ts` | 9 | Real data validates. Duplicate, enum and broken-reference detection. Coverage rule. Strict mode. Unverified items dropped (616 published). 37 by-month files with current and next checkpoint. Reverse index. `latest.json`. |
| `tests/app-lib.test.ts` | 22 | Search (plurals, prefixes, punctuation, age ranking, grouping). Outings (weekend range, past events, all filters, date labels). Filters (count, indoor/either, duration buckets, category). Device state (right-swipe writes like + save, newest-first saves, 2,000 cap, normalisation). `visitPing` (day/month flags, disabled without a URL, sends only the two flags). |
| `tests/age.test.ts` | 5 | Age formula, clamp at 36, future-date rejection, Singapore time zone, `YYYY-MM` parsing. |

`npm run build` passes with type checking. The static export was served with `python3 -m http.server` and checked in headless Chrome.

### Browser QA (headless Chrome, `qa/audit.mjs`, `qa/swipe.mjs`)
- **Onboarding:** shown on first open. A future month is rejected with a message. After Continue, Today opens at "16 months" for a June 2025 birth. The same holds after a reload and in a new tab.
- **Swipe gestures:** a pointer drag right writes `swipe_like` and `save:swipe`, and Saved goes to (1). A drag up writes `swipe_not_ready`.
- **Offline:** after the first visit the service worker is active. With the network off, Today, a milestone detail page and search all work.
- **Third-party requests:** none.
- **Colour contrast:** 0 failures on all text elements across 8 screens. The DOM audit computes each text node's colour against its effective background, at 4.5:1 for normal text and 3:1 for large text. Token ratios:

| Pair | Ratio |
|---|---|
| ink on bg / surface | 10.93 / 11.70 |
| ink-muted on bg / surface | 4.64 / 4.97 |
| white on sage-strong (buttons, selected chips) | 5.11 |
| sage-strong on bg / surface (links) | 4.77 / 5.11 |
| white on ink (Paid tag) | 11.70 |
| ink on blush / butter / category fills | 8.7–10.2 |
| ink-muted on category fill | 4.00 (fails, so it is not used: muted text is never placed on category fills) |

- **Tap targets:** every interactive element is ≥48×48 px except 5 inline text links inside sentences (HealthHub, Source, cdc.gov), which fall under the WCAG 2.5.8 inline exception. Card title links stretch over the whole card. Month chips draw a 42 px circle (per §4.4) inside a 50×52 px button. Chips draw a 36 px pill inside a 48 px button.

### Screenshots
Taken at 390×844 (mobile): `onboarding`, `today`, `filters-sheet`, `milestone-detail`, `for-you` (deck), `for-you-picks`, `for-you-saved`, `outings`, `outing-detail`, `activity-detail`, `search`, `milestones`, `settings`. Also `today-desktop` (1440×900) and `today-tablet` (900×1100).

## Bundle size
Measured from `out/`, gzip level 9, excluding the `nomodule` polyfills:

| | Gzipped |
|---|---|
| Initial JS, Today (`/`) | **118.3 KB** (budget 170 KB) |
| Initial JS, For You (largest route) | 120.7 KB |
| Shared framework JS (Next reports) | 103 KB |
| CSS | 5.5 KB |
| Lazy chunks | search overlay with MiniSearch 5.6 KB, plus 3.4 KB |
| Fonts (2 variable woff2, latin) | 101.8 KB raw (already compressed) |
| Catalog: activities + milestones + outings | 630 KB raw / 141 KB gz, loaded at idle after first paint |
| `by_month/16.json` (Today's first data request) | 5.5 KB gz |

## Deviations from the SDD and why
1. **Detail pages use query strings** (`/activity/?id=…`, `/milestone/?id=…`, `/outing/?id=…`) rather than one pre-generated page per item (§5.2 "pages generated at build"). With a static export, a per-item page can't exist for content added by a later catalog version without an app release (§6.5). Three shells are also far cheaper to precache for offline use than ~800 HTML files. Links are still shareable. Trade-off: no per-item HTML for SEO or link previews.
2. **Coverage rule:** the "≥2 activities per month×category" check is a hard error on the source data and a warning on the published set (`CATALOG_STRICT=1` makes it an error). Dropping the 4 unverified items leaves **month 7 / language with 1 activity**, and milestone **lang-09-2 with no linked activity** (the dropped "Up?" before lifting). Failing the build would block Phase 1 on a content fix. This needs a content decision: retag, replace, or accept.
3. **One activity source URL is `http://`** (act-m25-oth-03, Bronxville Montessori). It is allowed with a warning instead of failing https validation.
4. **Duration "15+"** means ≥15 min, so a 15-minute activity matches both "≤15" and "15+". This follows the labels.
5. **Selected category and outing chips use `sage-strong` with white text**, per the brief. The mockup used ink for "All" and "This weekend".
6. **Outings "This weekend"** includes venues (open most days) and programmes whose recurrence mentions weekends, as well as dated events overlapping the coming Saturday–Sunday. Region is a select inside a chip.
7. **Interaction `ts` is in milliseconds** (the SDD example shows seconds), to match `Date.now()`.
8. **Age gate** asks once per browser session (and again if the birth month changes), instead of before every visit to the tab. It can't be skipped for a session.
9. **The "seen" milestone toggle (BMi-3, P1) is included** because it was cheap and the recommender already uses `milestonesSeen`.
10. **Placeholder imagery** is emoji chosen by title keywords with a category fallback, as in the mockup (open question 6).
11. **The Today header has no "▾" month dropdown.** The month chip strip covers month selection.
12. **Brand name** is "baby steps", per the brief. The mockup's desktop logo said "littlesteps".

## Known gaps and TODOs for Phase 2
- **Content:** fix month 7 language coverage and lang-09-2 linkage (see deviation 2). Switch act-m25-oth-03 to https or a new source. The data has no `added_at`, so the "New" badge (AD-4) and the "New this week" reason never trigger. Backfill when the pipeline lands.
- **Outings in recommendations** (SG-4 / §7.6, P1) are not built.
- **RC-5:** "tried it" feedback is weighted (+2.0 / −0.5) but there's no prompt to rate tried items from For You.
- **Catalog pruning:** the service worker never deletes old `catalog/v{N}/` entries after a version switch. Add pruning on activate or on switch.
- **Version switch for detail pages:** if a newer catalog retires an item that is open, the page shows "not available". Retired items stay in on-device history (§6.5) but nothing marks them in Saved.
- **iOS install prompt** is a text banner only. A first-visit explainer could improve install rates.
- **Analytics:** the `visitPing()` stub is wired up but has no endpoint. Phase 2 needs the Cloud Run `visit-counter` and `NEXT_PUBLIC_VISIT_URL` at build time.
- **Desktop search** opens a modal from the top bar rather than showing inline results under the bar.
- **Accessibility:** run a manual screen-reader pass (VoiceOver and TalkBack) on the swipe deck and bottom sheet. Automated checks only covered contrast and target size.
- **Performance:** LCP, INP and CLS were not measured on a real mid-range Android over 4G. Today renders a skeleton until IndexedDB and the by-month file load.
- **Export/import of device data** (P2), localisation (§6.4), corrected age for premature babies: out of scope.
- **Dependency audit:** `npm audit` reports a moderate/high advisory in the `postcss` version bundled inside Next 15.5 (build-time only, not shipped to the browser). Revisit when moving to Next 16.
- `qa/` scripts need `puppeteer-core` installed separately (see `qa/README.md`).
