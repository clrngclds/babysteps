import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
const svg = readFileSync(process.argv[2], 'utf8');
const outDir = process.argv[3];
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const p = await b.newPage();
for (const [name, size, pad] of [['icon-192', 192, 0], ['icon-512', 512, 0], ['apple-touch-icon', 180, 0], ['icon-maskable-512', 512, 0]]) {
  await p.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await p.setContent(`<html><body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await p.screenshot({ path: `${outDir}/${name}.png`, omitBackground: false });
}
await b.close();
