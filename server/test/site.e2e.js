// Browser test of the website: sign up, stage a batch in the studio, then the
// account page (top up, auto top-up, receipts, payment methods, sign out).
// Uses the real server code against mock Supabase / Stripe / image API.
//   NODE_PATH=$(npm root -g) node test/site.e2e.js      (needs Playwright)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock, stripeSign } from './mock-upstream.js';
import { serve } from './serve.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.NODE_PATH ? path.join(process.env.NODE_PATH, 'playwright') : 'playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', '..', 'test', 'fixtures');
const shots = process.env.SHOTS || '';
const assert = (cond, msg) => {
  if (!cond) throw new Error('ASSERT: ' + msg);
  console.log('  ok  ' + msg);
};

const mock = await startMock({ imageBase64: fs.readFileSync(path.join(fixtures, 'staged.jpg')).toString('base64') });
const app = await serve({
  SUPABASE_URL: mock.url, SUPABASE_PUBLISHABLE_KEY: 'pub-key', SUPABASE_SECRET_KEY: 'secret-key',
  OPENAI_API_KEY: 'sk-server', OPENAI_BASE: mock.url + '/v1', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_BASE: mock.url,
  STRIPE_WEBHOOK_SECRET: 'whsec_test', SITE_URL: 'http://SITE', FREE_CREDITS: '2',
});
const site = app.url;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
await ctx.route('https://checkout.stripe.test/**', (r) => r.fulfill({ contentType: 'text/html', body: 'mock checkout' }));
await ctx.route('https://billing.stripe.test/**', (r) => r.fulfill({ contentType: 'text/html', body: 'mock portal' }));
await ctx.route('https://pay.stripe.test/**', (r) => r.fulfill({ contentType: 'text/html', body: 'mock receipt' }));
const errors = [];
const watch = (p) => {
  p.on('pageerror', (e) => errors.push(e.message));
  // Anything the Content-Security-Policy blocks shows up as a console error.
  p.on('console', (m) => m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text()) && errors.push('CSP: ' + m.text()));
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'us-site-'));
const photo = (name) => {
  const f = path.join(tmp, name);
  fs.copyFileSync(path.join(fixtures, 'empty.jpg'), f);
  return f;
};

