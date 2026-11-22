// API tests: the real Worker code against mock Supabase / Stripe / image API.
//   npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMock, stripeSign } from './mock-upstream.js';
import { serve } from './serve.js';
import { base } from '../src/supabase.js';

let mock, app, state;
const WH = 'whsec_test';

before(async () => {
  mock = await startMock();
  state = mock.state;
  app = await serve({
    SUPABASE_URL: mock.url,
    SUPABASE_PUBLISHABLE_KEY: 'pub-key',
    SUPABASE_SECRET_KEY: 'secret-key',
    OPENAI_API_KEY: 'sk-server',
    OPENAI_BASE: mock.url + '/v1',
    OPENAI_MODEL: 'gpt-image-2',
    OPENAI_QUALITY: 'high',
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_BASE: mock.url,
    STRIPE_WEBHOOK_SECRET: WH,
    SITE_URL: 'https://unitstager.com',
    FREE_CREDITS: '2',
  });
});
after(() => {
  app.close();
  mock.close();
});

const call = async (path, { method = 'GET', body, token, headers = {}, raw } = {}) => {
  const res = await fetch(app.url + path, {
    method,
    headers: { ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  let data = null;
  try {
    data = await res.clone().json();
  } catch {}
  return { status: res.status, data, res };
};

const signIn = async (email) => {
  await call('/api/auth/start', { method: 'POST', body: { email } });
  return (await call('/api/auth/verify', { method: 'POST', body: { email, code: '123456' } })).data;
};

const photo = (extra = {}) => {
  const form = new FormData();
  form.append('image', new Blob([new Uint8Array(2000)], { type: 'image/jpeg' }), 'photo.jpg');
  for (const [k, v] of Object.entries({ room: 'bedroom', style: 'coastal', custom: 'blue rug', width: '1200', height: '800', ...extra })) form.append(k, v);
  return form;
};
const stageCall = (token, extra) => call('/api/stage', { method: 'POST', token, raw: photo(extra) });

test('sign-in: emails a code, verifies it, grants free credits once', async () => {
  const bad = await call('/api/auth/start', { method: 'POST', body: { email: 'not-an-email' } });
  assert.equal(bad.status, 400);
  const start = await call('/api/auth/start', { method: 'POST', body: { email: ' Pat@Example.com ' } });
  assert.equal(start.status, 200);
  assert.deepEqual(state.emails, ['pat@example.com']);

  const wrong = await call('/api/auth/verify', { method: 'POST', body: { email: 'pat@example.com', code: '000000' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.code, 'bad-code');

  const ok = await call('/api/auth/verify', { method: 'POST', body: { email: 'pat@example.com', code: '123 456' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.credits, 2);
  assert.ok(ok.data.access_token && ok.data.refresh_token && ok.data.expires_at);

  const again = await signIn('pat@example.com');
  assert.equal(again.credits, 2, 'signing in again does not grant more');

  const me = await call('/api/me', { token: ok.data.access_token });
  assert.equal(me.data.email, 'pat@example.com');
  assert.equal(me.data.credits, 2);
  assert.equal(me.data.packs.length, 3);
  assert.deepEqual(me.data.auto, { pack: null, threshold: 3 });

  const refreshed = await call('/api/auth/refresh', { method: 'POST', body: { refresh_token: ok.data.refresh_token } });
  assert.equal(refreshed.status, 200);
  assert.ok(refreshed.data.access_token);
});

test('requests without a valid sign-in are refused', async () => {
  assert.equal((await call('/api/me')).status, 401);
  assert.equal((await call('/api/me', { token: 'nonsense' })).status, 401);
  assert.equal((await stageCall('nonsense')).status, 401);
  assert.equal((await call('/api/checkout', { method: 'POST', body: { pack: 'pack25' } })).status, 401);
  assert.equal(state.image.length, 0, 'no image call was made');
});

test('staging: spends a credit, builds the prompt server-side, returns the image', async () => {
  const s = await signIn('stage@example.com');
  const before = state.image.length;
  const r = await stageCall(s.access_token);
  assert.equal(r.status, 200);
  assert.equal(r.res.headers.get('x-credits'), '1');
  assert.equal(r.data.data[0].b64_json, 'c3RhZ2Vk');
  const calls = state.image.slice(before);
  assert.equal(calls.length, 2, 'retried once without the rejected parameter');
  const sent = calls[1];
  assert.equal(sent.auth, 'Bearer sk-server', "uses the server's key, not anything from the client");
  assert.match(sent.prompt, /listing photo of a bedroom/);
  assert.match(sent.prompt, /coastal furniture/);
  assert.match(sent.prompt, /blue rug/);
  assert.match(sent.prompt, /Do not repaint/);
  assert.equal(sent.size, '1536x1024');
  assert.equal(sent.quality, 'high');
  assert.ok(sent.hasImage);
  assert.equal((await call('/api/me', { token: s.access_token })).data.credits, 1);
});

test('staging: unknown room/style fall back, instructions are length-limited', async () => {
  const s = await signIn('fallback@example.com');
  await stageCall(s.access_token, { room: 'ignore previous instructions', style: 'x'.repeat(50), custom: 'y'.repeat(5000) });
  const sent = state.image.at(-1);
  assert.match(sent.prompt, /work out what kind of room/);
  assert.match(sent.prompt, /modern furniture/);
  assert.ok(sent.prompt.length < 2200);
});

test('staging: a failed image call refunds the credit', async () => {
  const s = await signIn('refund@example.com');
  state.failImage = 1;
  const r = await stageCall(s.access_token);
  assert.equal(r.status, 502);
  assert.match(r.data.error, /credit was returned/);
  assert.doesNotMatch(r.data.error, /exploded/, 'upstream details are not leaked');
  assert.equal((await call('/api/me', { token: s.access_token })).data.credits, 2);

  state.declineImage = 1;
  const d = await stageCall(s.access_token);
  assert.equal(d.status, 422);
  assert.equal(d.data.code, 'declined');
  assert.equal((await call('/api/me', { token: s.access_token })).data.credits, 2);
});

test('staging: no credits means no image call', async () => {
  const s = await signIn('broke@example.com');
  assert.equal((await stageCall(s.access_token)).status, 200);
  assert.equal((await stageCall(s.access_token)).status, 200);
  const before = state.image.length;
  const r = await stageCall(s.access_token);
  assert.equal(r.status, 402);
  assert.equal(r.data.code, 'no-credits');
  assert.equal(state.image.length, before);
});

test('staging: rejects things that are not photos', async () => {
  const s = await signIn('files@example.com');
  const form = new FormData();
  form.append('image', new Blob(['hello'], { type: 'text/plain' }), 'x.txt');
  const r = await call('/api/stage', { method: 'POST', token: s.access_token, raw: form });
  assert.equal(r.status, 415);
  assert.equal((await call('/api/me', { token: s.access_token })).data.credits, 2, 'no credit taken');
});

test('buying credits: checkout session, then the webhook adds credits exactly once', async () => {
  const s = await signIn('buyer@example.com');
  assert.equal((await call('/api/checkout', { method: 'POST', token: s.access_token, body: { pack: 'nope' } })).status, 400);
  const co = await call('/api/checkout', { method: 'POST', token: s.access_token, body: { pack: 'pack25' } });
  assert.equal(co.status, 200);
  assert.match(co.data.url, /^https:\/\/checkout\.stripe\.test\//);
  const created = state.stripe.at(-1);
  assert.equal(created.auth, 'Bearer sk_test_x');
  assert.equal(created.params['metadata[credits]'], '25');
  assert.equal(created.params['metadata[user_id]'], s.user.id);
  assert.equal(created.params['line_items[0][price_data][unit_amount]'], '1900');
  assert.equal(created.params.success_url, 'https://unitstager.com/thanks.html');
  assert.equal(created.params.customer_email, 'buyer@example.com');
  assert.equal(created.params.customer_creation, 'always', 'every purchase gets a Stripe customer');

  const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: created.id, payment_status: 'paid', metadata: { user_id: s.user.id, credits: '25' } } } });
  const post = (payload, sig) => call('/api/stripe/webhook', { method: 'POST', raw: payload, headers: { 'Stripe-Signature': sig } });

  assert.equal((await post(event, 't=1,v1=deadbeef')).status, 400, 'forged signature refused');
  assert.equal((await post(event, stripeSign(event, 'wrong-secret'))).status, 400, 'wrong secret refused');
  assert.equal((await post(event, stripeSign(event, WH, Math.floor(Date.now() / 1000) - 3600))).status, 400, 'old replay refused');
  assert.equal((await post(event.replace('"25"', '"9999"'), stripeSign(event, WH))).status, 400, 'tampered payload refused');
  assert.equal((await call('/api/me', { token: s.access_token })).data.credits, 2, 'nothing credited by forged calls');

  assert.equal((await post(event, stripeSign(event, WH))).status, 200);
  assert.equal((await call('/api/me', { token: s.access_token })).data.credits, 27);
  assert.equal((await post(event, stripeSign(event, WH))).status, 200, 'Stripe retry accepted');
  assert.equal((await call('/api/me', { token: s.access_token })).data.credits, 27, '…but not credited twice');

  const unpaid = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_unpaid', payment_status: 'unpaid', metadata: { user_id: s.user.id, credits: '25' } } } });
  assert.equal((await post(unpaid, stripeSign(unpaid, WH))).status, 200);
  assert.equal((await call('/api/me', { token: s.access_token })).data.credits, 27, 'unpaid session credits nothing');
});

test('public bits: packs list, CORS preflight, website, unknown routes', async () => {
  const p = await call('/api/packs');
  assert.equal(p.data.free_credits, 2);
  assert.deepEqual(p.data.packs.map((x) => [x.id, x.credits, x.amount, x.each, x.save]), [['pack25', 25, 1900, 76, 0], ['pack50', 50, 3400, 68, 11], ['pack100', 100, 5900, 59, 22]]);
  const pre = await fetch(app.url + '/api/stage', { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.equal((await call('/api/nope')).status, 404);
  const home = await fetch(app.url + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /UnitStager/);
});

test('SUPABASE_URL is accepted in the forms people paste', () => {
  const want = 'https://abcdefgh.supabase.co';
  for (const v of [want, want + '/', want + '/rest/v1/', ' ' + want + '/auth/v1 ', 'abcdefgh.supabase.co', 'https://supabase.com/dashboard/project/abcdefgh/settings/api'])
    assert.equal(base({ SUPABASE_URL: v }), want, v);
  assert.throws(() => base({ SUPABASE_URL: '' }), /SUPABASE_URL/);
});

test('auto top-up: opt in at checkout, charge once when low, credit, and stop on decline', async () => {
  const s = await signIn('auto@example.com'); // 2 free credits
  const post = (payload) => call('/api/stripe/webhook', { method: 'POST', raw: payload, headers: { 'Stripe-Signature': stripeSign(payload, WH) } });
  const me = async () => (await call('/api/me', { token: s.access_token })).data;

  // An ordinary purchase does not save the card or switch anything on.
  await call('/api/checkout', { method: 'POST', token: s.access_token, body: { pack: 'pack25' } });
  assert.equal(state.stripe.at(-1).params['payment_intent_data[setup_future_usage]'], undefined);

  // Buying with the box ticked asks Stripe to save the card...
  const co = await call('/api/checkout', { method: 'POST', token: s.access_token, body: { pack: 'pack50', auto: true } });
  assert.equal(co.status, 200);
  const created = state.stripe.at(-1);
  assert.equal(created.params['payment_intent_data[setup_future_usage]'], 'off_session');
  assert.equal(created.params.customer_creation, 'always');
  assert.equal(created.params['metadata[auto_pack]'], 'pack50');
  assert.equal((await me()).auto.pack, null, 'not on until the payment actually goes through');

  // ...and the paid notification switches auto top-up on.
  const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: created.id, customer: 'cus_123', payment_status: 'paid', metadata: { user_id: s.user.id, credits: '50', auto_pack: 'pack50' } } } });
  assert.equal((await post(event)).status, 200);
  assert.equal((await me()).credits, 52);
  assert.equal((await me()).auto.pack, 'pack50');
  assert.equal(JSON.stringify(await me()).includes('cus_123'), false, 'the Stripe customer id is never sent to the browser');

  // Well above the threshold: staging does not charge anything.
  await stageCall(s.access_token);
  await app.idle();
  assert.equal(state.charges.length, 0);

  // Drop to 5 credits; two stagings at once take it to 3: exactly one charge.
  state.accounts.set(s.user.id, 5);
  await Promise.all([stageCall(s.access_token), stageCall(s.access_token)]);
  await app.idle();
  assert.equal(state.charges.length, 1, 'charged exactly once');
  const charge = state.charges[0];
  assert.equal(charge.params.amount, '3400');
  assert.equal(charge.params.customer, 'cus_123');
  assert.equal(charge.params.off_session, 'true');
  assert.equal(charge.params.receipt_email, 'auto@example.com');
  assert.ok(charge.key, 'sent with an idempotency key');
  assert.equal((await me()).credits, 53, '3 left + 50 bought');

  // The next checkout reuses the saved customer.
  await call('/api/checkout', { method: 'POST', token: s.access_token, body: { pack: 'pack50', auto: true } });
  assert.equal(state.stripe.at(-1).params.customer, 'cus_123');
  assert.equal(state.stripe.at(-1).params.customer_email, undefined);

  // Low again straight away: the cool-down stops a second charge.
  state.accounts.set(s.user.id, 2);
  await stageCall(s.access_token);
  await app.idle();
  assert.equal(state.charges.length, 1, 'no second charge inside the cool-down');

  // After the cool-down, a declined card turns auto top-up off instead of retrying forever.
  state.auto.get(s.user.id).lastAt = Date.now() - 3600_000;
  state.accounts.set(s.user.id, 2);
  state.declineCharge = true;
  await stageCall(s.access_token);
  await app.idle();
  state.declineCharge = false;
  assert.equal(state.charges.length, 1);
  assert.equal((await me()).auto.pack, null, 'switched off after a decline');
  assert.equal((await me()).credits, 1, 'no credits added for a declined charge');

  // Turning it off by hand.
  state.auto.get(s.user.id).pack = 'pack50';
  assert.equal((await call('/api/auto-topup', { method: 'POST', token: s.access_token, body: { enabled: true } })).status, 400);
  const offRes = await call('/api/auto-topup', { method: 'POST', token: s.access_token, body: { enabled: false } });
  assert.equal(offRes.status, 200);
  assert.equal((await me()).auto.pack, null);
  assert.equal((await call('/api/auto-topup', { method: 'POST', body: { enabled: false } })).status, 401);
});

test('purchase history: lists own purchases with amounts, and links to Stripe receipts', async () => {
  const a = await signIn('history@example.com');
  const b = await signIn('other@example.com');
  const pay = async (s, id, credits, total, extra = {}) => {
    const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id, payment_status: 'paid', amount_total: total, metadata: { user_id: s.user.id, credits: String(credits), ...extra } } } });
    return call('/api/stripe/webhook', { method: 'POST', raw: event, headers: { 'Stripe-Signature': stripeSign(event, WH) } });
  };
  assert.deepEqual((await call('/api/purchases', { token: a.access_token })).data.purchases, [], 'free sign-up credits are not a purchase');
  await pay(a, 'cs_hist_1', 25, 1900);
  await pay(b, 'cs_other_1', 100, 5900);
  await pay(a, 'cs_hist_2', 50, 3400, { auto_pack: 'pack50' });

  const list = (await call('/api/purchases', { token: a.access_token })).data.purchases;
  assert.deepEqual(list.map((p) => [p.id, p.credits, p.amount, p.auto]), [['cs_hist_2', 50, 3400, false], ['cs_hist_1', 25, 1900, false]]);
  assert.ok(!Number.isNaN(Date.parse(list[0].date)));

  const r = await call('/api/receipt', { method: 'POST', token: a.access_token, body: { id: 'cs_hist_1' } });
  assert.equal(r.data.url, 'https://pay.stripe.test/receipts/cs_hist_1');
  assert.equal((await call('/api/receipt', { method: 'POST', token: a.access_token, body: { id: 'cs_other_1' } })).status, 404, "cannot open someone else's receipt");
  assert.equal((await call('/api/receipt', { method: 'POST', token: a.access_token, body: { id: '../customers' } })).status, 404);
  assert.equal((await call('/api/purchases')).status, 401);
  assert.equal((await call('/api/receipt', { method: 'POST', body: { id: 'cs_hist_1' } })).status, 401);
});

