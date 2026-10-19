// Live-site check: onboarding, Today, service worker, visit ping, CSP, third-party requests, offline.
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const base = process.argv[2];
const outDir = process.argv[3] || 'screenshots';
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const ctx = await b.createBrowserContext();
const page = await ctx.newPage();
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

const origin = new URL(base).origin;
const thirdParty = new Set();
const cspViolations = [];
const pageErrors = [];
const visits = [];
page.on('request', (r) => { if (!r.url().startsWith(origin) && !r.url().startsWith('data:')) thirdParty.add(r.url()); });
page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) cspViolations.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('response', async (r) => {
  if (r.url().endsWith('/api/visit')) visits.push({ status: r.status(), body: r.request().postData() });
});
const shot = async (name) => { await page.screenshot({ path: `${outDir}/${name}.png` }); };

// 1. First open: onboarding
await page.goto(base + '/', { waitUntil: 'networkidle0' });
await sleep(800);
results.onboardingShown = Boolean(await page.$('.onb'));
await shot('01-onboarding');

// 2. Complete onboarding (born June 2025)
await page.select('.onb .field:nth-child(1) select', '6');
await page.select('.onb .field:nth-child(2) select', '2025');
await page.click('.onb button[type=submit]');
await page.waitForSelector('.phead h1', { timeout: 10000 });
await sleep(1500);
results.todayTitle = await page.$eval('.phead h1', (e) => e.textContent);
results.todayActivityCards = await page.$$eval('a[href*="/activity/"]', (l) => l.length);
await shot('02-today');

// 3. Service worker registers and controls the page after a reload
results.swState = await page.evaluate(async () => {
  const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 15000))]);
  return reg?.active?.state ?? 'none';
});
await sleep(3000); // let install-time precaching settle
await page.reload({ waitUntil: 'networkidle0' });
await sleep(1000);
results.swControlling = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
results.caches = await page.evaluate(async () => {
  const out = {};
  for (const k of await caches.keys()) out[k] = (await (await caches.open(k)).keys()).length;
  return out;
});

// 4. A few screens online
await page.goto(base + '/milestones/', { waitUntil: 'networkidle0' });
await sleep(800);
await shot('03-milestones');
await page.goto(base + '/milestone/?id=gm-18-1', { waitUntil: 'networkidle0' });
await sleep(800);
await shot('04-milestone-detail');
const actHref = await (async () => {
  await page.goto(base + '/', { waitUntil: 'networkidle0' });
  await sleep(1000);
  return page.$eval('a[href*="/activity/"]', (a) => a.getAttribute('href'));
})();
await page.goto(base + actHref, { waitUntil: 'networkidle0' });
await sleep(800);
await shot('05-activity-detail');

await page.goto(base + '/settings/', { waitUntil: 'networkidle0' });
await sleep(800);
results.settingsPrivacy = await page.$eval('section.card p.muted', (e) => e.textContent.trim()).catch(() => null);
await shot('09-settings');

// 5. Offline after first load
await page.setOfflineMode(true);
const offline = {};
await page.goto(base + '/', { waitUntil: 'domcontentloaded' }).catch((e) => (offline.todayErr = e.message));
await sleep(2500);
offline.todayTitle = await page.$eval('.phead h1', (e) => e.textContent).catch(() => null);
offline.todayCards = await page.$$eval('a[href*="/activity/"]', (l) => l.length);
await shot('06-offline-today');
await page.goto(base + '/milestones/', { waitUntil: 'domcontentloaded' }).catch((e) => (offline.milestonesErr = e.message));
await sleep(2000);
offline.milestonesTitle = await page.$eval('.phead h1, h1', (e) => e.textContent).catch(() => null);
await shot('07-offline-milestones');
await page.goto(base + actHref, { waitUntil: 'domcontentloaded' }).catch((e) => (offline.activityErr = e.message));
await sleep(2000);
offline.activityTitle = await page.$eval('h1', (e) => e.textContent).catch(() => null);
await shot('08-offline-activity');
results.offline = offline;
await page.setOfflineMode(false);

results.visitPings = visits;
results.thirdPartyRequests = [...thirdParty];
results.cspViolations = cspViolations;
results.pageErrors = pageErrors;
console.log(JSON.stringify(results, null, 2));
await b.close();
