/**
 * G4: deterministic safety rules (pipeline/safety_rules.yaml). Plain word matching so the result
 * is predictable and the rule file stays readable by a non-engineer.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { ActivityDraft, Candidate, GateFailure, OutingDraft, SafetyRule, SafetyRulesFile } from '../types';
import { normalizeText } from './text';

/** Field names a rule may scan. "title" and "name" both mean the activity title / outing name. */
export const SAFETY_FIELDS = ['title', 'name', 'summary', 'how_to', 'materials', 'safety_notes', 'notes'] as const;
const RULE_ID = /^[a-z0-9][a-z0-9-]*$/;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compiles one pattern. Plain words/phrases: whole words, case-insensitive, spaces and hyphens
 * interchangeable, simple plural on the last word ("battery" -> "batteries", "grape" -> "grapes").
 * "re:" prefix: raw regex (case-insensitive), matched against normalised text.
 */
export function compilePattern(p: string): RegExp {
  if (p.startsWith('re:')) return new RegExp(p.slice(3), 'i');
  const words = normalizeText(p).split(/[\s-]+/).filter(Boolean);
  if (!words.length) throw new Error(`empty pattern "${p}"`);
  const parts = words.map(escapeRegex);
  const last = words[words.length - 1];
  parts[parts.length - 1] = /[^aeiou]y$/.test(last)
    ? `${escapeRegex(last.slice(0, -1))}(?:y|ies)`
    : `${escapeRegex(last)}(?:s|es)?`;
  return new RegExp(`(?<![a-z0-9])${parts.join('[\\s-]+')}(?![a-z0-9])`, 'i');
}

const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '');

/** Parses and validates the rules file. Throws with the rule id on any problem, so a bad edit stops the run. */
export function parseSafetyRules(yamlText: string): SafetyRulesFile {
  const raw = parseYaml(yamlText) as { version?: unknown; rules?: unknown } | null;
  if (!raw || typeof raw !== 'object') throw new Error('safety rules: file is empty or not a mapping');
  if (typeof raw.version !== 'number') throw new Error('safety rules: "version" must be a number');
  if (!Array.isArray(raw.rules) || raw.rules.length === 0) throw new Error('safety rules: "rules" must be a non-empty list');
  const ids = new Set<string>();
  const rules: SafetyRule[] = raw.rules.map((r: Record<string, unknown>, i: number) => {
    const where = `safety rule #${i + 1}${typeof r?.id === 'string' ? ` (${r.id})` : ''}`;
    const fail = (msg: string): never => {
      throw new Error(`${where}: ${msg}`);
    };
    if (!r || typeof r !== 'object') fail('must be a mapping');
    if (typeof r.id !== 'string' || !RULE_ID.test(r.id)) fail('id must be lowercase letters, digits and hyphens');
    if (ids.has(r.id as string)) fail('duplicate id');
    ids.add(r.id as string);
    for (const k of ['title', 'why'] as const) if (typeof r[k] !== 'string' || !(r[k] as string).trim()) fail(`${k} is required`);
    if (r.action !== 'block' && r.action !== 'require_note') fail('action must be "block" or "require_note"');
    if (!isStrList(r.applies_to) || !r.applies_to.length || r.applies_to.some((k) => k !== 'activity' && k !== 'outing'))
      fail('applies_to must list "activity" and/or "outing"');
    if (!isStrList(r.fields) || !r.fields.length || r.fields.some((f) => !(SAFETY_FIELDS as readonly string[]).includes(f)))
      fail(`fields must be a non-empty list of: ${SAFETY_FIELDS.join(', ')}`);
    if (!isStrList(r.match) || !r.match.length) fail('match must be a non-empty list of words');
    if (r.action === 'require_note' && (!isStrList(r.require_any) || !r.require_any.length))
      fail('require_note rules need a non-empty require_any list');
    if (r.require_any !== undefined && !isStrList(r.require_any)) fail('require_any must be a list of words');
    if (r.unless !== undefined && !isStrList(r.unless)) fail('unless must be a list of words');
    if (r.below_month !== undefined && !(Number.isInteger(r.below_month) && (r.below_month as number) > 0 && (r.below_month as number) <= 37))
      fail('below_month must be a whole number of months between 1 and 37');
    const ex = r.examples as SafetyRule['examples'] | undefined;
    if (ex !== undefined && (typeof ex !== 'object' || (ex.blocked !== undefined && !isStrList(ex.blocked)) || (ex.allowed !== undefined && !isStrList(ex.allowed))))
      fail('examples must have "blocked" and/or "allowed" lists of sentences');
    for (const p of [...(r.match as string[]), ...((r.unless as string[]) ?? []), ...((r.require_any as string[]) ?? [])]) {
      try {
        compilePattern(p);
      } catch (e) {
        fail(`bad pattern "${p}": ${(e as Error).message}`);
      }
    }
    return {
      id: r.id as string,
      title: r.title as string,
      why: (r.why as string).trim(),
      action: r.action as SafetyRule['action'],
      applies_to: r.applies_to as SafetyRule['applies_to'],
      fields: r.fields as string[],
      match: r.match as string[],
      ...(r.require_any !== undefined ? { require_any: r.require_any as string[] } : {}),
      ...(r.below_month !== undefined ? { below_month: r.below_month as number } : {}),
      ...(r.unless !== undefined ? { unless: r.unless as string[] } : {}),
      ...(ex !== undefined ? { examples: ex } : {}),
    };
  });
  return { version: raw.version, rules };
}

