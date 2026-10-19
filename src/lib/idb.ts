import { get, set, del } from 'idb-keyval';
import { STATE_KEY, normalizeState, type DeviceState } from './state';

export async function loadState(today: string): Promise<DeviceState> {
  try {
    return normalizeState(await get(STATE_KEY), today);
  } catch {
    return normalizeState(null, today);
  }
}

export async function saveState(s: DeviceState): Promise<void> {
  try {
    await set(STATE_KEY, s);
  } catch {
    /* storage unavailable (e.g. some private modes): keep working in memory */
  }
}

/** "Clear my data": delete the IndexedDB record and the service worker caches (SDD §9.1). */
export async function clearAllData(): Promise<void> {
  try {
    await del(STATE_KEY);
  } catch {
    /* ignore */
  }
  if (typeof caches !== 'undefined') {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  }
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* ignore */
  }
}

let persistAsked = false;
/** Ask the browser not to evict our data (SDD §6.3). */
export async function requestPersist(): Promise<void> {
  if (persistAsked) return;
  persistAsked = true;
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* ignore */
  }
}
