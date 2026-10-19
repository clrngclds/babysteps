import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import activitiesJson from '../../data/activities.json';
import { checkSafety, compilePattern, findRuleMatch, loadSafetyRules, parseSafetyRules } from '../../pipeline/src/gates/safety';
import type { Activity, ActivityDraft, Candidate, OutingDraft, SafetyRule, SafetyRulesFile } from '../../pipeline/src/types';

const RULES = loadSafetyRules();
const activities = activitiesJson as Activity[];

function draftOf(a: Activity): ActivityDraft {
  const { id: _id, verified: _v, added_at: _a, status: _s, origin: _o, ...draft } = a;
  return draft;
}

/** A neutral real activity (laundry basket sleigh ride, month 6) as the base for safety cases. */
const BASE = draftOf(activities.find((a) => a.id === 'act-m06-gm-01')!);

function activity(over: Partial<ActivityDraft>): Candidate {
  return {
    kind: 'activity',
    draft: { ...BASE, title: 'Test activity', summary: 'A test.', how_to: 'Do it.', materials: [], safety_notes: '', ...over },
    supporting_quote: '',
    source_id: 'lovevery-blog',
    page_url: BASE.source_url,
    extracted_at: '2026-10-19T00:00:00Z',
    attempts: 1,
  };
}

function outing(over: Partial<OutingDraft>): Candidate {
  const draft: OutingDraft = {
    name: 'Test outing', type: 'venue', summary: 'A place.', location: 'Somewhere, Singapore', region: 'central',
    min_age_months: 0, max_age_months: 36, categories: ['other'], play_type: ['exploration'], setting: 'indoor',
    rain_ok: true, paid: false, price_note: '', booking_required: false, start_date: null, end_date: null,
    recurrence: null, dates_confirmed: true, url: 'https://www.nlb.gov.sg/x', notes: '', ...over,
  };
  return { kind: 'outing', draft, supporting_quote: '', source_id: 'nlb', page_url: draft.url, extracted_at: '', attempts: 1 };
}

const ruleIds = (c: Candidate, rules: SafetyRulesFile = RULES) =>
  checkSafety(c, rules).map((f) => /safety rule ([a-z0-9-]+)/.exec(f.reason)?.[1]);

/** How the YAML header says examples are checked: the sentence goes into how_to, at an age the rule covers. */
function exampleCandidate(rule: SafetyRule, text: string): Candidate {
  const age = rule.below_month !== undefined ? rule.below_month - 1 : 10;
  return rule.applies_to.includes('activity')
    ? activity({ month: age, how_to: text })
    : outing({ min_age_months: age, summary: text });
}

describe('safety_rules.yaml', () => {
  it('parses and has unique, documented rules', () => {
    expect(RULES.rules.length).toBeGreaterThanOrEqual(15);
    for (const r of RULES.rules) {
      expect(r.why.length, r.id).toBeGreaterThan(20);
      expect(r.examples?.blocked?.length, `${r.id} needs a blocked example`).toBeGreaterThan(0);
      expect(r.examples?.allowed?.length, `${r.id} needs an allowed example`).toBeGreaterThan(0);
      expect(r.fields, `${r.id}: examples are placed in how_to`).toContain('how_to');
    }
  });

  it('covers every risk named in SDD G4', () => {
    const ids = RULES.rules.map((r) => r.id);
    for (const id of [
      'button-batteries', 'magnets', 'balloons', 'marbles', 'coins', 'popcorn', 'whole-nuts', 'round-foods',
      'honey-under-12-months', 'water-needs-supervision', 'soft-items-in-sleep', 'necklaces-and-blind-cords',
      'strings-need-supervision', 'climbing-needs-spotting', 'small-objects-need-supervision',
    ])
      expect(ids).toContain(id);
  });

  // Data-driven: every example in the YAML is a test case, so edits to the file stay tested.
  for (const rule of RULES.rules) {
    describe(`rule ${rule.id}`, () => {
      for (const ex of rule.examples?.blocked ?? []) {
        it(`blocks: ${ex}`, () => {
          expect(ruleIds(exampleCandidate(rule, ex))).toContain(rule.id);
        });
      }
      for (const ex of rule.examples?.allowed ?? []) {
        it(`allows: ${ex}`, () => {
          expect(ruleIds(exampleCandidate(rule, ex))).not.toContain(rule.id);
        });
      }
      if (rule.below_month !== undefined) {
        it(`does not apply at ${rule.below_month} months`, () => {
          for (const ex of rule.examples?.blocked ?? []) {
            const c = exampleCandidate(rule, ex);
            (c.draft as ActivityDraft).month = rule.below_month!;
            expect(ruleIds(c)).not.toContain(rule.id);
          }
        });
      }
    });
  }
});