/** Default rules path: pipeline/safety_rules.yaml under the cwd, else next to this module's package. */
export function defaultSafetyRulesPath(): string {
  const fromCwd = resolve(process.cwd(), 'pipeline/safety_rules.yaml');
  if (existsSync(fromCwd)) return fromCwd;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../safety_rules.yaml', '../safety_rules.yaml', 'safety_rules.yaml', 'pipeline/safety_rules.yaml']) {
    const p = resolve(here, rel);
    if (existsSync(p)) return p;
  }
  return fromCwd;
}

export function loadSafetyRules(path: string = defaultSafetyRulesPath()): SafetyRulesFile {
  return parseSafetyRules(readFileSync(path, 'utf8'));
}

/** Text of one field as sentences. Each materials item is its own sentence. */
function fieldSentences(c: Candidate, field: string): string[] {
  const d = c.draft as Partial<ActivityDraft & OutingDraft>;
  let v: unknown;
  if (field === 'title' || field === 'name') v = c.kind === 'activity' ? d.title : d.name;
  else v = (d as Record<string, unknown>)[field];
  const chunks = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : [];
  return chunks.flatMap((t) => normalizeText(t).split(/(?<=[.!?;])\s+|\n+/)).filter((s) => s.trim() !== '');
}

/** Where a require_note rule looks for its safety words. */
function noteText(c: Candidate): string {
  const d = c.draft as Partial<ActivityDraft & OutingDraft>;
  const parts = c.kind === 'activity' ? [d.safety_notes, d.how_to] : [d.notes, d.summary];
  return normalizeText(parts.filter((x) => typeof x === 'string').join(' \n '));
}

function candidateAge(c: Candidate): number {
  const d = c.draft as Partial<ActivityDraft & OutingDraft>;
  return (c.kind === 'activity' ? d.month : d.min_age_months) ?? 0;
}

const compiled = new Map<string, RegExp>();
function re(p: string): RegExp {
  let r = compiled.get(p);
  if (!r) compiled.set(p, (r = compilePattern(p)));
  return r;
}

/** First risky phrase found for the rule (in a sentence without an "unless" phrase), or null. */
export function findRuleMatch(c: Candidate, rule: SafetyRule): string | null {
  const unless = (rule.unless ?? []).map(re);
  const match = rule.match.map(re);
  for (const field of rule.fields) {
    for (const sentence of fieldSentences(c, field)) {
      if (unless.some((u) => u.test(sentence))) continue;
      for (const m of match) {
        const hit = m.exec(sentence);
        if (hit) return hit[0];
      }
    }
  }
  return null;
}

/** Whether a rule applies to this candidate at all (kind and age). */
export function ruleApplies(c: Candidate, rule: SafetyRule): boolean {
  if (!rule.applies_to.includes(c.kind)) return false;
  return rule.below_month === undefined || candidateAge(c) < rule.below_month;
}

/** G4. One failure per triggered rule; never fixable (the content itself is the problem). */
export function checkSafety(c: Candidate, rules: SafetyRulesFile): GateFailure[] {
  const out: GateFailure[] = [];
  for (const rule of rules.rules) {
    if (!ruleApplies(c, rule)) continue;
    const hit = findRuleMatch(c, rule);
    if (hit === null) continue;
    if (rule.action === 'block') {
      out.push({ gate: 'G4', fixable: false, reason: `safety rule ${rule.id} (${rule.title}): found "${hit}". ${rule.why}` });
      continue;
    }
    const note = noteText(c);
    if (!(rule.require_any ?? []).some((p) => re(p).test(note))) {
      out.push({
        gate: 'G4',
        fixable: false,
        reason: `safety rule ${rule.id} (${rule.title}): found "${hit}" but the safety note doesn't mention any of: ${(rule.require_any ?? []).join(', ')}`,
      });
    }
  }
  return out;
}