test('website checkout returns to the account page; extension checkout to the thank-you page', async () => {
  const s = await signIn('webbuyer@example.com');
  await call('/api/checkout', { method: 'POST', token: s.access_token, body: { pack: 'pack25', from: 'web' } });
  assert.equal(state.stripe.at(-1).params.success_url, 'https://unitstager.com/account.html?paid=1');
  assert.equal(state.stripe.at(-1).params.cancel_url, 'https://unitstager.com/account.html');
  await call('/api/checkout', { method: 'POST', token: s.access_token, body: { pack: 'pack25' } });
  assert.equal(state.stripe.at(-1).params.success_url, 'https://unitstager.com/thanks.html');
});

test('a paid purchase remembers the Stripe customer, and later checkouts reuse it', async () => {
  const s = await signIn('remember@example.com');
  await call('/api/checkout', { method: 'POST', token: s.access_token, body: { pack: 'pack25' } });
  const id = state.stripe.at(-1).id;
  const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id, customer: 'cus_remember', payment_status: 'paid', amount_total: 1900, metadata: { user_id: s.user.id, credits: '25' } } } });
  assert.equal((await call('/api/stripe/webhook', { method: 'POST', raw: event, headers: { 'Stripe-Signature': stripeSign(event, WH) } })).status, 200);
  assert.equal((await call('/api/me', { token: s.access_token })).data.auto.pack, null, 'an ordinary purchase does not switch on auto top-up');
  await call('/api/checkout', { method: 'POST', token: s.access_token, body: { pack: 'pack50' } });
  assert.equal(state.stripe.at(-1).params.customer, 'cus_remember');
  assert.equal(state.stripe.at(-1).params.customer_creation, undefined);
});

