/**
 * Milestones page checkpoint selection (SDD BMi-1, v0.4).
 * current = the checkpoint the child is working towards (first checkpoint >= age), matching
 * "Coming up by N months" on Playtime. next = the one after it (null at the last checkpoint).
 * earlier = checkpoints before current, newest first.
 */
export interface CheckpointView {
  current: number;
  next: number | null;
  earlier: number[];
}

export function pickCheckpoints(checkpoints: number[], ageMonths: number): CheckpointView {
  const cps = [...checkpoints].sort((a, b) => a - b);
  if (!cps.length) throw new Error('no checkpoints');
  const age = Math.max(0, Math.min(ageMonths, cps[cps.length - 1]));
  const idx = Math.max(0, cps.findIndex((c) => c >= age));
  return {
    current: cps[idx],
    next: idx + 1 < cps.length ? cps[idx + 1] : null,
    earlier: cps.slice(0, idx).reverse(),
  };
}

/** View for an explicitly chosen checkpoint ("Browse other ages"). */
export function viewForCheckpoint(checkpoints: number[], cp: number): CheckpointView {
  return pickCheckpoints(checkpoints, cp);
}
