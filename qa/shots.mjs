// Usage: node shots.mjs <baseUrl> <outDir> [only]
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:4321';
const outDir = process.argv[3] ?? 'shots';
const only = process.argv[4];
mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--font-render-hinting=none', '--disable-gpu'],
});

const STATE = {
  birth: '2025-06', createdAt: '2026-10-01', catalogVersion: null, interactions: [], favorites: [],
  milestonesSeen: [], tagAffinity: {}, filters: { setting: 'any', energy: 'any', duration: 'any', hidePaid: false },
  lastPing: null, visits: 1, installDismissed: true,
};

async function seed(page, state) {
  await page.goto(base + '/settings/', { waitUntil: 'networkidle0' });
  await page.evaluate((s) => new Promise((res, rej) => {
    const r = indexedDB.open('keyval-store');
    r.onupgradeneeded = () => r.result.createObjectStore('keyval');
    r.onsuccess = () => {
      const db = r.result;
      const tx = db.transaction('keyval', 'readwrite');
      if (s) tx.objectStore('keyval').put(s, 'bd-state-v1'); else tx.objectStore('keyval').delete('bd-state-v1');
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
    r.onerror = () => rej(r.error);
  }), state);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const shots = [
  { name: 'onboarding', path: '/', w: 390, h: 844, state: null },
  { name: 'today', path: '/', w: 390, h: 844 },
  { name: 'filters-sheet', path: '/', w: 390, h: 844, act: async (p) => { await p.click('.chip.filters'); await sleep(500); } },
  { name: 'milestone-detail', path: '/milestone/?id=gm-18-1', w: 390, h: 844 },
  { name: 'for-you', path: '/for-you/', w: 390, h: 844, act: async (p) => { const b = await p.$('[data-confirm-age]'); if (b) { await b.click(); await sleep(600); } } },
  { name: 'for-you-picks', path: '/for-you/', w: 390, h: 844, act: async (p) => {
      const b = await p.$('[data-confirm-age]'); if (b) { await b.click(); await sleep(400); }
      for (let i = 0; i < 8; i++) { const btn = await p.$(i % 3 === 0 ? '[data-swipe=pass]' : '[data-swipe=like]'); if (!btn) break; await btn.click(); await sleep(450); }
      await sleep(600);
    } },
  { name: 'for-you-saved', path: '/for-you/', w: 390, h: 844, act: async (p) => {
      const b = await p.$('[data-confirm-age]'); if (b) { await b.click(); await sleep(300); }
      const t = await p.$('[data-tab=saved]'); if (t) { await t.click(); await sleep(400); }
    } },
  { name: 'outings', path: '/outings/', w: 390, h: 844 },
  { name: 'outing-detail', path: '/outing/?id=sg-event-gbtb-christmas-train-show-2026', w: 390, h: 844 },
  { name: 'activity-detail', path: '/activity/?id=act-m16-gm-01', w: 390, h: 844 },
  { name: 'search', path: '/', w: 390, h: 844, act: async (p) => { await p.click('.phead .iconbtn'); await sleep(700); await p.type('#q', 'balls'); await sleep(600); } },
  { name: 'milestones', path: '/milestones/', w: 390, h: 844 },
  { name: 'settings', path: '/settings/', w: 390, h: 844 },
  { name: 'today-desktop', path: '/', w: 1440, h: 900 },
  { name: 'today-tablet', path: '/', w: 900, h: 1100 },
];

for (const s of shots) {
  if (only && !only.split(',').includes(s.name)) continue;
  const page = await browser.newPage();
  await page.setViewport({ width: s.w, height: s.h, deviceScaleFactor: 2, isMobile: s.w < 768, hasTouch: s.w < 768 });
  page.on('pageerror', (e) => console.error(`[${s.name}] pageerror:`, e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error(`[${s.name}] console:`, m.text()); });
  const st = s.state === undefined ? STATE : s.state;
  await seed(page, s.extraState ? { ...st, ...s.extraState } : st);
  await page.goto(base + s.path, { waitUntil: 'networkidle0' });
  await sleep(900);
  if (s.act) await s.act(page);
  await page.mouse.move(1, 1);
  await page.screenshot({ path: `${outDir}/${s.name}.png` });
  console.log('shot', s.name);
  await page.close();
}
await browser.close();
