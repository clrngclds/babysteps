'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import type { Activity, ByMonthFile, Category, LatestPointer, Milestone, MilestonesFile, Outing } from '@/lib/types';
import { ageInfo, nowSG, parseBirth, todaySG, type AgeInfo, type YM } from '@/lib/age';
import { addSave, addSwipe, addTried, emptyState, removeSave, toggleMilestoneSeen, type DeviceState, type SwipeDir, type TriedResult } from '@/lib/state';
import { clearAllData, loadState, requestPersist, saveState } from '@/lib/idb';
import type { Filters } from '@/lib/filters';
import { VISIT_URL, visitPing } from '@/lib/analytics';

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

export interface FullCatalog {
  version: number;
  activities: Activity[];
  milestonesFile: MilestonesFile;
  milestones: Milestone[];
  outings: Outing[];
  actById: Map<string, Activity>;
  msById: Map<string, Milestone>;
  outById: Map<string, Outing>;
  /** milestone id -> activities (sorted by month) */
  msToActs: Map<string, Activity[]>;
}

async function getJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return (await r.json()) as T;
}

function buildFull(version: number, activities: Activity[], milestonesFile: MilestonesFile, outings: Outing[]): FullCatalog {
  const visible = activities.filter((a) => a.verified !== false && (!a.status || a.status === 'published'));
  const msToActs = new Map<string, Activity[]>();
  for (const a of visible) for (const mid of a.milestone_ids) {
    const l = msToActs.get(mid) ?? [];
    l.push(a);
    msToActs.set(mid, l);
  }
  for (const l of msToActs.values()) l.sort((x, y) => x.month - y.month || x.title.localeCompare(y.title));
  // The catalog build already drops retired outings; filter again so older or hand-built catalogs behave.
  outings = outings.filter((o) => !o.status || o.status === 'published');
  return {
    version,
    activities: visible,
    milestonesFile,
    milestones: milestonesFile.milestones,
    outings,
    actById: new Map(visible.map((a) => [a.id, a])),
    msById: new Map(milestonesFile.milestones.map((m) => [m.id, m])),
    outById: new Map(outings.map((o) => [o.id, o])),
    msToActs,
  };
}

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

interface AppCtx {
  ready: boolean;
  state: DeviceState;
  birth: YM | null;
  age: AgeInfo | null;
  setBirth: (birth: string) => void;
  toggleSave: (id: string) => void;
  isSaved: (id: string) => boolean;
  swipe: (id: string, dir: SwipeDir) => void;
  tried: (id: string, result: TriedResult) => void;
  setFilters: (f: Filters) => void;
  toggleSeen: (id: string) => void;
  setTagAffinity: (t: Record<string, number>) => void;
  dismissInstall: () => void;
  clearData: () => Promise<void>;
  // catalog
  catalog: FullCatalog | null;
  catalogError: boolean;
  ensureCatalog: () => void;
  getMonth: (m: number) => Promise<ByMonthFile>;
  // UI (in-memory only)
  searchOpen: boolean;
  setSearchOpen: (v: boolean) => void;
  viewMonth: number | null;
  setViewMonth: (m: number | null) => void;
  category: Category | 'all';
  setCategory: (c: Category | 'all') => void;
}

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp outside AppProvider');
  return c;
}

