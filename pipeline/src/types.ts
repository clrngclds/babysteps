/**
 * Shared types for the Phase 3 content pipeline (SDD §8). Every module codes against these.
 * Keep this file dependency-free (types only, plus a few small constants).
 */
import type { Activity, Milestone, MilestonesFile, Outing } from '../../src/lib/types';

export type { Activity, Milestone, MilestonesFile, Outing };

/* ----------------------------------------------------------------------------------------------
 * Sources (pipeline/sources.yaml, SDD §8.2)
 * -------------------------------------------------------------------------------------------- */

export type SourceKind = 'activity' | 'outing';
export type Detection = 'feed' | 'sitemap' | 'listing';

export interface SourceConfig {
  /** Stable id, e.g. "lovevery-blog". Used in state files and quotas. */
  id: string;
  name: string;
  /** 1 = official/organizer (publishable). 2 = aggregator (discovery only). */
  tier: 1 | 2;
  kind: SourceKind;
  detection: Detection;
  /** Feed URL, sitemap URL(s) or listing page URL(s). */
  urls: string[];
  /** Hostnames that belong to this source (G3 allow-list for tier 1; www. is ignored when matching). */
  domains: string[];
  /** Regexes; a discovered URL must match at least one (if given). */
  include?: string[];
  /** Regexes; a discovered URL matching any is dropped. */
  exclude?: string[];
  /** Case-insensitive keywords; the item title/summary/URL must contain at least one (if given). */
  keywords?: string[];
  /** Regexes on child sitemap URLs inside a sitemap index (if given, only matching children are read). */
  child_sitemaps?: string[];
  /** Default philosophy tags for activity sources (e.g. ["montessori"]). */
  philosophy?: string[];
  /** Max items from this source sent to extraction per run (default 15). */
  max_items_per_run?: number;
  /** "weekly" (default) or "monthly" (e.g. festival sites, venue lists). */
  frequency?: 'weekly' | 'monthly';
  enabled?: boolean;
  notes?: string;
}

export interface SourcesFile {
  version: number;
  /** Extra official domains (gov.sg sites, organisers) that tier-2 items may resolve to. */
  official_domains?: string[];
  sources: SourceConfig[];
}

/* ----------------------------------------------------------------------------------------------
 * Fetching and discovery
 * -------------------------------------------------------------------------------------------- */

export interface FetchResult {
  url: string;
  finalUrl: string;
  /** HTTP status, or 0 for network error / robots disallow / timeout. */
  status: number;
  ok: boolean;
  contentType: string;
  body: string;
  /** e.g. "robots_disallowed", "timeout", "network: ..." */
  error?: string;
}

export interface FetchOptions {
  accept?: string;
  /** Default false. Robots is always honoured for page fetches; only health checks of our own site skip it. */
  skipRobots?: boolean;
  timeoutMs?: number;
  method?: 'GET' | 'HEAD';
}

/** Polite HTTP client: full browser UA, robots.txt, 1 request / 2 s per host. */
export interface Fetcher {
  get(url: string, opts?: FetchOptions): Promise<FetchResult>;
}

export interface FeedItem {
  url: string;
  title?: string;
  /** ISO 8601 if known. */
  published?: string;
  summary?: string;
}

export interface SitemapEntry {
  loc: string;
  /** ISO 8601 if known. */
  lastmod?: string;
}

export interface ParsedSitemap {
  type: 'urlset' | 'index';
  entries: SitemapEntry[];
}

export interface PageLink {
  url: string;
  text: string;
}

export interface PageText {
  title: string;
  text: string;
}

export interface DiscoveredItem {
  url: string;
  sourceId: string;
  tier: 1 | 2;
  kind: SourceKind;
  title?: string;
  /** ISO date-time of publication or lastmod, if known. */
  date?: string;
  summary?: string;
}

/** state/seen_urls.json */
export interface SeenState {
  version: 1;
  /** sourceId -> date (YYYY-MM-DD) the source was first seeded. Missing = first run for that source. */
  initialized: Record<string, string>;
  /** url -> info */
  urls: Record<string, { first_seen: string; source: string; lastmod?: string }>;
}

