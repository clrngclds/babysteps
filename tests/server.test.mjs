import { describe, expect, it } from 'vitest';
import {
  cacheControl, contentType, csp, inlineScriptHashes, isCatalogPath, pickEncoding, resolveStatic, sgDate, validateVisit,
  LEGACY_VISIT_BODY_UNTIL, visitRow,
} from '../server/lib.mjs';

describe('validateVisit', () => {
  const during = { today: '2026-10-19' };
  const after = { today: '2026-11-03' };
  it('accepts exactly the three boolean flags', () => {
    expect(validateVisit('{"day_first":true,"month_first":false,"week_first":true}', during)).toEqual({ day_first: true, month_first: false, week_first: true });
    expect(validateVisit('{"week_first":false,"month_first":true,"day_first":true}', during)).toEqual({ day_first: true, month_first: true, week_first: false });
    expect(validateVisit('{"day_first":true,"month_first":false,"week_first":true}', after)).toEqual({ day_first: true, month_first: false, week_first: true });
    expect(validateVisit('{"day_first":true,"month_first":false,"week_first":true}')).toEqual({ day_first: true, month_first: false, week_first: true });
  });
  it('accepts the old two-flag body for cached clients until the cutoff', () => {
    expect(LEGACY_VISIT_BODY_UNTIL).toBe('2026-11-02'); // 2 weeks after the 2026-10-19 deploy
    expect(validateVisit('{"day_first":true,"month_first":false}', during)).toEqual({ day_first: true, month_first: false });
    expect(validateVisit('{"month_first":true,"day_first":true}', during)).toEqual({ day_first: true, month_first: true });
    expect(validateVisit('{"day_first":true,"month_first":true}', { today: '2026-11-02' })).toEqual({ day_first: true, month_first: true });
  });
  it('rejects the old two-flag body after the cutoff', () => {
    expect(validateVisit('{"day_first":true,"month_first":false}', after)).toBeNull();
    expect(validateVisit('{"day_first":true,"month_first":false}', { today: '2027-01-01' })).toBeNull();
    expect(validateVisit('{"day_first":true,"month_first":false}', { today: '2026-10-20', legacyUntil: '2026-10-19' })).toBeNull();
  });
  it.each([
    '', 'null', '[]', '"x"', '1', '{', '{}',
    '{"day_first":true}',
    '{"week_first":true}',
    '{"day_first":true,"week_first":true}',
    '{"month_first":true,"week_first":true}',
    '{"day_first":"true","month_first":false}',
    '{"day_first":1,"month_first":0}',
    '{"day_first":true,"month_first":false,"id":"abc"}',
    '{"day_first":true,"month_first":null}',
    '[{"day_first":true,"month_first":false}]',
    '{"day_first":true,"month_first":false,"week_first":"true"}',
    '{"day_first":true,"month_first":false,"week_first":null}',
    '{"day_first":true,"month_first":false,"week_first":1}',
    '{"day_first":true,"month_first":"no","week_first":true}',
    '{"day_first":true,"month_first":false,"week_first":true,"id":"abc"}',
    '{"day_first":true,"month_first":false,"week_first":true,"ua":"x"}',
    '{"day_first":true,"month_first":false,"week_first":true,"week_firsts":true}',
    '{"day_first":true,"month_first":false,"year_first":true}',
    '[{"day_first":true,"month_first":false,"week_first":true}]',
  ])('rejects %s', (raw) => {
    expect(validateVisit(raw, during)).toBeNull();
  });
});

describe('visitRow', () => {
  it('stores only the date and the flags', () => {
    expect(visitRow({ day_first: true, month_first: false, week_first: true }, '2026-10-19')).toEqual({ date: '2026-10-19', day_first: true, month_first: false, week_first: true });
    expect(Object.keys(visitRow({ day_first: true, month_first: false, week_first: false }, '2026-10-19'))).toEqual(['date', 'day_first', 'month_first', 'week_first']);
  });
  it('leaves week_first out (NULL) for the old body', () => {
    const row = visitRow({ day_first: true, month_first: true }, '2026-10-19');
    expect(row).toEqual({ date: '2026-10-19', day_first: true, month_first: true });
    expect('week_first' in row).toBe(false);
  });
  it('never copies extra fields', () => {
    expect(visitRow({ day_first: true, month_first: true, week_first: true, ip: '1.2.3.4' }, '2026-10-19')).not.toHaveProperty('ip');
  });
});