try {
  console.log('Security headers');
  const head = await fetch(site + '/');
  assert(/frame-ancestors 'none'/.test(head.headers.get('content-security-policy') || '') && head.headers.get('x-frame-options') === 'DENY' && /max-age/.test(head.headers.get('strict-transport-security') || ''), 'pages are sent with a content security policy, clickjacking protection and HTTPS enforcement');
  assert((await fetch(site + '/_headers')).status === 404, 'the headers file itself is not served');

  console.log('Sign up');
  let page = await ctx.newPage();
  watch(page);
  await page.goto(site + '/');
  await page.locator('.hero a', { hasText: 'Sign up to try it for free' }).click();
  await page.waitForURL(/\/app\.html$/);
  await page.locator('#siEmail').fill('newpm@example.com');
  await page.locator('#emailForm button').click();
  await page.locator('#siCode').waitFor();
  assert(mock.state.emails.at(-1) === 'newpm@example.com', 'homepage link leads to sign-up; code emailed');
  await page.locator('#siCode').fill('999999');
  await page.locator('#codeForm button').click();
  await page.locator('#siMsg.bad').waitFor();
  await page.locator('#siCode').fill('123456');
  await page.locator('#codeForm button').click();
  await page.locator('#studio').waitFor();
  await page.locator('#credits', { hasText: '2 credits' }).waitFor();
  assert(true, 'wrong code refused; right code goes straight to the studio with 2 free credits');

  console.log('Studio');
  await page.locator('#files').setInputFiles([photo('kitchen.jpg'), photo('bedroom.jpg'), photo('living.jpg'), path.join(here, 'api.test.js')]);
  await page.locator('.tile').nth(2).waitFor();
  assert((await page.locator('.tile').count()) === 3 && /Skipped 1 file/.test(await page.locator('#addMsg').textContent()), 'three photos added, the non-photo skipped with a note');
  assert(await page.locator('#stageBtn').isDisabled() && /You have 2 credits/.test(await page.locator('#goMsg').textContent()), 'more photos than credits: blocked with a top-up link');
  await page.locator('.tile .x').nth(2).click();
  assert((await page.locator('#stageBtn').textContent()) === 'Stage 2 photos' && !(await page.locator('#stageBtn').isDisabled()), 'removing one enables "Stage 2 photos"');
  await page.locator('.tile select').nth(1).selectOption('bedroom');
  await page.locator('#style').selectOption('coastal');
  await page.locator('#custom').fill('navy accents');
  await page.locator('#label').check();
  if (shots) await page.screenshot({ path: shots + '/studio-ready.png', fullPage: true });
  const before = mock.state.image.length;
  await page.locator('#stageBtn').click();
  await page.locator('.tile.done').nth(1).waitFor({ timeout: 30000 });
  const sent = mock.state.image.slice(before).filter((c) => !c.fidelity);
  assert(sent.length === 2 && sent.some((c) => /photo of a bedroom/.test(c.prompt)) && sent.every((c) => /coastal furniture/.test(c.prompt) && /navy accents/.test(c.prompt)), 'both staged with the chosen style, instructions and per-photo room');
  await page.locator('#credits', { hasText: '0 credits' }).waitFor();
  const dl = await page.locator('.tile.done a', { hasText: 'Download' }).first().getAttribute('download');
  assert(dl === 'kitchen-staged.jpg', 'credits drop to 0; each result downloads as <name>-staged.jpg');
  await page.locator('.tile.done .actions button', { hasText: 'Show original' }).first().click();
  assert(/^blob:/.test(await page.locator('.tile.done img').first().getAttribute('src')), 'before/after toggle works');
  if (shots) await page.screenshot({ path: shots + '/studio-done.png', fullPage: true });
  await page.locator('#files').setInputFiles([photo('extra.jpg')]);
  assert(await page.locator('#stageBtn').isDisabled(), 'with 0 credits a new photo cannot be staged');
  await page.locator('#recentBody tr').nth(1).waitFor();
  assert((await page.locator('#recentBody tr').count()) === 2 && /Coastal/.test(await page.locator('#recentBody').innerText()), 'both appear under Recent stagings');

  console.log('Closing the page mid-staging');
  const userKey = [...mock.state.users.values()].find((u) => u.email === 'newpm@example.com').id;
  mock.state.accounts.set(userKey, 3);
  mock.state.imageDelay = 2500;
  page = await ctx.newPage();
  watch(page);
  await page.goto(site + '/app.html');
  await page.locator('#files').setInputFiles([photo('closed-early.jpg')]);
  await page.locator('#stageBtn').click();
  await page.locator('.tile.running .state', { hasText: 'Staging' }).waitFor();
  await page.close({ runBeforeUnload: false });
  assert(true, 'page closed while the photo was still staging');
  await app.idle();
  mock.state.imageDelay = 300;
  page = await ctx.newPage();
  watch(page);
  await page.goto(site + '/app.html');
  const row = page.locator('#recentBody tr', { hasText: 'closed-early.jpg' });
  await row.locator('button', { hasText: 'Download' }).waitFor();
  const [dlFile] = await Promise.all([page.waitForEvent('download'), row.locator('button', { hasText: 'Download' }).click()]);
  assert(dlFile.suggestedFilename() === 'closed-early-staged.jpg', 'it finished anyway, and downloads from Recent stagings when you come back');
  if (shots) await page.screenshot({ path: shots + '/studio-recent.png', fullPage: true });
  page.once('dialog', (d) => d.accept());
  await row.locator('button', { hasText: 'Delete' }).click();
  await row.waitFor({ state: 'detached' });
  assert(![...mock.state.stagings.values()].some((j) => j.name === 'closed-early.jpg'), 'Delete removes it');
  mock.state.accounts.set(userKey, 0);

  console.log('Account');
  page.on('dialog', (d) => d.accept());
  await page.locator('#site-nav a', { hasText: 'Account' }).click();
  await page.waitForURL(/account\.html/);
  await page.locator('#packs2 .pack').nth(2).waitFor();
  assert((await page.locator('#balance').textContent()) === '0' && (await page.locator('#who').textContent()) === 'newpm@example.com', 'account shows the email and balance');
  const packText = await page.locator('#packs2 .pack').allInnerTexts();
  assert(packText.length === 3 && /Save 11%/.test(packText[1]) && /Save 22%/.test(packText[2]), 'three packs with savings');
  assert(await page.locator('#txEmpty').isVisible(), 'no transactions yet');
  if (shots) await page.screenshot({ path: shots + '/account-empty.png', fullPage: true });
  await page.locator('#autoBox').check();
  await page.locator('#packs2 .pack').nth(1).click();
  await page.waitForURL(/checkout\.stripe\.test/);
  const co = mock.state.stripe.at(-1);
  assert(co.params.success_url === 'http://SITE/account.html?paid=1' && co.params['metadata[auto_pack]'] === 'pack50' && co.params.customer_creation === 'always', 'buying goes to Stripe Checkout, returning to the account page, saving the card for auto top-up');
  const userId = co.params['metadata[user_id]'];
  const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: co.id, customer: 'cus_web', payment_status: 'paid', amount_total: 3400, metadata: { user_id: userId, credits: '50', auto_pack: 'pack50' } } } });
  assert((await fetch(site + '/api/stripe/webhook', { method: 'POST', body: event, headers: { 'Stripe-Signature': stripeSign(event, 'whsec_test') } })).status === 200, 'payment notification accepted');
  await page.goto(site + '/account.html?paid=1');
  await page.locator('#paid').waitFor();
  await page.locator('#balance', { hasText: '50' }).waitFor();
  await page.locator('#tx tbody tr').first().waitFor();
  assert(new URL(page.url()).search === '' && /50 credits\s+\$34\s/.test(await page.locator('#tx tbody tr').first().innerText()), 'back on the account page: thank-you note, 50 credits, transaction listed');
  assert(await page.locator('#autoOn').isVisible() && (await page.locator('#autoRow').isHidden()) && /50 credits for \$34/.test(await page.locator('#autoWhat').textContent()), 'auto top-up shown as on');
  if (shots) await page.screenshot({ path: shots + '/account-paid.png', fullPage: true });
  const [receipt] = await Promise.all([ctx.waitForEvent('page'), page.locator('#tx button', { hasText: 'Receipt' }).first().click()]);
  await receipt.waitForURL(/pay\.stripe\.test\/receipts\/cs_test_/);
  await receipt.close();
  assert(true, 'Receipt opens the Stripe receipt');
  await page.locator('#portal').click();
  await page.waitForURL(/billing\.stripe\.test\/p\/session\/cus_web/);
  assert(mock.state.portals.at(-1).return_url === 'http://SITE/account.html', 'Manage payment methods opens the Stripe portal for this customer, returning to the account page');
  await page.goto(site + '/account.html');
  await page.locator('#autoOff').click();
  await page.locator('#autoRow').waitFor();
  assert(mock.state.auto.get(userId).pack === null, 'auto top-up can be turned off');

  console.log('Sign out and phone layout');
  await page.locator('#signOut').click();
  await page.waitForURL(/app\.html/);
  await page.locator('#siEmail').waitFor();
  assert(await page.locator('#studio').isHidden(), 'sign out returns to the sign-in form');
  await page.goto(site + '/account.html');
  assert(await page.locator('#siEmail').isVisible() && (await page.locator('#account').isHidden()), 'account page asks signed-out visitors to sign in');
  console.log('Promo codes');
  mock.state.promos.set('WELCOME10', { credits: 10, users: new Set() });
  mock.state.promos.set('EXTRA5', { credits: 5, users: new Set() });
  await page.goto(site + '/app.html?code=welcome10');
  await page.locator('.promo-note', { hasText: 'WELCOME10' }).waitFor();
  assert(!page.url().includes('code='), 'a ?code= link holds the code (and tidies the address) until sign-in');
  await page.locator('#siEmail').fill('tester@example.com');
  await page.locator('#emailForm button').click();
  await page.locator('#siCode').fill('123456');
  await page.locator('#codeForm button').click();
  await page.locator('#promoMsg.ok', { hasText: '10 credits added' }).waitFor();
  await page.locator('#credits', { hasText: '12 credits' }).waitFor();
  assert(true, 'signing up through the link applies it: 2 free + 10 promo credits');
  if (shots) await page.screenshot({ path: shots + '/promo-link.png' });
  await page.goto(site + '/account.html');
  await page.locator('#promoCode').fill('nope');
  await page.locator('#promoForm button').click();
  await page.locator('#promoResult.bad', { hasText: "isn't valid" }).waitFor();
  await page.locator('#promoCode').fill('extra5');
  await page.locator('#promoForm button').click();
  await page.locator('#promoResult.ok', { hasText: '5 credits added' }).waitFor();
  await page.locator('#balance', { hasText: '17' }).waitFor();
  await page.locator('#tx tbody tr').nth(1).waitFor();
  const promoRows = await page.locator('#tx tbody tr').allInnerTexts();
  assert(/promo code EXTRA5\)\s+Free/.test(promoRows[0]) && /promo code WELCOME10/.test(promoRows[1]) && (await page.locator('#tx button').count()) === 0, 'Account page: bad code refused, good code adds credits; both listed as Free with no receipt');
  if (shots) await page.screenshot({ path: shots + '/promo-account.png', fullPage: true });
  await page.locator('#promoCode').fill('EXTRA5');
  await page.locator('#promoForm button').click();
  await page.locator('#promoResult.bad', { hasText: 'already used' }).waitFor();
  assert(true, 'the same code cannot be used twice');

  const phone = await browser.newContext({ viewport: { width: 390, height: 800 } });
  for (const p of ['/', '/app.html', '/account.html']) {
    const pg = await phone.newPage();
    watch(pg);
    await pg.goto(site + p);
    await pg.waitForTimeout(200);
    assert(!(await pg.evaluate(() => document.documentElement.scrollWidth > innerWidth)), `no sideways scrolling on a phone: ${p}`);
  }
  assert(errors.length === 0, 'no script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  console.log('\nSITE PASSED');
} finally {
  await browser.close();
  app.close();
  mock.close();
}
