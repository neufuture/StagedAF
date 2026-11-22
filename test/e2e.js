// End-to-end check in a real browser: the extension on a mock AppFolio page,
// talking to the real server code, which talks to mock Supabase / Stripe /
// image API. Run: node test/e2e.js   (needs Playwright + Chromium)
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ext = process.env.EXT_DIR || path.resolve(__dirname, '..'); // EXT_DIR: test an unpacked store package instead
const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f));
const assert = (cond, msg) => {
  if (!cond) throw new Error('ASSERT: ' + msg);
  console.log('  ok  ' + msg);
};

(async () => {
  const { startMock, stripeSign } = await import('../server/test/mock-upstream.js');
  const { serve } = await import('../server/test/serve.js');
  const mock = await startMock({ imageBase64: fx('staged.jpg').toString('base64') });
  const calls = mock.state.image;
  const app = await serve({
    SUPABASE_URL: mock.url, SUPABASE_PUBLISHABLE_KEY: 'pub-key', SUPABASE_SECRET_KEY: 'secret-key',
    OPENAI_API_KEY: 'sk-server', OPENAI_BASE: mock.url + '/v1', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_BASE: mock.url,
    STRIPE_WEBHOOK_SECRET: 'whsec_test', SITE_URL: 'https://unitstager.com', FREE_CREDITS: '2',
  });
  const post = (path, body) => fetch(app.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  // A signed-in account with plenty of credits for the AppFolio flows.
  await post('/api/auth/start', { email: 'tester@example.com' });
  const signedIn = await post('/api/auth/verify', { email: 'tester@example.com', code: '123456' });
  mock.state.accounts.set(signedIn.user.id, 50);
  const session = { access_token: signedIn.access_token, refresh_token: signedIn.refresh_token, expires_at: signedIn.expires_at, email: 'tester@example.com' };

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
    await sw.evaluate((v) => chrome.storage.local.set(v), { serverUrl: app.url, session, credits: 50, backupOriginal: false, stageUploads: false });

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
    assert(/grey sectional sofa/.test(calls[1].prompt) && /Do not repaint/.test(calls[1].prompt), 'prompt = server staging prompt + specific instructions');
    assert(calls[1].auth === 'Bearer sk-server' && calls[1].hasImage && calls[1].size === '1536x1024', "staged through the server with the server's key, image and aspect-matched size");
    await page.locator('unit-stager .dock', { hasText: '49 credits left' }).waitFor();
    assert(true, 'one credit used; balance shown in the panel');
    assert([...mock.state.stagings.values()].some((j) => j.name === 'living.jpg' && j.status === 'done'), 'extension stagings run in the background and are kept like the website\'s');
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
    mock.state.declineImage = 1; // not retried, unlike a passing server error
    await chip.first().click();
    await page.locator('unit-stager .pop button.primary').click();
    await page.locator('unit-stager .chip.failed').waitFor({ timeout: 30000 });
    assert(await page.locator('unit-stager .toast.error', { hasText: 'credit was returned' }).count(), 'a declined photo is reported to the user');
    await page.locator('unit-stager .dock', { hasText: '49 credits left' }).waitFor();
    assert(true, 'failed staging cost no credit');
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

    // ---- Accounts: sign-in, running out, buying, auto top-up ----
    console.log('Account (sign-in, credits, purchase, auto top-up)');
    {
      await sw.evaluate(() => chrome.storage.local.set({ session: null, credits: null, autoPack: null, stageUploads: false }));
      await page.locator('unit-stager .dock .warn', { hasText: 'Sign in to UnitStager' }).waitFor();
      assert(true, 'signed out: the panel asks the user to sign in');

      const opts = await ctx.newPage();
      await opts.goto(`chrome-extension://${new URL(sw.url()).host}/src/options.html`);
      await opts.locator('#email').fill('pm@example.com');
      await opts.locator('#sendCode').click();
      await opts.locator('#code').waitFor();
      assert(mock.state.emails.at(-1) === 'pm@example.com', 'sign-in code emailed');
      await opts.locator('#code').fill('000000');
      await opts.locator('#verify').click();
      await opts.locator('#authResult.bad', { hasText: 'wrong or has expired' }).waitFor();
      assert(true, 'wrong code is rejected with a clear message');
      await opts.locator('#code').fill('123456');
      await opts.locator('#verify').click();
      await opts.locator('#signedIn').waitFor();
      await opts.locator('#packs button').first().waitFor();
      assert((await opts.locator('#credits').textContent()) === '2' && (await opts.locator('#who').textContent()) === 'pm@example.com', 'signed in with 2 free credits');
      mock.state.promos.set('TESTER3', { credits: 3, users: new Set() });
      await opts.locator('#promoCode').fill('tester3');
      await opts.locator('#promoApply').click();
      await opts.locator('#authResult.ok', { hasText: '3 credits added' }).waitFor();
      await opts.locator('#credits', { hasText: '5' }).waitFor();
      await opts.locator('#history tr', { hasText: 'promo code TESTER3' }).waitFor();
      assert(true, 'a promo code can be applied in the extension settings');
      mock.state.accounts.set([...mock.state.users.values()].find((u) => u.email === 'pm@example.com').id, 2);
      await opts.locator('#refresh').click();
      await opts.locator('#credits', { hasText: '2' }).waitFor();
      await page.bringToFront();
      await page.locator('unit-stager .dock', { hasText: '2 credits left' }).waitFor();
      const stageOne = async (n) => {
        await page.locator('unit-stager .chip:not(.ready):not(.failed):not(.busy)').nth(n).click();
        await page.locator('unit-stager .pop button.primary').click();
      };
      await stageOne(1);
      await page.locator('unit-stager .chip.ready').waitFor({ timeout: 30000 });
      const sent = mock.state.image.at(-1);
      assert(sent.auth === 'Bearer sk-server', 'new account can stage');
      await page.locator('unit-stager .dock', { hasText: '1 credit left' }).waitFor();
      assert(true, 'balance in the panel dropped to 1');
      await stageOne(1);
      await page.locator('unit-stager .chip.ready').nth(1).waitFor({ timeout: 30000 });
      await page.locator('unit-stager .dock', { hasText: "You're out of credits" }).waitFor();
      const imageCalls = mock.state.image.length;
      await stageOne(1);
      await page.locator('unit-stager .toast.error', { hasText: 'out of credits' }).waitFor({ timeout: 30000 });
      assert((await page.locator('unit-stager .toast.error button', { hasText: 'Buy credits' }).count()) === 1 && mock.state.image.length === imageCalls, 'out of credits: blocked before any image call, with a Buy credits prompt');
      await page.screenshot({ path: path.join(__dirname, 'out-credits.png') });

      await opts.bringToFront();
      await opts.locator('#refresh').click();
      await opts.locator('#packs .pack').nth(2).waitFor();
      const labels = await opts.locator('#packs .pack').allInnerTexts();
      assert(labels.length === 3 && /50 credits – \$34/.test(labels[1]) && /Save 11%/.test(labels[1]) && /Save 22%/.test(labels[2]) && !/Save/.test(labels[0]), 'three packs, with savings shown on the larger ones');
      await ctx.route('https://checkout.stripe.test/**', (route) => route.fulfill({ contentType: 'text/html', body: 'mock checkout' }));
      await opts.locator('#autoBox').check();
      await opts.screenshot({ path: path.join(__dirname, 'out-options.png'), fullPage: true });
      const [checkout] = await Promise.all([ctx.waitForEvent('page'), opts.locator('#packs .pack').nth(1).click()]);
      await checkout.waitForURL(/checkout\.stripe\.test\/pay\/cs_test_1/);
      const bought = mock.state.stripe[0];
      assert(bought.params.customer_email === 'pm@example.com' && bought.params['metadata[credits]'] === '50' && bought.params['payment_intent_data[setup_future_usage]'] === 'off_session', 'Buy opens Stripe Checkout for the 50 pack, saving the card for auto top-up');
      await checkout.close();
      const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: bought.id, customer: 'cus_e2e', payment_status: 'paid', metadata: { user_id: bought.params['metadata[user_id]'], credits: '50', auto_pack: 'pack50' } } } });
      const hook = await fetch(app.url + '/api/stripe/webhook', { method: 'POST', body: event, headers: { 'Stripe-Signature': stripeSign(event, 'whsec_test') } });
      assert(hook.status === 200, 'payment notification accepted');
      await opts.locator('#refresh').click();
      await opts.locator('#credits', { hasText: '50' }).waitFor();
      await opts.locator('#autoOn', { hasText: 'buys 50 credits for $34' }).waitFor();
      assert(await opts.locator('#autoRow').isHidden(), 'credits arrive and settings show auto top-up is on');
      await page.bringToFront();
      await page.locator('unit-stager .dock', { hasText: 'Auto top-up on' }).waitFor();
      assert(await page.locator('unit-stager .dock', { hasText: '50 credits left' }).count(), 'the panel shows the new balance and that auto top-up is on');

      // Run the balance down to the threshold: the saved card is charged once.
      mock.state.accounts.set(bought.params['metadata[user_id]'], 4);
      await page.locator('unit-stager .chip.failed').first().click();
      await page.locator('unit-stager .pop button.primary').click();
      await page.waitForFunction(() => true);
      for (let i = 0; i < 100 && mock.state.charges.length === 0; i++) await page.waitForTimeout(200);
      await app.idle();
      assert(mock.state.charges.length === 1 && mock.state.charges[0].params.amount === '3400' && mock.state.charges[0].params.customer === 'cus_e2e', 'at 3 credits the saved card is charged for the same pack, once');
      assert(mock.state.accounts.get(bought.params['metadata[user_id]']) === 53, 'auto top-up credits added');

      await opts.bringToFront();
      await opts.locator('#refresh').click();
      await opts.locator('#history tr').nth(2).waitFor();
      const rows = await opts.locator('#history tr').allInnerTexts();
      assert(rows.length === 3 && /promo code TESTER3\)\s+Free/.test(rows[2]) && /50 credits \(auto top-up\)\s+\$34\.00/.test(rows[0]) && /50 credits\s/.test(rows[1]), 'purchase history lists the purchase and the auto top-up');
      await ctx.route('https://pay.stripe.test/**', (route) => route.fulfill({ contentType: 'text/html', body: 'mock receipt' }));
      const [receiptTab] = await Promise.all([ctx.waitForEvent('page'), opts.locator('#history button').first().click()]);
      await receiptTab.waitForURL(/pay\.stripe\.test\/receipts\/pi_test_1/);
      assert(true, 'Receipt opens the Stripe receipt for that payment');
      await receiptTab.close();
      await opts.screenshot({ path: path.join(__dirname, 'out-history.png'), fullPage: false });
      await opts.locator('#autoOff').click();
      await opts.locator('#autoRow').waitFor();
      assert(mock.state.auto.get(bought.params['metadata[user_id]']).pack === null, 'auto top-up can be turned off from settings');

      await opts.bringToFront();
      await opts.locator('#signOut').click();
      await opts.locator('#signedOut').waitFor();
      assert(await sw.evaluate(async () => (await chrome.storage.local.get('session')).session === null), 'sign out clears the session');
    }
    console.log('\nALL PASSED');
  } finally {
    await ctx.close();
    app.close();
    mock.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