test('payment settings: opens the Stripe portal, creating the customer once if needed', async () => {
  const s = await signIn('portal@example.com');
  const r1 = await call('/api/billing-portal', { method: 'POST', token: s.access_token });
  assert.equal(r1.status, 200);
  assert.equal(r1.data.url, 'https://billing.stripe.test/p/session/cus_new_1');
  assert.equal(state.customers.length, 1);
  assert.equal(state.customers[0].params.email, 'portal@example.com');
  assert.equal(state.portals.at(-1).return_url, 'https://unitstager.com/account.html');
  const r2 = await call('/api/billing-portal', { method: 'POST', token: s.access_token });
  assert.equal(r2.data.url, 'https://billing.stripe.test/p/session/cus_new_1');
  assert.equal(state.customers.length, 1, 'no second customer');
  state.portalNotConfigured = true;
  const r3 = await call('/api/billing-portal', { method: 'POST', token: s.access_token });
  state.portalNotConfigured = false;
  assert.equal(r3.status, 503);
  assert.equal(r3.data.code, 'portal-config');
  assert.equal((await call('/api/billing-portal', { method: 'POST' })).status, 401);
});

// ---- background staging (jobs) ----------------------------------------------

const jobCall = (token, extra) => call('/api/jobs', { method: 'POST', token, raw: photo({ name: 'Unit 4 living.jpg', label: '1', ...extra }) });
const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting');
};
const jobsOf = async (token) => (await call('/api/jobs', { token })).data.stagings;