describe('cacheControl', () => {
  const imm = 'public, max-age=31536000, immutable';
  it('long-caches hashed and versioned assets', () => {
    expect(cacheControl('/_next/static/chunks/main-abc.js')).toBe(imm);
    expect(cacheControl('/_next/static/media/x.woff2')).toBe(imm);
    expect(cacheControl('/catalog/v1/activities.json')).toBe(imm);
    expect(cacheControl('/catalog/v12/by_month/03.json')).toBe(imm);
  });
  it('revalidates pointers, sw and html', () => {
    expect(cacheControl('/catalog/latest.json')).toBe('no-cache');
    expect(cacheControl('/sw.js')).toBe('no-cache');
    expect(cacheControl('/')).toBe('no-cache');
    expect(cacheControl('/milestones/')).toBe('no-cache');
    expect(cacheControl('/404.html')).toBe('no-cache');
    expect(cacheControl('/index.txt')).toBe('no-cache');
  });
  it('long-caches icons', () => {
    expect(cacheControl('/icons/icon-192.png')).toMatch(/max-age=2592000/);
  });
});

describe('resolveStatic', () => {
  const files = new Set(['/index.html', '/milestones/index.html', '/sw.js', '/index.txt']);
  const has = (k) => files.has(k);
  it('maps trailing-slash routes to index.html', () => {
    expect(resolveStatic('/', has)).toEqual({ file: '/index.html' });
    expect(resolveStatic('/milestones/', has)).toEqual({ file: '/milestones/index.html' });
  });
  it('redirects routes without the slash', () => {
    expect(resolveStatic('/milestones', has)).toEqual({ redirect: '/milestones/' });
  });
  it('serves files and misses unknown paths', () => {
    expect(resolveStatic('/sw.js', has)).toEqual({ file: '/sw.js' });
    expect(resolveStatic('/nope/', has)).toBeNull();
    expect(resolveStatic('/nope', has)).toBeNull();
    expect(resolveStatic('/../etc/passwd', has)).toBeNull();
  });
});

describe('isCatalogPath', () => {
  it('allows latest.json and versioned json only', () => {
    expect(isCatalogPath('/catalog/latest.json')).toBe(true);
    expect(isCatalogPath('/catalog/v1/activities.json')).toBe(true);
    expect(isCatalogPath('/catalog/v3/by_month/07.json')).toBe(true);
    expect(isCatalogPath('/catalog/v0/x.json')).toBe(false);
    expect(isCatalogPath('/catalog/v1/../secret.json')).toBe(false);
    expect(isCatalogPath('/catalog/v1/x.txt')).toBe(false);
    expect(isCatalogPath('/catalog/other.json')).toBe(false);
  });
});

describe('misc', () => {
  it('uses Singapore dates', () => {
    expect(sgDate(new Date('2026-10-18T16:30:00Z'))).toBe('2026-10-19');
    expect(sgDate(new Date('2026-10-18T15:59:00Z'))).toBe('2026-10-18');
  });
  it('content types', () => {
    expect(contentType('/index.txt')).toMatch(/^text\/plain/);
    expect(contentType('/a.woff2')).toBe('font/woff2');
    expect(contentType('/manifest.webmanifest')).toMatch(/manifest\+json/);
  });
  it('hashes inline scripts only', () => {
    const h = inlineScriptHashes('<script src="/a.js"></script><script>alert(1)</script><script async="">x()</script>');
    expect(h).toHaveLength(2);
    expect(csp(h)).toContain(h[0]);
    const scriptSrc = csp(h).split('; ').find((d) => d.startsWith('script-src '));
    expect(scriptSrc).not.toMatch(/unsafe|\*|https?:/);
  });
  it('picks encodings', () => {
    expect(pickEncoding('gzip, deflate, br', { br: true, gzip: true })).toBe('br');
    expect(pickEncoding('gzip', { br: true, gzip: true })).toBe('gzip');
    expect(pickEncoding('br;q=0, gzip', { br: true, gzip: true })).toBe('gzip');
    expect(pickEncoding(undefined, { br: true, gzip: true })).toBeNull();
  });
});
