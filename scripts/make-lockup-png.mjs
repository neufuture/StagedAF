// Renders PNG versions of the logo-with-name SVGs in brand/ (transparent
// background), at 1200 px wide for horizontal and 800 px for stacked.
//   NODE_PATH=$(npm root -g) node scripts/make-lockup-png.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.NODE_PATH ? path.join(process.env.NODE_PATH, 'playwright') : 'playwright');
const brand = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'brand');
const files = ['unitstager-logo', 'unitstager-logo-on-dark', 'unitstager-logo-white', 'unitstager-logo-stacked', 'unitstager-logo-stacked-on-dark'];
const browser = await chromium.launch();
for (const name of files) {
  const svg = fs.readFileSync(path.join(brand, name + '.svg'), 'utf8');
  const [, w, h] = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg).map(Number);
  const W = name.includes('stacked') ? 800 : 1200;
  const H = Math.round((W * h) / w);
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${W}px;height:${H}px}</style>${svg}`);
  await page.screenshot({ path: path.join(brand, name + '.png'), omitBackground: true });
  await page.close();
  console.log(`brand/${name}.png ${W}x${H}`);
}
await browser.close();
