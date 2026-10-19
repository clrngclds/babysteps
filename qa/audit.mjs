// QA audit: colour contrast (DOM), tap targets, third-party requests, offline, persistence.
import puppeteer from 'puppeteer-core';
const base = process.argv[2] ?? 'http://localhost:4321';
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = await b.newPage();
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
const requests = new Set();
page.on('request', (r) => requests.add(r.url()));
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

// --- persistence: onboarding through the UI, then reload + new page ---
await page.goto(base + '/', { waitUntil: 'networkidle0' });
await sleep(500);
const onb = await page.$('.onb');
console.log('onboarding shown on first open:', !!onb);
// future date rejected
const years = await page.$$eval('.onb select:nth-of-type(1)', () => 0);
await page.select('.onb .field:nth-child(1) select', '12');
const yNow = await page.$eval('.onb .field:nth-child(2) select option:nth-child(2)', (o) => o.value);
await page.select('.onb .field:nth-child(2) select', yNow);
await page.click('.onb button[type=submit]');
await sleep(300);
console.log('future date error:', await page.$eval('.err', (e) => e.textContent).catch(() => 'NONE'));
await page.select('.onb .field:nth-child(1) select', '6');
await page.select('.onb .field:nth-child(2) select', '2025');
await page.click('.onb button[type=submit]');
await sleep(1200);
console.log('after continue title:', await page.$eval('.phead h1', (e) => e.textContent));
await page.reload({ waitUntil: 'networkidle0' });
await sleep(800);
console.log('after reload title:', await page.$eval('.phead h1', (e) => e.textContent));
const p2 = await b.newPage();
await p2.setViewport({ width: 390, height: 844 });
await p2.goto(base + '/', { waitUntil: 'networkidle0' });
await sleep(800);
console.log('new tab title:', await p2.$eval('.phead h1', (e) => e.textContent).catch(() => 'ONBOARDING?'));
await p2.close();

// --- contrast + tap targets on each screen ---
const routes = ['/', '/milestones/', '/milestone/?id=gm-18-1', '/activity/?id=act-m16-gm-01', '/for-you/', '/outings/', '/outing/?id=sg-event-gbtb-christmas-train-show-2026', '/settings/'];
const lum = `(c)=>{const m=c.match(/[\\d.]+/g).map(Number);const f=(v)=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};return 0.2126*f(m[0])+0.7152*f(m[1])+0.0722*f(m[2]);}`;
let contrastFails = [];
let tapFails = [];
for (const r of routes) {
  await page.goto(base + r, { waitUntil: 'networkidle0' });
  await sleep(700);
  if (r === '/for-you/') { const c = await page.$('[data-confirm-age]'); if (c) { await c.click(); await sleep(500); } }
  const res = await page.evaluate((lumSrc) => {
    const L = eval(lumSrc);
    const bgOf = (el) => {
      for (let e = el; e; e = e.parentElement) {
        const c = getComputedStyle(e).backgroundColor;
        const m = c.match(/[\d.]+/g);
        if (m && (m.length < 4 || +m[3] > 0.5)) return c;
      }
      return 'rgb(246,248,241)';
    };
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    while (walker.nextNode()) {
      const t = walker.currentNode;
      if (!t.textContent.trim()) continue;
      const el = t.parentElement;
      if (!el || seen.has(el)) continue;
      seen.add(el);
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || cs.visibility === 'hidden' || cs.opacity === '0' || el.closest('[aria-hidden=true]')) continue;
      if (/\p{Extended_Pictographic}/u.test(t.textContent.trim()) && t.textContent.trim().length <= 3) continue;
      const fg = L(cs.color), bg = L(bgOf(el));
      const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      const size = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700;
      const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      if (ratio < need) out.push(`${ratio.toFixed(2)} < ${need}: "${t.textContent.trim().slice(0, 40)}" (${cs.color} on ${bgOf(el)})`);
    }
    const taps = [];
    for (const el of document.querySelectorAll('a, button, select, input, summary, [role=switch]')) {
      let rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      // stretched links (::after covering the card) take the size of the positioned card
      const after = getComputedStyle(el, '::after');
      if (after.content !== 'none' && after.position === 'absolute' && el.closest('.acard, .ev')) rect = el.closest('.acard, .ev').getBoundingClientRect();
      if (rect.width === 0 || cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (el.closest('.sr-only') || el.classList.contains('sr-only')) continue;
      // inline text links inside sentences are exempt (WCAG 2.5.8 inline exception)
      const inline = el.tagName === 'A' && cs.display === 'inline' && el.parentElement && /^(P|SPAN|LI|DD)$/.test(el.parentElement.tagName);
      if (rect.width < 48 || rect.height < 48) taps.push(`${inline ? '[inline] ' : ''}${el.tagName.toLowerCase()} ${Math.round(rect.width)}x${Math.round(rect.height)} "${(el.getAttribute('aria-label') || el.textContent).trim().slice(0, 30)}"`);
    }
    return { out, taps };
  }, lum);
  contrastFails.push(...res.out.map((x) => `${r}: ${x}`));
  tapFails.push(...res.taps.map((x) => `${r}: ${x}`));
}
console.log('\nCONTRAST FAILS:', contrastFails.length);
for (const c of [...new Set(contrastFails)].slice(0, 40)) console.log('  ', c);
console.log('\nTAP TARGETS < 48px:', tapFails.length);
for (const t of [...new Set(tapFails)].slice(0, 60)) console.log('  ', t);

// --- offline: service worker serves shell + catalog ---
await page.goto(base + '/', { waitUntil: 'networkidle0' });
await sleep(1500);
const swState = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return r?.active?.state ?? 'none'; });
console.log('\nservice worker:', swState);
await page.setOfflineMode(true);
await page.goto(base + '/milestone/?id=gm-09-2', { waitUntil: 'load' }).catch((e) => console.log('offline nav error', e.message));
await sleep(1500);
console.log('offline milestone page h1:', await page.$eval('h1', (e) => e.textContent).catch(() => 'FAIL'));
await page.goto(base + '/', { waitUntil: 'load' }).catch(() => {});
await sleep(1200);
console.log('offline today h1:', await page.$eval('.phead h1', (e) => e.textContent).catch(() => 'FAIL'));
await page.click('.phead .iconbtn'); await sleep(800);
await page.type('#q', 'crawl'); await sleep(500);
console.log('offline search groups:', await page.$$eval('.search-res h2', (h) => h.map((x) => x.textContent).join(' | ')).catch(() => 'FAIL'));
await page.setOfflineMode(false);

const third = [...requests].filter((u) => !u.startsWith(base) && !u.startsWith('data:'));
console.log('\nthird-party requests:', third.length ? third : 'none');
const persisted = await page.evaluate(() => navigator.storage?.persisted?.());
console.log('storage persisted (headless may deny):', persisted);
await b.close();
