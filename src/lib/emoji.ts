import type { Activity, Outing } from './types';
import { CAT_EMOJI } from './labels';

/**
 * Placeholder imagery (SDD §4.4: the mockup uses emoji; production uses a commissioned
 * illustration set). Keyword match on the title, then fall back to the category emoji.
 */
const RULES: [RegExp, string][] = [
  [/\bball|kick|roll\b/i, '⚽'],
  [/book|story|read|librar/i, '📚'],
  [/sing|song|music|rhyme|drum|shaker|rattle|instrument|dance|bell/i, '🎵'],
  [/water|bath|pour|splash|swim|wash/i, '💧'],
  [/block|stack|tower|build/i, '🧱'],
  [/crayon|draw|scribble|paint|chalk|colour|color/i, '🖍️'],
  [/mirror/i, '🪞'],
  [/puzzle|shape|sort/i, '🧩'],
  [/stair|climb/i, '🪜'],
  [/walk|push|wagon|cruise/i, '🚶'],
  [/tummy|roll over|lift/i, '🤸'],
  [/peek|hide|boo/i, '🙈'],
  [/garden|plant|leaf|leaves|flower|nature|outdoor|park|grass/i, '🌱'],
  [/sand|dig/i, '🏖️'],
  [/broom|sweep|clean|tidy|wipe/i, '🧹'],
  [/cup|glass|drink|pitcher/i, '🥛'],
  [/cook|food|snack|meal|spoon|fork|eat|fruit/i, '🥄'],
  [/dress|shoe|sock|clothes|button|zip/i, '👟'],
  [/car|truck|train|vehicle/i, '🚗'],
  [/animal|dog|cat|bird|farm|zoo/i, '🐾'],
  [/doll|teddy|pretend|tea party/i, '🧸'],
  [/face|smile|talk|chat|babble|word|name/i, '😊'],
  [/light|torch|shadow|contrast|black and white/i, '🔦'],
  [/bubble/i, '🫧'],
  [/basket|treasure|box/i, '🧺'],
  [/scissor|cut/i, '✂️'],
  [/bead|thread|lace/i, '🪡'],
  [/play ?dough|clay/i, '🟢'],
];

export function activityEmoji(a: Pick<Activity, 'title' | 'category'>): string {
  for (const [re, e] of RULES) if (re.test(a.title)) return e;
  return CAT_EMOJI[a.category];
}

export function outingEmoji(o: Pick<Outing, 'name' | 'play_type' | 'type'>): string {
  const n = o.name.toLowerCase();
  if (/library|read|story|book|tales|lapsit|rhyme/.test(n)) return '📚';
  if (/zoo|bird|animal|farm|oceanarium|aquarium/.test(n)) return '🐾';
  if (/train/.test(n)) return '🚂';
  if (/hongbao|cny|chinatown|deepavali|blossom/.test(n)) return '🏮';
  if (/christmas|light|wonderland/.test(n)) return '🎄';
  if (/garden|park|nature|beach|reservoir/.test(n)) return '🌳';
  if (/museum|gallery|art/.test(n)) return '🎨';
  if (/water|splash|pool/.test(n)) return '💦';
  if (/playtime|esplanade|music|theatre/.test(n)) return '🎭';
  if (/hongbao|cny|chinatown|deepavali|blossom/.test(n)) return '🏮';
  if (o.play_type.includes('nature')) return '🌳';
  return o.type === 'event' ? '🎪' : '📍';
}