describe('checkSafety', () => {
  it('honey: blocked at month 11, allowed at month 12', () => {
    const at = (month: number) => activity({ month, how_to: 'Spread a little honey on a soft rusk.' });
    expect(ruleIds(at(11))).toContain('honey-under-12-months');
    expect(ruleIds(at(12))).not.toContain('honey-under-12-months');
  });

  it('finds plurals and whole words only', () => {
    expect(ruleIds(activity({ how_to: 'Offer a few peanuts.' }))).toContain('whole-nuts');
    expect(ruleIds(activity({ how_to: 'Offer grated coconut and a pinch of nutmeg.' }))).not.toContain('whole-nuts');
    expect(ruleIds(activity({ how_to: 'Make a toy with two button batteries.' }))).toContain('button-batteries');
  });

  it('scans title and materials, each material on its own', () => {
    expect(ruleIds(activity({ title: 'Balloon volleyball' }))).toContain('balloons');
    expect(ruleIds(activity({ materials: ['grapes', 'knife (cut into quarters)'] }))).toContain('round-foods');
    expect(ruleIds(activity({ materials: ['grapes, quartered lengthwise'] }))).not.toContain('round-foods');
  });

  it('"unless" works per sentence', () => {
    expect(ruleIds(activity({ how_to: 'Offer grapes cut into quarters.' }))).not.toContain('round-foods');
    expect(ruleIds(activity({ how_to: 'Offer whole grapes. Later, cut apples into quarters.' }))).toContain('round-foods');
  });

  it('does not read the safety note for risk words', () => {
    const c = activity({ how_to: 'Bat a soft ball across the room.', safety_notes: 'Never use balloons: burst pieces are a choking hazard.' });
    expect(ruleIds(c)).toEqual([]);
  });

  it('require_note: satisfied by the safety note or the how-to text', () => {
    const base = { how_to: 'Fill a tub of water and float cups.' };
    expect(ruleIds(activity(base))).toContain('water-needs-supervision');
    expect(ruleIds(activity({ ...base, safety_notes: 'Supervise the whole time.' }))).not.toContain('water-needs-supervision');
    expect(ruleIds(activity({ how_to: 'Fill a tub of water and float cups while you supervise.' }))).not.toContain('water-needs-supervision');
    expect(ruleIds(activity({ ...base, safety_notes: 'Use a towel.' }))).toContain('water-needs-supervision');
  });

  it('climbing needs "spot"; small objects need supervision and size guidance', () => {
    expect(ruleIds(activity({ how_to: 'Let them climb the Pikler triangle.', safety_notes: 'Stay close.' }))).toContain('climbing-needs-spotting');
    expect(ruleIds(activity({ how_to: 'Let them climb the Pikler triangle.', safety_notes: 'Spot them on every rung.' }))).not.toContain('climbing-needs-spotting');
    const basket = activity({ how_to: 'Offer a treasure basket of kitchen items.', safety_notes: 'Supervise.' });
    expect(ruleIds(basket)).toEqual(['small-objects-need-size-guidance']);
    (basket.draft as ActivityDraft).safety_notes = 'Supervise; every item larger than a toilet roll tube.';
    expect(ruleIds(basket)).toEqual([]);
  });

  it('failures are not fixable and say why', () => {
    const [f] = checkSafety(activity({ how_to: 'Roll marbles down a tube.' }), RULES);
    expect(f).toMatchObject({ gate: 'G4', fixable: false });
    expect(f.reason).toContain('marble');
    expect(f.reason).toContain('airway');
  });

  it('a real seed activity with a proper note passes (act-m06-gm-01)', () => {
    expect(checkSafety({ ...activity({}), draft: BASE }, RULES)).toEqual([]);
  });

  it('outing rules use min_age_months for below_month', () => {
    const rules = parseSafetyRules(`
version: 1
rules:
  - id: test-outing
    title: Test
    why: Test rule for outings only.
    action: block
    applies_to: [outing]
    below_month: 12
    fields: [name, summary, notes]
    match: [trampoline]
`);
    expect(ruleIds(outing({ name: 'Trampoline park', min_age_months: 6 }), rules)).toEqual(['test-outing']);
    expect(ruleIds(outing({ name: 'Trampoline park', min_age_months: 12 }), rules)).toEqual([]);
    expect(ruleIds(activity({ month: 6, title: 'Trampoline' }), rules)).toEqual([]);
  });
});