test('jobs: staging finishes on the server and the result is kept for download', async () => {
  const s = await signIn('jobs@example.com'); // 2 credits
  const r = await jobCall(s.access_token);
  assert.equal(r.status, 202);
  assert.equal(r.data.credits, 1);
  assert.match(r.data.id, /^[0-9a-f-]{36}$/);
  // Nobody is waiting on the response any more: the queue worker finishes the job.
  const done = await waitFor(async () => (await jobsOf(s.access_token)).find((j) => j.id === r.data.id && j.status === 'done'));
  assert.equal(done.name, 'Unit 4 living.jpg');
  assert.equal(done.style, 'coastal');
  assert.equal(done.label, true);
  assert.ok(Date.parse(done.expires_at) - Date.parse(done.created_at) === 30 * 86400000, 'expires 30 days after it was made');
  const sent = state.image.at(-1);
  assert.match(sent.prompt, /photo of a bedroom/);
  assert.match(sent.prompt, /blue rug/);
  assert.equal(sent.auth, 'Bearer sk-server');
  const result = await call(`/api/jobs/${r.data.id}/result`, { token: s.access_token });
  assert.equal(result.status, 200);
  assert.equal(result.data.data[0].b64_json, 'c3RhZ2Vk');
  assert.equal([...app.photos.files.keys()].filter((k) => k.includes(r.data.id)).join(), `stagings/${s.user.id}/${r.data.id}/staged.json`, 'the uploaded original is removed once staged');

  const other = await signIn('notyours@example.com');
  assert.equal((await call(`/api/jobs/${r.data.id}/result`, { token: other.access_token })).status, 404, "someone else's result is not reachable");
  assert.equal((await jobsOf(other.access_token)).length, 0);
  assert.equal((await call('/api/jobs/not-an-id/result', { token: s.access_token })).status, 404);
});

