/**
 * Polite HTTP client (SDD §8.3 step 1): full browser user agent, robots.txt honoured,
 * at most one request every 2 s per host (robots fetch included), different hosts in parallel.
 * Never throws; every failure is reported in FetchResult.
 */
import type { FetchOptions, FetchResult, Fetcher } from '../types';
import { isAllowed, parseRobots, type RobotsRules } from './robots';

/** Current stable desktop Chrome (reduced UA string, as Chrome itself sends it). */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

const DEFAULT_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';

export interface FetcherOptions {
  hostDelayMs?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface RobotsInfo {
  /** null = allow all (missing robots.txt or fetch error). */
  rules: RobotsRules | null;
  status: number;
  error?: string;
}

export interface PoliteFetcher extends Fetcher {
  /** robots.txt outcome for the URL's origin, if it has been fetched. */
  robotsInfo(url: string): RobotsInfo | undefined;
}

interface HostState {
  /** Tail of the per-host queue; each get() runs after the previous one for that host. */
  tail: Promise<unknown>;
  /** Earliest time the next request to this host may start. */
  nextAt: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createFetcher(opts: FetcherOptions = {}): PoliteFetcher {
  const hostDelayMs = opts.hostDelayMs ?? 2000;
  const userAgent = opts.userAgent ?? BROWSER_UA;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const defaultTimeout = opts.timeoutMs ?? 20_000;
  const maxBytes = opts.maxBytes ?? 3 * 1024 * 1024;

  const hosts = new Map<string, HostState>();
  const robots = new Map<string, RobotsInfo>();

  function hostState(host: string): HostState {
    let s = hosts.get(host);
    if (!s) {
      s = { tail: Promise.resolve(), nextAt: 0 };
      hosts.set(host, s);
    }
    return s;
  }

  /** Run `fn` exclusively for `host` (requests to one host never overlap). */
  function withHost<T>(host: string, fn: (pace: () => Promise<void>) => Promise<T>): Promise<T> {
    const s = hostState(host);
    const pace = async () => {
      const wait = s.nextAt - now();
      if (wait > 0) await sleep(wait);
      s.nextAt = now() + hostDelayMs;
    };
    const run = s.tail.then(() => fn(pace));
    s.tail = run.catch(() => undefined);
    return run;
  }

  async function rawRequest(url: string, method: 'GET' | 'HEAD', accept: string, timeoutMs: number, cap = maxBytes): Promise<FetchResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method,
        redirect: 'follow',
        signal: ctrl.signal,
        headers: {
          'User-Agent': userAgent,
          Accept: accept,
          'Accept-Language': 'en-SG,en;q=0.9',
        },
      });
      const contentType = res.headers.get('content-type') ?? '';
      const body = method === 'HEAD' ? '' : await readCapped(res, cap, contentType);
      const ok2xx = res.status >= 200 && res.status < 300;
      // A JS bot challenge is a 2xx/403 with no content; report it so callers don't treat it as a page.
      const challenge = isBotChallenge(res.status, body);
      return {
        url,
        finalUrl: res.url || url,
        status: res.status,
        ok: ok2xx && !challenge,
        contentType,
        body,
        ...(challenge ? { error: 'bot_challenge' } : ok2xx ? {} : { error: `http_${res.status}` }),
      };
    } catch (e) {
      const aborted = ctrl.signal.aborted;
      return {
        url,
        finalUrl: url,
        status: 0,
        ok: false,
        contentType: '',
        body: '',
        error: aborted ? 'timeout' : `network: ${errMessage(e)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadRobots(origin: string, pace: () => Promise<void>): Promise<RobotsInfo> {
    const cached = robots.get(origin);
    if (cached) return cached;
    await pace();
    const r = await rawRequest(origin + '/robots.txt', 'GET', 'text/plain,*/*;q=0.8', defaultTimeout);
    let info: RobotsInfo;
    if (r.ok) info = { rules: parseRobots(r.body), status: r.status };
    else if (r.error === 'bot_challenge') info = { rules: null, status: r.status, error: 'bot_challenge' };
    else if (r.status >= 400 && r.status < 500) info = { rules: null, status: r.status }; // no robots.txt = allow all
    else info = { rules: null, status: r.status, error: r.error ?? `http_${r.status}` }; // unreachable: allow, remember why
    robots.set(origin, info);
    return info;
  }

  const retryable = (r: FetchResult) => r.status === 0 || r.status === 429 || r.status >= 500;

  async function get(url: string, o: FetchOptions = {}): Promise<FetchResult> {
    let parsed: URL;
    try {
      parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol');
    } catch (e) {
      return { url, finalUrl: url, status: 0, ok: false, contentType: '', body: '', error: `invalid_url: ${errMessage(e)}` };
    }
    const method = o.method ?? 'GET';
    const accept = o.accept ?? DEFAULT_ACCEPT;
    const timeoutMs = o.timeoutMs ?? defaultTimeout;
    const cap = o.maxBytes ?? maxBytes;

    try {
      return await withHost(parsed.host.toLowerCase(), async (pace) => {
        if (!o.skipRobots) {
          const info = await loadRobots(parsed.origin, pace);
          if (info.rules && !isAllowed(info.rules, parsed.pathname + parsed.search, userAgent)) {
            return { url, finalUrl: url, status: 0, ok: false, contentType: '', body: '', error: 'robots_disallowed' };
          }
        }
        await pace();
        let r = await rawRequest(url, method, accept, timeoutMs, cap);
        if (retryable(r)) {
          await pace();
          r = await rawRequest(url, method, accept, timeoutMs, cap);
        }
        // Some servers reject HEAD; link checks then need a GET to know if the page exists.
        if (method === 'HEAD' && (r.status === 405 || r.status === 403)) {
          await pace();
          r = await rawRequest(url, 'GET', accept, timeoutMs, cap);
        }
        return r;
      });
    } catch (e) {
      return { url, finalUrl: url, status: 0, ok: false, contentType: '', body: '', error: `internal: ${errMessage(e)}` };
    }
  }

  return {
    get,
    robotsInfo(url: string) {
      try {
        return robots.get(new URL(url).origin);
      } catch {
        return undefined;
      }
    },
  };
}

/** AWS WAF / Cloudflare interstitials served instead of the page. */
export function isBotChallenge(status: number, body: string): boolean {
  if (status !== 202 && status !== 403 && status !== 503 && status !== 200) return false;
  const head = body.slice(0, 4000);
  return (
    /awsWafCookieDomainList|gokuProps|challenge\.js|AwsWafIntegration/.test(head) ||
    /<title>\s*(Just a moment\.\.\.|Attention Required! \| Cloudflare)/i.test(head) ||
    /cf-chl-|cf_chl_opt/.test(head)
  );
}

/** Read at most maxBytes of the body, then stop downloading. */
async function readCapped(res: Response, maxBytes: number, contentType: string): Promise<string> {
  const decoder = makeDecoder(contentType);
  if (!res.body) {
    const text = await res.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }
  const reader = res.body.getReader();
  let total = 0;
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - total;
    if (value.byteLength >= remaining) {
      out += decoder.decode(value.subarray(0, remaining), { stream: true });
      total = maxBytes;
      await reader.cancel().catch(() => undefined);
      break;
    }
    total += value.byteLength;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

function makeDecoder(contentType: string): TextDecoder {
  const m = /charset=["']?([\w-]+)/i.exec(contentType);
  try {
    return new TextDecoder(m ? m[1] : 'utf-8');
  } catch {
    return new TextDecoder('utf-8');
  }
}

function errMessage(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as Error & { cause?: unknown }).cause;
    const c = cause instanceof Error ? cause.message : cause ? String(cause) : '';
    return c ? `${e.message} (${c})` : e.message;
  }
  return String(e);
}
