export type Category = 'gross_motor' | 'fine_motor' | 'language' | 'social_emotional' | 'cognitive' | 'other';

export const CATEGORIES: Category[] = ['gross_motor', 'fine_motor', 'language', 'social_emotional', 'cognitive', 'other'];

export interface Activity {
  id: string;
  title: string;
  month: number;
  category: Category;
  philosophy: string[];
  milestone_ids: string[];
  summary: string;
  how_to: string;
  materials: string[];
  setting: 'indoor' | 'outdoor' | 'either';
  energy: 'calm' | 'moderate' | 'active';
  senses: string[];
  play_type: string[];
  duration_min: number;
  parent_role: 'lead' | 'alongside' | 'observe';
  safety_notes?: string;
  source_name: string;
  source_url: string;
  verified: boolean;
  paid: boolean;
  /** Phase 3 lifecycle fields (SDD 6.2): set by the content pipeline. */
  added_at?: string;
  status?: 'published' | 'retired' | string;
  origin?: 'seed' | 'pipeline' | string;
}

export interface Milestone {
  id: string;
  category: Category;
  month: number;
  text: string;
}

export type InteractionType =
  | 'swipe_like'
  | 'swipe_pass'
  | 'swipe_not_ready'
  | 'tried_enjoyed'
  | 'tried_meh'
  | 'tried_not_ready'
  | 'save'
  | 'unsave';

export interface Interaction {
  type: InteractionType;
  itemId: string;
  ageMonths: number;
  /** ms epoch */
  ts: number;
  /** only for save/unsave */
  via?: 'swipe' | 'browse';
}

export interface RecInput {
  activities: Activity[];
  milestones: Milestone[];
  checkpoints: number[];
  ageMonths: number;
  interactions: Interaction[];
  favorites: string[];
  milestonesSeen?: string[];
  hidePaid: boolean;
  /** ms */
  now: number;
}

export interface Pick {
  activity: Activity;
  score: number;
  reason: string;
  kind: 'saved' | 'milestone' | 'explore' | 'new' | 'age';
}