test('jobs: out of credits means nothing is queued or stored', async () => {
  const s = await signIn('jobsbroke@example.com');
  state.accounts.set(s.user.id, 0);
  const before = app.queue.sent.length;
  const r = await jobCall(s.access_token);
  assert.equal(r.status, 402);
  assert.equal(r.data.code, 'no-credits');
  assert.equal(app.queue.sent.length, before);
  assert.equal([...app.photos.files.keys()].some((k) => k.includes(s.user.id)), false);
});

test('jobs: a passing image-service hiccup is retried; a real failure refunds once', async () => {
  const s = await signIn('jobsretry@example.com');
  state.failImage = 1; // first attempt gets HTTP 500, the retry succeeds
  const r1 = await jobCall(s.access_token);
  await waitFor(async () => (await jobsOf(s.access_token)).find((j) => j.id === r1.data.id && j.status === 'done'));
  assert.equal(state.accounts.get(s.user.id), 1, 'retried and succeeded: one credit used');

  state.declineImage = 1; // declined by moderation: not retried
  const r2 = await jobCall(s.access_token);
  const failed = await waitFor(async () => (await jobsOf(s.access_token)).find((j) => j.id === r2.data.id && j.status === 'error'));
  assert.match(failed.error, /declined/);
  assert.equal(state.accounts.get(s.user.id), 1, 'credit refunded');
  assert.equal([...app.photos.files.keys()].some((k) => k.includes(r2.data.id)), false, 'nothing kept for a failed staging');

  state.failImage = 10; // keeps failing: gives up after the retries, refunds
  const r3 = await jobCall(s.access_token);
  await waitFor(async () => (await jobsOf(s.access_token)).find((j) => j.id === r3.data.id && j.status === 'error'));
  state.failImage = 0;
  await app.idle();
  assert.equal(state.accounts.get(s.user.id), 1, 'refunded once, not once per attempt');
  assert.equal((await call(`/api/jobs/${r3.data.id}/result`, { token: s.access_token })).status, 404);
});

