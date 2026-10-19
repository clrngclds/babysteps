import { describe, it, expect } from 'vitest';
import { ageInfo, nowSG, parseBirth, rawAgeMonths, todaySG, validateBirth } from '../src/lib/age';

describe('age', () => {
  it('computes months from birth month/year', () => {
    expect(rawAgeMonths({ year: 2025, month: 6 }, { year: 2026, month: 10 })).toBe(16);
    expect(rawAgeMonths({ year: 2026, month: 10 }, { year: 2026, month: 10 })).toBe(0);
  });

  it('clamps over 36 and flags it', () => {
    const a = ageInfo({ year: 2022, month: 1 }, { year: 2026, month: 10 });
    expect(a.months).toBe(36);
    expect(a.over).toBe(true);
  });

  it('rejects future dates', () => {
    expect(validateBirth({ year: 2026, month: 11 }, { year: 2026, month: 10 })).toBe('future');
    expect(validateBirth({ year: 2026, month: 10 }, { year: 2026, month: 10 })).toBeNull();
  });

  it('uses Singapore time', () => {
    // 2026-10-31 18:00 UTC is already 1 Nov 02:00 in Singapore.
    const d = new Date('2026-10-31T18:00:00Z');
    expect(nowSG(d)).toEqual({ year: 2026, month: 11 });
    expect(todaySG(d)).toBe('2026-11-01');
  });

  it('parses YYYY-MM', () => {
    expect(parseBirth('2025-06')).toEqual({ year: 2025, month: 6 });
    expect(parseBirth('2025-13')).toBeNull();
    expect(parseBirth('junk')).toBeNull();
  });
});