export interface DiscoverStats {
  sourceId: string;
  listed: number; // URLs found in the feed/sitemap/listing after include/exclude/keyword filters
  new: number; // not seen before (or lastmod changed)
  selected: number; // passed recency/first-run/cap rules and returned for processing
  seededOnly: number; // first run: marked seen without processing
  overCap: number; // new but over max_items_per_run
  errors: string[];
}

export interface DiscoverResult {
  items: DiscoveredItem[];
  stats: DiscoverStats;
}

/** A fetched page ready for extraction and grounding. */
export interface PageContext {
  url: string;
  finalUrl: string;
  title: string;
  /** Visible text (scripts/styles/nav stripped), whitespace-collapsed. */
  text: string;
  /** Raw HTML (kept in memory only, used for link extraction / tier-2 resolution). */
  html: string;
  fetchedAt: string;
}

/* ----------------------------------------------------------------------------------------------
 * Extraction (Gemini on Vertex AI)
 * -------------------------------------------------------------------------------------------- */

export interface LlmUsage {
  calls: number;
  promptTokens: number;
  outputTokens: number; // candidates tokens
  thoughtsTokens: number;
}

export interface LlmRequest {
  system: string;
  prompt: string;
  /** Vertex responseSchema (OpenAPI subset). */
  schema: object;
  temperature?: number;
  /** Purpose label for usage accounting: "extract" | "review" | "venue" | "resolve". */
  purpose: string;
}

export interface Llm {
  readonly model: string;
  generateJson<T>(req: LlmRequest): Promise<{ data: T; usage: LlmUsage; blocked?: string }>;
  /** Cumulative usage for this process, by purpose. */
  usage(): Record<string, LlmUsage>;
}

/** Fields of an Activity the model fills in (id, verified, lifecycle fields are set by the pipeline). */
export type ActivityDraft = Omit<Activity, 'id' | 'verified' | 'added_at' | 'status' | 'origin'>;
/** Fields of an Outing the model fills in. */
export type OutingDraft = Omit<Outing, 'id' | 'added_at' | 'status' | 'origin' | 'last_verified'>;

export interface ReviewScores {
  age_appropriate: number; // 1-5
  safety: number; // 1-5
  no_medical_claims: number; // 1-5
  not_product_only: number; // 1-5
  notes: string;
}

export interface Candidate {
  kind: SourceKind;
  /** Activity or Outing without pipeline-set fields. id is assigned at merge time. */
  draft: ActivityDraft | OutingDraft;
  /** Short verbatim quote from the page. Used by G2 only; never shipped. */
  supporting_quote: string;
  /** sources.yaml id of the tier-1 source whose page this was extracted from. */
  source_id: string;
  /** sources.yaml id of the tier-2 source that discovered it, if any. */
  discovered_via?: string;
  /** Page the candidate was extracted from (official/organizer page). */
  page_url: string;
  extracted_at: string;
  /** 1 on the first try; incremented on each retry from quarantine (max 4). */
  attempts: number;
  review?: ReviewScores;
  /** Set when the candidate came from a maintenance job, e.g. "venue-recheck" or "coverage-guard". */
  purpose?: 'new' | 'venue-update' | 'coverage';
  /** For venue updates: the id of the existing outing being updated. */
  replaces_id?: string;
}

/* ----------------------------------------------------------------------------------------------
 * Gates (SDD §8.4)
 * -------------------------------------------------------------------------------------------- */

export type GateId = 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'G8' | 'G9';

export interface GateFailure {
  gate: GateId;
  reason: string;
  /** Fixable failures (e.g. no dates on the page yet, page temporarily down) are retried next week, up to 4 attempts. */
  fixable: boolean;
}

/** Current canonical content (content/*.json). */
export interface ContentSet {
  activities: Activity[];
  outings: Outing[];
  milestones: MilestonesFile;
}

