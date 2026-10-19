/**
 * Re-check a staged file against the CURRENT deterministic rules (G4 safety rules, G7 outing
 * checks) after a rule change, and write the survivors to a new staged file.
 * Usage: tsx scripts/regate-staged.ts <in.json> <out.json> [YYYY-MM-DD]
 * Outing pages are re-fetched so G7 sees live page text.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadSafetyRules, checkSafety } from '../pipeline/src/gates/safety';
import { g7Events } from '../pipeline/src/gates/gates';
import type { Candidate, StagedFile } from '../pipeline/src/types';

const [inPath, outPath, todayArg] = process.argv.slice(2);
if (!inPath || !outPath) throw new Error('usage: regate-staged <in.json> <out.json> [YYYY-MM-DD]');
const today = todayArg ?? new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const staged = JSON.parse(readFileSync(inPath, 'utf8')) as StagedFile;
const rules = loadSafetyRules();
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

async function pageText(url: string): Promise<string> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
    const html = await r.text();
    return html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  } catch { return ''; }
}

const cand = (kind: 'activity' | 'outing', draft: unknown, url: string): Candidate =>
  ({ kind, draft, supporting_quote: '', source_id: 'regate', page_url: url, extracted_at: `${today}T00:00:00Z`, attempts: 1, purpose: 'new' }) as unknown as Candidate;

const report: { kind: string; title: string; result: string }[] = [];
const keepA = [];
for (const a of staged.activities) {
  const f = checkSafety(cand('activity', a, a.source_url ?? ''), rules);
  report.push({ kind: 'activity', title: `${a.title} (m${a.month})`, result: f.length ? `FAIL ${f.map((x) => `${x.gate}: ${x.reason}`).join('; ')}` : 'pass' });
  if (!f.length) keepA.push(a);
}
const keepO = [];
for (const o of staged.outings) {
  const text = await pageText(o.url);
  const c = cand('outing', { ...o }, o.url);
  const f = [...checkSafety(c, rules), ...g7Events(c, { url: o.url, finalUrl: o.url, text } as never, today)];
  report.push({ kind: 'outing', title: o.name, result: f.length ? `FAIL ${f.map((x) => `${x.gate}: ${x.reason}`).join('; ')}` : 'pass' });
  if (!f.length) keepO.push(o);
}
writeFileSync(outPath, JSON.stringify({ ...staged, activities: keepA, outings: keepO }, null, 2));
for (const r of report) console.log(`${r.result === 'pass' ? 'PASS' : 'FAIL'} | ${r.kind} | ${r.title}${r.result === 'pass' ? '' : ' | ' + r.result.slice(5)}`);
console.log(`kept ${keepA.length}/${staged.activities.length} activities, ${keepO.length}/${staged.outings.length} outings`);
