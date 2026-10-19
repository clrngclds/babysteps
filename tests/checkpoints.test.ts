import { describe, it, expect } from 'vitest';
import { pickCheckpoints, viewForCheckpoint } from '../src/lib/checkpoints';

const CPS = [2, 4, 6, 9, 12, 15, 18, 24, 30, 36];

describe('milestones page checkpoints', () => {
  it('16 months: working on 18, next 24, earlier newest first', () => {
    expect(pickCheckpoints(CPS, 16)).toEqual({ current: 18, next: 24, earlier: [15, 12, 9, 6, 4, 2] });
  });
  it('exactly at a checkpoint uses that checkpoint', () => {
    expect(pickCheckpoints(CPS, 18).current).toBe(18);
    expect(pickCheckpoints(CPS, 18).next).toBe(24);
  });
  it('newborn works towards 2 months with no earlier', () => {
    expect(pickCheckpoints(CPS, 0)).toEqual({ current: 2, next: 4, earlier: [] });
  });
  it('36 months and older: no next checkpoint', () => {
    expect(pickCheckpoints(CPS, 36).next).toBeNull();
    expect(pickCheckpoints(CPS, 40).current).toBe(36);
  });
  it('unsorted input is handled', () => {
    expect(pickCheckpoints([18, 2, 9], 5)).toEqual({ current: 9, next: 18, earlier: [2] });
  });
  it('browsing a chosen checkpoint', () => {
    expect(viewForCheckpoint(CPS, 30)).toEqual({ current: 30, next: 36, earlier: [24, 18, 15, 12, 9, 6, 4, 2] });
  });
});
