/**
 * In-browser keyword search (SDD §3.7). Plain keyword matching with MiniSearch:
 * case/punctuation-insensitive, prefix matching ("crawl" → "crawling"), simple plural folding,
 * results grouped as Milestones / Activities / Outings, activities near the child's age first.
 * The index is built on the device from the cached catalog. Search terms are never stored or sent.
 */
import MiniSearch, { type SearchResult } from 'minisearch';
import type { Activity, Milestone, Outing } from './types';

export interface SearchCatalog {
  activities: Activity[];
  milestones: Milestone[];
  outings: Outing[];
}

interface Doc {
  id: string;
  kind: 'm' | 'a' | 'o';
  title: string;
  body: string;
  extra: string;
}

/** Fold simple English plurals so "balls" ≈ "ball", "berries" ≈ "berry", "boxes" ≈ "box". */
export function stem(term: string): string {
  const t = term.toLowerCase();
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.length > 4 && /(sses|shes|ches|xes|zes)$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !/(ss|us|is)$/.test(t)) return t.slice(0, -1);
  return t;
}

const processTerm = (term: string) => {
  const t = term.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return t ? stem(t) : null;
};

export interface SearchIndex {
  search(query: string, age: number | null, limit?: number): GroupedResults;
}

export interface GroupedResults {
  milestones: Milestone[];
  activities: Activity[];
  outings: Outing[];
}

export function buildIndex(cat: SearchCatalog): SearchIndex {
  const ms = new MiniSearch<Doc>({
    fields: ['title', 'body', 'extra'],
    storeFields: ['kind'],
    processTerm,
    tokenize: (s) => s.split(/[\s\-/–—,.;:()!?"'“”‘’]+/u),
    searchOptions: { prefix: true, fuzzy: 0, combineWith: 'AND', boost: { title: 3, extra: 1, body: 1 } },
  });
  const docs: Doc[] = [
    ...cat.milestones.map((m) => ({ id: m.id, kind: 'm' as const, title: m.text, body: '', extra: '' })),
    ...cat.activities.map((a) => ({ id: a.id, kind: 'a' as const, title: a.title, body: a.summary, extra: a.materials.join(' ') })),
    ...cat.outings.map((o) => ({ id: o.id, kind: 'o' as const, title: o.name, body: o.summary, extra: o.location })),
  ];
  ms.addAll(docs);
  const mById = new Map(cat.milestones.map((m) => [m.id, m]));
  const aById = new Map(cat.activities.map((a) => [a.id, a]));
  const oById = new Map(cat.outings.map((o) => [o.id, o]));

  return {
    search(query, age, limit = 50) {
      const q = query.trim();
      const empty: GroupedResults = { milestones: [], activities: [], outings: [] };
      if (!q) return empty;
      const res: SearchResult[] = ms.search(q);
      const out: GroupedResults = { milestones: [], activities: [], outings: [] };
      const acts: { a: Activity; s: number }[] = [];
      for (const r of res) {
        if (r.kind === 'm') { const m = mById.get(r.id as string); if (m) out.milestones.push(m); }
        else if (r.kind === 'o') { const o = oById.get(r.id as string); if (o) out.outings.push(o); }
        else {
          const a = aById.get(r.id as string);
          if (a) {
            // Activities near the child's age first: distance dominates, text score breaks ties.
            const d = age === null ? 0 : Math.abs(a.month - age);
            const nearPenalty = d <= 1 ? 0 : d <= 3 ? 1 : d <= 6 ? 2 : 3;
            acts.push({ a, s: nearPenalty * 1000 - r.score });
          }
        }
      }
      acts.sort((x, y) => x.s - y.s);
      out.activities = acts.slice(0, limit).map((x) => x.a);
      out.milestones = out.milestones.slice(0, limit);
      out.outings = out.outings.slice(0, limit);
      return out;
    },
  };
}
