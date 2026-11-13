// End-to-end check of both flows against a mock AppFolio page and a mock
// image API. Run: node test/e2e.js   (needs Playwright + Chromium)
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ext = path.resolve(__dirname, '..');
const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f));
const calls = [];
let failNext = 0;

const api = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('latin1');
    const field = (name) => (new RegExp(`name="${name}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`).exec(body) || [])[1];
    const call = { auth: req.headers.authorization, prompt: field('prompt'), size: field('size'), fidelity: field('input_fidelity'), model: field('model'), hasImage: /name="image"; filename=/.test(body) };
    calls.push(call);
    if (call.fidelity) {
      // Like models that reject this parameter: the extension should retry without it.
      return res.writeHead(400, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: "Unknown parameter: 'input_fidelity'.", param: 'input_fidelity' } }));
    }
    if (failNext-- > 0) return res.writeHead(500, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'Mock server exploded' } }));
    setTimeout(() => res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ b64_json: fx('staged.jpg').toString('base64') }] })), 600);
  });
});

const assert = (cond, msg) => {
  if (!cond) throw new Error('ASSERT: ' + msg);
  console.log('  ok  ' + msg);
};

(async () => {
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${api.address().port}/v1`;
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'saf-')), {
    channel: 'chromium',
    viewport: { width: 1200, height: 850 },
    permissions: ['clipboard-read', 'clipboard-write'],
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  try {
    await ctx.route('https://demo.appfolio.com/**', (route) => {
      const p = new URL(route.request().url()).pathname;
      if (/\.(jpg|png)$/.test(p)) return route.fulfill({ contentType: 'image/jpeg', body: fx(p.startsWith('/images/up') ? 'staged.jpg' : 'empty.jpg') });
      route.fulfill({ contentType: 'text/html', body: fx('property.html') });
    });
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
    await sw.evaluate((base) => chrome.storage.local.set({ apiKey: 'sk-test', apiBase: base, backupOriginal: false, stageUploads: false }), base);

    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
    page.on('console', (m) => m.type() === 'error' && console.log('console.error:', m.text()));
    await page.goto('https://demo.appfolio.com/properties/5/units/77');
    const chip = page.locator('unit-stager .chip');
    await chip.first().waitFor();

    console.log('Existing photo flow');
    assert((await chip.count()) === 2, 'a Stage chip on each of the 2 photos (logo and default-photo banner ignored)');
    await chip.first().click();
    await page.locator('unit-stager .pop textarea').fill('grey sectional sofa');
    await page.screenshot({ path: path.join(__dirname, 'out-popover.png') });
    await page.locator('unit-stager .pop button.primary').click();
    await page.locator('unit-stager .chip.ready').waitFor({ timeout: 30000 });
    assert(calls.length === 2 && calls[0].fidelity === 'high' && !calls[1].fidelity, 'retried without the rejected input_fidelity parameter');
    assert(/grey sectional sofa/.test(calls[1].prompt) && /Do not repaint/.test(calls[1].prompt), 'prompt = default staging prompt + specific instructions');
    assert(calls[1].auth === 'Bearer sk-test' && calls[1].hasImage && calls[1].size === '1536x1024', 'request carries key, image and aspect-matched size');
    await page.locator('unit-stager .chip.ready').click();
    await page.locator('unit-stager .modal canvas.thumb').nth(1).waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(__dirname, 'out-review.png') });
    await page.locator('unit-stager .modal button', { hasText: 'Replace original' }).click();
    await page.waitForFunction(() => window.__deleted.length === 1, null, { timeout: 30000 });
    const st = await page.evaluate(() => ({ uploads: window.__uploads, deleted: window.__deleted, ids: [...document.querySelectorAll('.js-attached-photo')].map((li) => li.dataset.photoId), def: window.__default, prop: !!window.__propertyDeleted, modals: document.querySelectorAll('.modal').length }));
    assert(st.uploads.length === 1 && st.uploads[0].name === 'living-staged.jpg' && st.uploads[0].type === 'image/jpeg', 'staged photo uploaded through the Photos uploader as living-staged.jpg');
    assert(st.deleted[0] === '/photos/1' && st.ids.join() === 'photo_2,photo_101' && st.modals === 0, "original deleted via AppFolio's own confirm dialog, after the new photo appeared");
    assert(st.def === 'photo_101', 'replaced photo was the default, so the staged one was made default first');
    assert(!st.prop, '"Delete Unit" button was never touched');

    await page.locator('unit-stager .toast.ok', { hasText: 'Photo replaced' }).waitFor();
    assert((await page.locator('unit-stager .toast', { hasText: 'Staged photo is ready' }).count()) === 0, 'stale "ready" toast cleared once reviewed');

    console.log('Failure handling');
    failNext = 1;
    await chip.first().click();
    await page.locator('unit-stager .pop button.primary').click();
    await page.locator('unit-stager .chip.failed').waitFor({ timeout: 30000 });
    assert(await page.locator('unit-stager .toast.error', { hasText: 'Mock server exploded' }).count(), 'API error surfaced to the user');
    assert((await page.evaluate(() => window.__deleted.length)) === 1, 'nothing deleted on failure');

    console.log('New upload flow');
    await page.locator('#file').setInputFiles([path.join(__dirname, 'fixtures', 'empty.jpg')]);
    await page.waitForTimeout(800);
    await page.locator('unit-stager .dock .switch input').check();
    await page.waitForTimeout(300);
    await page.locator('#attachment-file').setInputFiles([path.join(__dirname, 'fixtures', 'empty.jpg')]);
    await page.waitForTimeout(500);
    assert((await page.evaluate(() => window.__attachments.length)) === 1 && (await page.locator('unit-stager .overlay').count()) === 0, 'Attachments uploader is left alone even with staging on');
    await page.locator('unit-stager .dock .switch input').uncheck();
    await page.waitForTimeout(300);
    assert((await page.evaluate(() => window.__uploads.length)) === 2, 'toggle off: upload passes straight through');
    await page.locator('unit-stager .dock .switch input').check();
    await page.waitForTimeout(300);
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'empty.jpg'), path.join(os.tmpdir(), 'kitchen.jpg'));
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'empty.jpg'), path.join(os.tmpdir(), 'bedroom.jpg'));
    await page.locator('#file').setInputFiles([path.join(os.tmpdir(), 'kitchen.jpg'), path.join(os.tmpdir(), 'bedroom.jpg')]);
    await page.locator('unit-stager .modal .tile').nth(1).waitFor();
    assert((await page.evaluate(() => window.__uploads.length)) === 2, 'toggle on: upload held back while choosing');
    await page.locator('unit-stager .modal .tile input[type=checkbox]').nth(1).check();
    await page.locator('unit-stager .modal .tile select').nth(1).selectOption('bedroom');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(__dirname, 'out-picker.png') });
    const before = calls.length;
    await page.locator('unit-stager .modal button.primary').click();
    await page.locator('unit-stager .modal .seg').waitFor({ timeout: 30000 });
    assert(/listing photo of a bedroom/.test(calls[calls.length - 1].prompt) && calls.length - before === 1, 'only the ticked photo was staged, with its room type (rejected parameter remembered)');
    assert((await page.evaluate(() => window.__uploads.length)) === 2, 'still nothing uploaded during review');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(__dirname, 'out-batch-review.png') });
    await page.locator('unit-stager .modal button.primary').click();
    await page.waitForFunction(() => window.__uploads.length === 4, null, { timeout: 10000 });
    const names = await page.evaluate(() => window.__uploads.slice(2).map((u) => u.name));
    assert(names.join() === 'kitchen.jpg,bedroom-staged.jpg', 'final set delivered in order: ' + names.join(', '));
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(__dirname, 'out-final.png') });

    console.log('Diagnostics');
    await page.locator('unit-stager .dock button', { hasText: 'Copy page diagnostics' }).click();
    const box = page.locator('unit-stager .modal textarea');
    const copied = page.locator('unit-stager .toast', { hasText: 'diagnostics copied' });
    await box.or(copied).first().waitFor();
    const diag = JSON.parse((await box.count()) ? await box.inputValue() : await page.evaluate(() => navigator.clipboard.readText()));
    assert(diag.photoCount >= 2 && /delete/i.test(diag.photos[0].deleteFound) && diag.fileInputs.length === 2 && diag.appfolioPhotosCard && diag.page === '/properties/N/units/N', 'diagnostics describe photos, delete control and file input');

    const opts = await ctx.newPage();
    await opts.goto(`chrome-extension://${new URL(sw.url()).host}/src/options.html`);
    await opts.locator('#model').waitFor();
    assert((await opts.locator('#model').inputValue()) === 'gpt-image-2' && (await opts.locator('#stageUploads').isChecked()), 'options page loads and reflects the dock toggle');
    await opts.screenshot({ path: path.join(__dirname, 'out-options.png'), fullPage: true });
    console.log('\nALL PASSED');
  } finally {
    await ctx.close();
    api.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
