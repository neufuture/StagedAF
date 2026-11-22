// Draws the UnitStager logo and writes every size the extension, website and
// stores need. The logo is defined here, in code, so it stays consistent.
//   NODE_PATH=$(npm root -g) node scripts/make-icons.mjs      (needs Playwright)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.NODE_PATH ? path.join(process.env.NODE_PATH, 'playwright') : 'playwright');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const I = '#4f46e5';
const W = '#ffffff';

// Sofa in a 96x56 box: two back cushions, slim arms, one seat cushion, tapered legs.
const sofa = (detail) => `
  <rect x="11" y="3" width="74" height="30" rx="9" fill="${W}"/>
  ${detail ? `<path d="M48 6V30" stroke="${I}" stroke-width="3.2" stroke-linecap="round"/>` : ''}
  <rect x="0" y="15" width="17" height="32" rx="8.5" fill="${W}" stroke="${I}" stroke-width="3.2"/>
  <rect x="79" y="15" width="17" height="32" rx="8.5" fill="${W}" stroke="${I}" stroke-width="3.2"/>
  <rect x="14" y="29" width="68" height="17" rx="5.5" fill="${W}" stroke="${I}" stroke-width="3.2"/>
  <path d="M13 47h8l-2 9h-4zM75 47h8l-2 9h-4z" fill="${W}"/>`;
const at = (x, y, s, body) => `<g transform="translate(${x} ${y}) scale(${s})">${body}</g>`;
const star = (cx, cy, r) => {
  const k = r * 0.26;
  return `<path fill="${W}" d="M${cx} ${cy - r}L${cx + k} ${cy - k}L${cx + r} ${cy}L${cx + k} ${cy + k}L${cx} ${cy + r}L${cx - k} ${cy + k}L${cx - r} ${cy}L${cx - k} ${cy - k}Z"/>`;
};

// The mark: a photo frame with a sofa in it and a spark breaking the corner.
// Drawn on a 128 grid, inside the circle of radius 58 around the centre, so it
// fits a rounded square and a circle alike.
const full = `<rect x="21" y="36" width="80" height="60" rx="12" fill="none" stroke="${W}" stroke-width="6"/>
  <circle cx="99" cy="37" r="17.5" fill="${I}"/>${at(34, 57, 0.562, sofa(true))}${star(99, 37, 14)}`;
// Simplified for toolbar sizes (16–32 px).
const small = `<rect x="16" y="34" width="88" height="68" rx="14" fill="none" stroke="${W}" stroke-width="10"/>
  <circle cx="101" cy="35" r="22" fill="${I}"/>${at(31, 62, 0.6, sofa(false))}${star(101, 35, 18)}`;

const svg = (bg, art) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${bg}${art}</svg>\n`;
const SQUARE = `<rect width="128" height="128" rx="28" fill="${I}"/>`;
const CIRCLE = `<circle cx="64" cy="64" r="64" fill="${I}"/>`;
const BLEED = `<rect width="128" height="128" fill="${I}"/>`;

const files = {
  'brand/unitstager-icon.svg': svg(SQUARE, full),
  'brand/unitstager-icon-circle.svg': svg(CIRCLE, full),
  'brand/unitstager-icon-small.svg': svg(SQUARE, small),
  'server/public/logo.svg': svg(SQUARE, full),
  'server/public/favicon.svg': svg(SQUARE, small),
};
for (const [f, s] of Object.entries(files)) fs.writeFileSync(path.join(root, f), s);

const pngs = [
  ['icons/icon16.png', svg(SQUARE, small), 16],
  ['icons/icon32.png', svg(SQUARE, small), 32],
  ['icons/icon48.png', svg(SQUARE, full), 48],
  ['icons/icon128.png', svg(SQUARE, full), 128],
  ['brand/unitstager-icon-512.png', svg(SQUARE, full), 512],
  ['brand/unitstager-icon-300.png', svg(SQUARE, full), 300], // Edge Add-ons store logo
  ['brand/unitstager-icon-circle-512.png', svg(CIRCLE, full), 512],
  ['server/public/favicon-32.png', svg(SQUARE, small), 32],
  ['server/public/apple-touch-icon.png', svg(BLEED, full), 180], // iOS rounds the corners itself
];
const browser = await chromium.launch();
for (const [file, source, size] of pngs) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`);
  await page.screenshot({ path: path.join(root, file), omitBackground: true });
  await page.close();
}
await browser.close();
console.log('wrote', Object.keys(files).length, 'svg and', pngs.length, 'png files');