export interface GateContext {
  content: ContentSet;
  sources: SourcesFile;
  safety: SafetyRulesFile;
  /** Page the candidate was extracted from (for grounding and date checks). */
  page: PageContext;
  /** YYYY-MM-DD in Asia/Singapore. */
  today: string;
  /** AI reviewer (G5). Injected so tests can stub it. */
  review: (c: Candidate, page: PageContext) => Promise<ReviewScores>;
}

export interface QuotaLimits {
  maxActivities: number; // 10
  maxOutings: number; // 30
  maxActivitiesPerSource: number; // 5
}

/** Per-candidate gate outcome. `candidate` may be modified by gates (e.g. G7 sets dates_confirmed=false). */
export interface GateOutcome {
  candidate: Candidate;
  failures: GateFailure[];
}

/* ----------------------------------------------------------------------------------------------
 * Safety rules (pipeline/safety_rules.yaml, G4)
 * -------------------------------------------------------------------------------------------- */

export type SafetyAction = 'block' | 'require_note';

export interface SafetyRule {
  id: string;
  title: string;
  why: string;
  action: SafetyAction;
  applies_to: SourceKind[];
  /** Fields to scan: title/name, summary, how_to, materials, notes. */
  fields: string[];
  /** Case-insensitive patterns. Plain words/phrases match on word boundaries; "re:" prefix = raw regex. */
  match: string[];
  /** For require_note: the safety_notes (or how_to) must contain one of these. */
  require_any?: string[];
  /** Only applies when the activity month (or outing min_age_months) is below this. */
  below_month?: number;
  /** Patterns that cancel a match (e.g. "grape halves quartered"). */
  unless?: string[];
  examples?: { blocked?: string[]; allowed?: string[] };
}

export interface SafetyRulesFile {
  version: number;
  rules: SafetyRule[];
}

/* ----------------------------------------------------------------------------------------------
 * Quarantine, staging, reports
 * -------------------------------------------------------------------------------------------- */

export interface QuarantineEntry {
  candidate: Candidate;
  failures: GateFailure[];
  quarantined_at: string;
  /** True if fixable and attempts < 4: retried next weekly run. */
  retry: boolean;
}

/** content/quarantine/{date}.json */
export interface QuarantineFile {
  date: string;
  run_id: string;
  entries: QuarantineEntry[];
}

/** content/staged/{date}.json (AUTO_PUBLISH=false) */
export interface StagedFile {
  date: string;
  run_id: string;
  auto_publish: false;
  /** Records exactly as they would be merged into content/. */
  activities: Activity[];
  outings: Outing[];
  /** Ids of records that would be retired / updated. */
  retire: { id: string; reason: string }[];
  update: { id: string; reason: string }[];
  /** Whether the merged catalog passed G9 validation. */
  validation: { ok: boolean; errors: string[]; warnings: number };
}

export interface RunReport {
  run_id: string;
  job: 'weekly' | 'daily' | 'monthly';
  date: string;
  auto_publish: boolean;
  discovered: DiscoverStats[];
  reached_gemini: number;
  candidates: number;
  gate_failures: Record<GateId, number>;
  gate_failure_reasons: { gate: GateId; reason: string; title: string; source: string }[];
  passed: number;
  published: { id: string; title: string; kind: SourceKind }[];
  staged: { title: string; kind: SourceKind; month?: number; category?: string; source: string; url: string }[];
  retired: { id: string; reason: string }[];
  quarantined: number;
  catalog_version: number | null;
  published_version: number | null;
  llm_usage: Record<string, LlmUsage>;
  est_cost_usd: number;
  failures: string[];
  /** Why discovered items produced no candidate (fetch failed, no official page, nothing usable...). */
  skips?: Record<string, number>;
  /** Maintenance results (link check, date confirmation, coverage guard, expiry, venue re-check). */
  maintenance?: Record<string, unknown>;
}

export const MAX_ATTEMPTS = 4;
export const DEFAULT_QUOTAS: QuotaLimits = { maxActivities: 10, maxOutings: 30, maxActivitiesPerSource: 5 };