describe('compilePattern', () => {
  it('handles plurals, hyphens and regex', () => {
    expect(compilePattern('battery').test('two batteries')).toBe(true);
    expect(compilePattern('cherry tomato').test('cherry-tomatoes')).toBe(true);
    expect(compilePattern('nut free').test('a nut-free snack')).toBe(true);
    expect(compilePattern("cow's milk").test("a cup of cow's milk")).toBe(true);
    expect(compilePattern('nut').test('doughnut')).toBe(false);
    expect(compilePattern('re:\\bfoo\\d+').test('foo12')).toBe(true);
  });

  it('findRuleMatch returns the matched text', () => {
    const rule = RULES.rules.find((r) => r.id === 'popcorn')!;
    expect(findRuleMatch(activity({ how_to: 'Thread POPCORN on string.' }), rule)).toBe('popcorn');
  });
});

describe('parseSafetyRules validation', () => {
  const ok = `
  - id: a
    title: A
    why: Because.
    action: block
    applies_to: [activity]
    fields: [how_to]
    match: [x]`;
  const file = (rules: string) => `version: 1\nrules:${rules}`;

  it('accepts a minimal rule', () => {
    expect(parseSafetyRules(file(ok)).rules[0].id).toBe('a');
  });
  it('rejects a bad regex, naming the rule', () => {
    expect(() => parseSafetyRules(file(ok.replace('match: [x]', "match: ['re:(unclosed']")))).toThrow(/\(a\).*bad pattern/);
  });
  it('rejects duplicate ids', () => {
    expect(() => parseSafetyRules(file(ok + ok))).toThrow(/duplicate id/);
  });
  it('rejects require_note without require_any', () => {
    expect(() => parseSafetyRules(file(ok.replace('action: block', 'action: require_note')))).toThrow(/require_any/);
  });
  it('rejects unknown fields, actions and kinds', () => {
    expect(() => parseSafetyRules(file(ok.replace('fields: [how_to]', 'fields: [body]')))).toThrow(/fields/);
    expect(() => parseSafetyRules(file(ok.replace('action: block', 'action: warn')))).toThrow(/action/);
    expect(() => parseSafetyRules(file(ok.replace('[activity]', '[event]')))).toThrow(/applies_to/);
  });
  it('rejects a missing why and a bad below_month', () => {
    expect(() => parseSafetyRules(file(ok.replace('    why: Because.\n', '')))).toThrow(/why/);
    expect(() => parseSafetyRules(file(`${ok}\n    below_month: 1.5`))).toThrow(/below_month/);
  });
  it('rejects an empty file or missing version', () => {
    expect(() => parseSafetyRules('')).toThrow();
    expect(() => parseSafetyRules('rules: []')).toThrow(/version/);
  });
  it('loadSafetyRules reads the given path', () => {
    const text = readFileSync('pipeline/safety_rules.yaml', 'utf8');
    expect(loadSafetyRules('pipeline/safety_rules.yaml')).toEqual(parseSafetyRules(text));
  });
});