test('jobs: delete, and the hourly cleanup of stuck and 30-day-old stagings', async () => {
  const s = await signIn('jobsclean@example.com');
  state.accounts.set(s.user.id, 5);
  const a = (await jobCall(s.access_token)).data.id;
  const b = (await jobCall(s.access_token)).data.id;
  await waitFor(async () => (await jobsOf(s.access_token)).filter((j) => j.status === 'done').length === 2);
  assert.equal((await call(`/api/jobs/${a}`, { method: 'DELETE', token: s.access_token })).status, 200);
  assert.equal((await jobsOf(s.access_token)).length, 1);
  assert.equal([...app.photos.files.keys()].some((k) => k.includes(a)), false, 'deleting removes the stored photo');

  state.stagings.get(b).created_at = new Date(Date.now() - 31 * 86400000).toISOString();
  const stuck = 'aaaaaaaa-0000-4000-8000-000000000009';
  state.stagings.set(stuck, { id: stuck, user_id: s.user.id, name: 'x.jpg', status: 'running', created_at: new Date(Date.now() - 3600000).toISOString() });
  await app.photos.put(`stagings/${s.user.id}/${stuck}/original.jpg`, new Uint8Array(3));
  const credits = state.accounts.get(s.user.id);
  await app.cron();
  await app.idle();
  assert.equal(state.stagings.has(b), false, '31-day-old staging purged');
  assert.equal([...app.photos.files.keys()].some((k) => k.includes(b) || k.includes(stuck + '/original')), false, 'and its files deleted');
  assert.equal(state.stagings.get(stuck).status, 'error', 'stuck job failed');
  assert.equal(state.accounts.get(s.user.id), credits + 1, '…with its credit refunded');
});
