import type { Activity, Category } from './types';

export const CAT_LABEL: Record<Category, string> = {
  gross_motor: 'Gross motor',
  fine_motor: 'Fine motor',
  language: 'Language',
  social_emotional: 'Social-emotional',
  cognitive: 'Cognitive',
  other: 'Other',
};

/** Shorter chip labels (mockup). */
export const CAT_CHIP: Record<Category, string> = {
  gross_motor: 'Gross motor',
  fine_motor: 'Fine motor',
  language: 'Language',
  social_emotional: 'Social',
  cognitive: 'Cognitive',
  other: 'Other',
};

export const CAT_EMOJI: Record<Category, string> = {
  gross_motor: '🏃',
  fine_motor: '✋',
  language: '💬',
  social_emotional: '💛',
  cognitive: '🧩',
  other: '🌿',
};

/** CSS class suffix for category colour fills. */
export const CAT_CLASS: Record<Category, string> = {
  gross_motor: 'gm',
  fine_motor: 'fm',
  language: 'lang',
  social_emotional: 'se',
  cognitive: 'cog',
  other: 'oth',
};

export const SETTING_LABEL: Record<Activity['setting'], string> = {
  indoor: 'Indoor',
  outdoor: 'Outdoor',
  either: 'Indoor/outdoor',
};

export const ENERGY_LABEL: Record<Activity['energy'], string> = {
  calm: 'Calm',
  moderate: 'Moderate',
  active: 'Active',
};

export const ROLE_LABEL: Record<Activity['parent_role'], string> = {
  lead: 'You lead',
  alongside: 'Play alongside',
  observe: 'You watch',
};

export const REGION_LABEL: Record<string, string> = {
  central: 'Central',
  north: 'North',
  'north-east': 'North-East',
  east: 'East',
  west: 'West',
};

/** "10 min · Indoor" (max 2 metadata items on cards; SDD allows 3). */
export function activityMeta(a: Activity): string {
  return `${a.duration_min} min · ${SETTING_LABEL[a.setting]}`;
}

/** Split how_to text into short steps (sentences). */
export function howToSteps(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“'])/)
    .map((s) => s.trim())
    .filter(Boolean);
}