/** Returns the full catalog, triggering its load if needed. */
export function useCatalog(): { catalog: FullCatalog | null; error: boolean } {
  const { catalog, ensureCatalog, catalogError } = useApp();
  useEffect(() => { ensureCatalog(); }, [ensureCatalog]);
  return { catalog, error: catalogError };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<DeviceState>(() => emptyState(todaySG()));
  const loaded = useRef(false);

  // ---- load device state once ----
  useEffect(() => {
    let alive = true;
    loadState(todaySG()).then((s) => {
      if (!alive) return;
      // count one visit per browser session (for the add-to-home-screen prompt)
      let counted = false;
      try { counted = sessionStorage.getItem('bs-visit') === '1'; sessionStorage.setItem('bs-visit', '1'); } catch { /* ignore */ }
      const next = counted ? s : { ...s, visits: s.visits + 1 };
      loaded.current = true;
      setState(next);
      setReady(true);
      if (next !== s) saveState(next);
      // anonymous visit ping (disabled unless NEXT_PUBLIC_VISIT_URL is set)
      visitPing({
        url: VISIT_URL,
        lastPing: next.lastPing,
        savePing: (d) => setState((cur) => ({ ...cur, lastPing: d })),
      });
    });
    return () => { alive = false; };
  }, []);

  // ---- persist on every change after load ----
  const first = useRef(true);
  useEffect(() => {
    if (!loaded.current) return;
    if (first.current) { first.current = false; return; }
    saveState(state);
  }, [state]);

  const birth = useMemo(() => parseBirth(state.birth), [state.birth]);
  const age = useMemo(() => (birth ? ageInfo(birth, nowSG()) : null), [birth]);
  const ageMonths = age?.months ?? 0;

  const setBirth = useCallback((b: string) => {
    setState((s) => ({ ...s, birth: b }));
    requestPersist();
  }, []);
  const isSaved = useCallback((id: string) => state.favorites.includes(id), [state.favorites]);
  const toggleSave = useCallback((id: string) => {
    setState((s) => (s.favorites.includes(id) ? removeSave(s, id, ageMonths, Date.now()) : addSave(s, id, ageMonths, Date.now(), 'browse')));
    requestPersist();
  }, [ageMonths]);
  const swipe = useCallback((id: string, dir: SwipeDir) => {
    setState((s) => addSwipe(s, id, dir, ageMonths, Date.now()));
    requestPersist();
  }, [ageMonths]);
  const tried = useCallback((id: string, r: TriedResult) => {
    setState((s) => addTried(s, id, r, ageMonths, Date.now()));
  }, [ageMonths]);
  const setFilters = useCallback((f: Filters) => setState((s) => ({ ...s, filters: f })), []);
  const toggleSeen = useCallback((id: string) => setState((s) => toggleMilestoneSeen(s, id)), []);
  const setTagAffinity = useCallback((t: Record<string, number>) => setState((s) => ({ ...s, tagAffinity: t })), []);
  const dismissInstall = useCallback(() => setState((s) => ({ ...s, installDismissed: true })), []);

  // ---- catalog: latest.json version check on open (SDD §6.5) ----
  const [pointer, setPointer] = useState<LatestPointer | null>(null);
  const [pending, setPending] = useState<LatestPointer | null>(null);
  const [catalog, setCatalog] = useState<FullCatalog | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const fullPromise = useRef<Promise<void> | null>(null);
  const monthCache = useRef(new Map<string, Promise<ByMonthFile>>());
  const wantFull = useRef(false);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    (async () => {
      const cachedVersion = state.catalogVersion;
      let latest: LatestPointer | null = null;
      try {
        latest = await getJSON<LatestPointer>('/catalog/latest.json', { cache: 'no-store' });
      } catch {
        latest = null; // offline: fall back to the version we already have
      }
      if (!alive) return;
      if (!latest && cachedVersion !== null) {
        setPointer({ version: cachedVersion, published_at: '', path: `catalog/v${cachedVersion}/` });
      } else if (latest && cachedVersion !== null && latest.version > cachedVersion) {
        // newer catalog: keep showing the cached one, download the new one in the background,
        // switch on the next screen change.
        setPointer({ version: cachedVersion, published_at: '', path: `catalog/v${cachedVersion}/` });
        setPending(latest);
        Promise.all(['activities.json', 'milestones.json', 'outings.json'].map((f) => fetch(`/${latest!.path}${f}`))).catch(() => {});
      } else if (latest) {
        setPointer(latest);
        if (cachedVersion !== latest.version) setState((s) => ({ ...s, catalogVersion: latest!.version }));
      } else {
        setCatalogError(true);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const pathname = usePathname();
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (pathname === lastPath.current) return;
    lastPath.current = pathname;
    if (pending) {
      fullPromise.current = null;
      monthCache.current.clear();
      setCatalog(null);
      setPointer(pending);
      setState((s) => ({ ...s, catalogVersion: pending.version }));
      setPending(null);
    }
  }, [pathname, pending]);

  const loadFull = useCallback(() => {
    if (!pointer) return;
    if (fullPromise.current) return;
    const base = `/${pointer.path}`;
    fullPromise.current = Promise.all([
      getJSON<Activity[]>(`${base}activities.json`),
      getJSON<MilestonesFile>(`${base}milestones.json`),
      getJSON<Outing[]>(`${base}outings.json`),
    ])
      .then(([a, m, o]) => { setCatalog(buildFull(pointer.version, a, m, o)); setCatalogError(false); })
      .catch(() => { fullPromise.current = null; setCatalogError(true); });
  }, [pointer]);

  const ensureCatalog = useCallback(() => {
    wantFull.current = true;
    loadFull();
  }, [loadFull]);

  // Load the full catalog after first paint (idle), or immediately if a screen asked for it.
  useEffect(() => {
    if (!pointer) return;
    if (wantFull.current) { loadFull(); return; }
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(loadFull, { timeout: 2500 });
    else setTimeout(loadFull, 1200);
  }, [pointer, loadFull]);

  const getMonth = useCallback(async (m: number): Promise<ByMonthFile> => {
    if (!pointer) throw new Error('catalog not ready');
    const key = `${pointer.path}${m}`;
    const hit = monthCache.current.get(key);
    if (hit) return hit;
    const p = getJSON<ByMonthFile>(`/${pointer.path}by_month/${String(m).padStart(2, '0')}.json`);
    monthCache.current.set(key, p);
    p.catch(() => monthCache.current.delete(key));
    return p;
  }, [pointer]);

  const clearData = useCallback(async () => {
    await clearAllData();
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    window.location.href = '/';
  }, []);

  // ---- UI state ----
  const [searchOpen, setSearchOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState<number | null>(null);
  const [category, setCategory] = useState<Category | 'all'>('all');

  const value: AppCtx = {
    ready, state, birth, age, setBirth, toggleSave, isSaved, swipe, tried, setFilters, toggleSeen, setTagAffinity,
    dismissInstall, clearData,
    catalog, catalogError: catalogError && !catalog, ensureCatalog, getMonth: pointer ? getMonth : () => new Promise(() => {}),
    searchOpen, setSearchOpen, viewMonth, setViewMonth, category, setCategory,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
