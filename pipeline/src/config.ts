/** Runtime configuration from environment variables. One place, so every job reads the same values. */

export interface PipelineConfig {
  project: string;
  /** Content bucket (no gs:// prefix). */
  bucket: string;
  /** Live site used for the post-publish health check. */
  siteUrl: string;
  /** Kill switch (SDD §8.7). false = run everything, stage candidates, publish nothing. */
  autoPublish: boolean;
  /** Gemini model, e.g. gemini-2.5-flash (default) or gemini-2.5-flash-lite (cheaper). */
  model: string;
  /** Vertex AI location. flash is served in asia-southeast1; flash-lite only in "global". */
  vertexLocation: string;
  /** Thinking budget for Gemini 2.5 (0 = off, cheapest). */
  thinkingBudget: number;
  /** Override "today" (YYYY-MM-DD, Asia/Singapore) for tests and replays. */
  today?: string;
  /** Items newer than this many days are processed on a source's first run; older ones are only seeded. */
  firstRunWindowDays: number;
  /** Per-host politeness delay. */
  hostDelayMs: number;
}

const bool = (v: string | undefined, dflt: boolean) =>
  v === undefined || v === '' ? dflt : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PipelineConfig {
  // GCP_PROJECT only: a developer's GOOGLE_CLOUD_PROJECT must not redirect the pipeline to another project.
  const project = env.GCP_PROJECT || 'dc-test2-489503';
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  return {
    project,
    bucket: env.CONTENT_BUCKET || `${project}-babysteps-content`,
    siteUrl: (env.SITE_URL || 'https://web-312918712586.asia-southeast1.run.app').replace(/\/$/, ''),
    // Safe default: publishing is off unless explicitly enabled.
    autoPublish: bool(env.AUTO_PUBLISH, false),
    model,
    vertexLocation: env.VERTEX_LOCATION || (model.includes('lite') ? 'global' : 'asia-southeast1'),
    thinkingBudget: Number(env.GEMINI_THINKING_BUDGET ?? 0),
    today: env.PIPELINE_TODAY || undefined,
    firstRunWindowDays: Number(env.FIRST_RUN_WINDOW_DAYS ?? 30),
    hostDelayMs: Number(env.HOST_DELAY_MS ?? 2000),
  };
}

/** Today's date in Singapore (the schedules and content dates are SGT). */
export function sgtToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** USD per 1M tokens (Vertex AI standard on-demand, text, <=200k context). Thinking tokens bill as output. */
export const PRICING: Record<string, { input: number; output: number }> = {
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
};

export function estimateCost(model: string, u: { promptTokens: number; outputTokens: number; thoughtsTokens: number }): number {
  const p = PRICING[model] ?? PRICING['gemini-2.5-flash'];
  return (u.promptTokens * p.input + (u.outputTokens + u.thoughtsTokens) * p.output) / 1e6;
}
