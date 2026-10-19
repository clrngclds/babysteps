import { activityTags, computeTagAffinity } from './tags';
import type { Activity, Milestone, RecInput } from './types';

export const W_TAG = 0.6;
export const W_MILESTONE = 0.25;
export const W_AGE = 0.15;

export interface ScoreContext {
  ageMonths: number;
  affinity: Record<string, number>;
  milestonesById: Map<string, Milestone>;
  /** Sorted ascending. */
  checkpoints: number[];
  milestonesSeen: Set<string>;
}

export interface ScoredActivity {
  activity: Activity;
  score: number;
  /** Normalised tag affinity in [-1, 1]. */
  tagAffinity: number;
  milestonePriority: number;
  ageFit: number;
}

export function buildContext(input: RecInput): ScoreContext {
  const byId = new Map<string, Activity>();
  for (const a of input.activities) byId.set(a.id, a);
  const milestonesById = new Map<string, Milestone>();
  for (const m of input.milestones) milestonesById.set(m.id, m);
  return {
    ageMonths: input.ageMonths,
    affinity: computeTagAffinity(input.interactions, byId, input.now),
    milestonesById,
    checkpoints: [...input.checkpoints].sort((x, y) => x - y),
    milestonesSeen: new Set(input.milestonesSeen ?? []),
  };
}

/** 1.0 at the child's age, minus 0.25 per month of distance, clamped to >= 0. */
export function ageFit(month: number, age: number): number {
  return Math.max(0, 1 - 0.25 * Math.abs(month - age));
}

/** Index of the smallest checkpoint >= month; clamps to the last checkpoint (36). -1 if no checkpoints. */
export function checkpointIndex(month: number, checkpoints: number[]): number {
  if (checkpoints.length === 0) return -1;
  const i = checkpoints.findIndex((c) => c >= month);
  return i === -1 ? checkpoints.length - 1 : i;
}

/** The child's current-or-next checkpoint (smallest checkpoint >= age, clamped to the last one). */
export function targetCheckpoint(age: number, checkpoints: number[]): number {
  const i = checkpointIndex(age, checkpoints);
  return i === -1 ? age : checkpoints[i];
}

interface MilestoneHit {
  milestone: Milestone;
  priority: number;
}

/**
 * milestonePriority formula:
 *   T = index of the child's current-or-next checkpoint (smallest checkpoint >= age, clamped to 36).
 *   For each linked milestone m that exists, is not in milestonesSeen and has m.month >= checkpoints[T]:
 *     k = checkpointIndex(m.month) - T        (0 = this checkpoint, 1 = the one after, ...)
 *     p(m) = 0.5^k
 *   milestonePriority = max p(m), or 0 when the activity links only to seen/past milestones or none.
 */
export function bestMilestone(a: Activity, ctx: ScoreContext): MilestoneHit | null {
  const t = checkpointIndex(ctx.ageMonths, ctx.checkpoints);
  if (t === -1) return null;
  const targetMonth = ctx.checkpoints[t];
  let best: MilestoneHit | null = null;
  for (const id of a.milestone_ids) {
    if (ctx.milestonesSeen.has(id)) continue;
    const m = ctx.milestonesById.get(id);
    if (!m || m.month < targetMonth) continue;
    const k = Math.max(0, checkpointIndex(m.month, ctx.checkpoints) - t);
    const priority = Math.pow(0.5, k);
    if (
      !best ||
      priority > best.priority ||
      (priority === best.priority && m.month < best.milestone.month)
    ) {
      best = { milestone: m, priority };
    }
  }
  return best;
}

export function milestonePriority(a: Activity, ctx: ScoreContext): number {
  const hit = bestMilestone(a, ctx);
  return hit ? hit.priority : 0;
}

/**
 * tagAffinityNorm = tanh( (sum of affinity[tag] over the item's tags) / (number of tags) ), in (-1, 1).
 * A mean over tags keeps items with many tags from dominating; tanh bounds it.
 */
export function tagAffinityNorm(a: Activity, affinity: Record<string, number>): number {
  const tags = activityTags(a);
  if (tags.length === 0) return 0;
  let sum = 0;
  for (const t of tags) sum += affinity[t] ?? 0;
  return Math.tanh(sum / tags.length);
}

/** score = 0.60 * tagAffinityNorm + 0.25 * milestonePriority + 0.15 * ageFit */
export function score(
  a: Activity,
  ctx: ScoreContext,
): { score: number; tagAffinity: number; milestonePriority: number; ageFit: number } {
  const ta = tagAffinityNorm(a, ctx.affinity);
  const mp = milestonePriority(a, ctx);
  const af = ageFit(a.month, ctx.ageMonths);
  return { score: W_TAG * ta + W_MILESTONE * mp + W_AGE * af, tagAffinity: ta, milestonePriority: mp, ageFit: af };
}

export function scoreAll(activities: Activity[], ctx: ScoreContext): ScoredActivity[] {
  return activities.map((a) => ({ activity: a, ...score(a, ctx) }));
}
