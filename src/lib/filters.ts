import type { Activity, Category } from './types';

export interface Filters {
  setting: 'any' | 'indoor' | 'outdoor';
  energy: 'any' | 'calm' | 'moderate' | 'active';
  duration: 'any' | 'le5' | 'le15' | 'ge15';
  hidePaid: boolean;
}

export const DEFAULT_FILTERS: Filters = { setting: 'any', energy: 'any', duration: 'any', hidePaid: false };

export function activeFilterCount(f: Filters): number {
  return (f.setting !== 'any' ? 1 : 0) + (f.energy !== 'any' ? 1 : 0) + (f.duration !== 'any' ? 1 : 0) + (f.hidePaid ? 1 : 0);
}

export function matchesFilters(a: Activity, f: Filters): boolean {
  if (f.setting === 'indoor' && a.setting === 'outdoor') return false;
  if (f.setting === 'outdoor' && a.setting === 'indoor') return false;
  if (f.energy !== 'any' && a.energy !== f.energy) return false;
  if (f.duration === 'le5' && a.duration_min > 5) return false;
  if (f.duration === 'le15' && a.duration_min > 15) return false;
  if (f.duration === 'ge15' && a.duration_min < 15) return false;
  if (f.hidePaid && a.paid) return false;
  return true;
}

export function filterActivities(list: Activity[], f: Filters, category: Category | 'all' = 'all'): Activity[] {
  return list.filter((a) => (category === 'all' || a.category === category) && matchesFilters(a, f));
}

/** Short text summary for the Filters button on wide screens, e.g. "Indoor · ≤15 min". */
export function filterSummary(f: Filters): string {
  const parts: string[] = [];
  if (f.setting !== 'any') parts.push(f.setting === 'indoor' ? 'Indoor' : 'Outdoor');
  if (f.energy !== 'any') parts.push(f.energy[0].toUpperCase() + f.energy.slice(1));
  if (f.duration !== 'any') parts.push(f.duration === 'le5' ? '≤5 min' : f.duration === 'le15' ? '≤15 min' : '15+ min');
  if (f.hidePaid) parts.push('No paid');
  return parts.join(' · ');
}
