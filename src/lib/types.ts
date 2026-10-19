export type { Activity, Milestone, Category, Interaction, InteractionType, Pick } from './recommender/types';
export { CATEGORIES } from './recommender/types';
import type { Activity, Category, Milestone } from './recommender/types';

export type Region = 'central' | 'north' | 'north-east' | 'east' | 'west';
export const REGIONS: Region[] = ['central', 'north', 'north-east', 'east', 'west'];

export interface Outing {
  id: string;
  name: string;
  type: 'venue' | 'programme' | 'event';
  summary: string;
  location: string;
  region: Region;
  min_age_months: number;
  max_age_months: number;
  categories: Category[];
  play_type: string[];
  setting: 'indoor' | 'outdoor' | 'either';
  rain_ok: boolean;
  paid: boolean;
  price_note: string;
  booking_required: boolean;
  start_date: string | null;
  end_date: string | null;
  recurrence: string | null;
  dates_confirmed: boolean;
  url: string;
  last_verified?: string;
  added_at?: string;
  notes?: string;
}

export interface CategoryInfo {
  id: Category;
  code: string;
  label: string;
}

export interface MilestonesFile {
  source: { name: string; url: string; note: string };
  categories: CategoryInfo[];
  checkpoints_months: number[];
  milestones: Milestone[];
}

export interface ByMonthFile {
  month: number;
  checkpoint: number;
  next_checkpoint: number | null;
  activities: Activity[];
  milestones: Milestone[];
}

export interface LatestPointer {
  version: number;
  published_at: string;
  path: string;
}
