import { describe, it, expect } from 'vitest';
import { showsUnder3Suitability, findAdultOrThrill } from '../../pipeline/src/gates/gates';

describe('G7 v0.4: page must show under-3 suitability', () => {
  it.each([
    'Baby Lapsit: rhymes for babies and their caregivers',
    'Suitable for toddlers aged 18-36 months',
    'Ages 0–6. Stroller-friendly paths and a nursing room on level 1.',
    'A family-friendly garden with a water play area',
    'Storytime for little ones every Saturday',
    'For children under 3 accompanied by an adult',
  ])('passes: %s', (t) => expect(showsUnder3Suitability(t)).toBe(true));

  it.each([
    'Meet our pygmy hippo. Ranger talk at 2pm daily.',
    'ArtScience Museum tickets. Select your date and time.',
    'Race through the trails at night. Book now.',
    'Valid for 6 months from date of purchase',
  ])('fails: %s', (t) => expect(showsUnder3Suitability(t)).toBe(false));
});

describe('G7 v0.4: thrill / horror / adult events are rejected', () => {
  it('rejects thrill and horror themes in the name or summary', () => {
    expect(findAdultOrThrill('TRICK or THRILLS')).toBe('thrill event');
    expect(findAdultOrThrill('Haunted house walk for Halloween')).toBe('haunted');
    expect(findAdultOrThrill('Halloween Horror Nights 2026')).toBe('horror');
  });
  it('rejects explicit age restrictions anywhere on the page', () => {
    expect(findAdultOrThrill('Night market', 'Admission for 18+ only')).toBe('18+');
    expect(findAdultOrThrill('Comedy show', 'Rated R18')).toBe('R18');
    expect(findAdultOrThrill('Wine evening', 'Adults only event')).toBe('adults only');
  });
  it('ignores theme words that only appear in site menus on the page', () => {
    expect(findAdultOrThrill('Toddler splash zone at Sentosa', 'Menu: Thrills | Nature | Family')).toBeNull();
  });
  it('allows ordinary family outings', () => {
    expect(findAdultOrThrill('Jacob Ballas Children’s Garden', 'Play areas for young children and families')).toBeNull();
  });
});
