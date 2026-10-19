/**
 * Minimal robots.txt (RFC 9309) parser and matcher.
 * We only need Allow/Disallow per user-agent group; Crawl-delay is ignored because the fetcher
 * already spaces requests 2 s apart per host.
 */

export interface RobotsRule {
  allow: boolean;
  /** Path pattern as written (may contain `*` and a trailing `$`). */
  pattern: string;
}

export interface RobotsGroup {
  /** Lowercased user-agent tokens of this group ("*" for the default group). */
  agents: string[];
  rules: RobotsRule[];
}

export interface RobotsRules {
  groups: RobotsGroup[];
  sitemaps: string[];
}

export function parseRobots(txt: string): RobotsRules {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  // A run of consecutive User-agent lines shares one group; the first rule line closes the run.
  let collectingAgents = false;

  for (const raw of txt.replace(/^\uFEFF/, '').split(/\r?\n|\r/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === 'user-agent') {
      if (!collectingAgents || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
        collectingAgents = true;
      }
      current.agents.push(value.toLowerCase());
    } else if (key === 'allow' || key === 'disallow') {
      collectingAgents = false;
      if (!current) continue; // rules before any User-agent line are ignored
      // An empty Disallow means "allow everything" and adds no rule.
      if (value === '') continue;
      current.rules.push({ allow: key === 'allow', pattern: value });
    } else if (key === 'sitemap') {
      if (value) sitemaps.push(value);
    } else {
      // Crawl-delay, Host, etc. do not end the agent run in practice; ignore.
    }
  }
  return { groups, sitemaps };
}

/** Product token used for group matching: "Mozilla/5.0 (...) Chrome/155" -> "mozilla". */
export function uaToken(userAgent: string): string {
  const m = /^\s*([A-Za-z0-9_-]+)/.exec(userAgent);
  return (m ? m[1] : userAgent).toLowerCase();
}

function selectRules(rules: RobotsRules, userAgent: string): RobotsRule[] {
  const token = uaToken(userAgent);
  const specific = rules.groups.filter((g) => g.agents.some((a) => a !== '*' && a === token));
  const chosen = specific.length ? specific : rules.groups.filter((g) => g.agents.includes('*'));
  // RFC 9309: multiple groups for the same agent are merged.
  return chosen.flatMap((g) => g.rules);
}

/** Compile a robots path pattern to a RegExp anchored at the path start. */
function patternToRegExp(pattern: string): RegExp {
  let p = pattern;
  let anchoredEnd = false;
  if (p.endsWith('$')) {
    anchoredEnd = true;
    p = p.slice(0, -1);
  }
  const body = p
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + body + (anchoredEnd ? '$' : ''));
}

function normalisePath(p: string): string {
  if (!p.startsWith('/')) p = '/' + p;
  // Compare percent-encoded forms case-insensitively by decoding where safe.
  try {
    return decodeURI(p);
  } catch {
    return p;
  }
}

/**
 * Longest matching pattern wins; on a tie Allow wins. No matching rule = allowed.
 * `urlPath` is the path plus query string (e.g. "/events?page=2").
 */
export function isAllowed(rules: RobotsRules, urlPath: string, userAgent: string): boolean {
  const path = normalisePath(urlPath || '/');
  if (path === '/robots.txt') return true;
  let best: RobotsRule | null = null;
  let bestLen = -1;
  for (const rule of selectRules(rules, userAgent)) {
    const pat = normalisePath(rule.pattern);
    if (!patternToRegExp(pat).test(path)) continue;
    const len = pat.length;
    if (len > bestLen || (len === bestLen && rule.allow && best && !best.allow)) {
      best = rule;
      bestLen = len;
    }
  }
  return best ? best.allow : true;
}
