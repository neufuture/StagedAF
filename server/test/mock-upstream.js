// A stand-in for Supabase, Stripe and the image API, for tests. In-memory.
import http from 'node:http';
import crypto from 'node:crypto';

export async function startMock({ imageBase64 = 'c3RhZ2Vk' } = {}) {
  const state = {
    code: '123456',
    emails: [], // sign-in emails "sent"
    users: new Map(), // email -> {id, email}
    accounts: new Map(), // user id -> credits
    refs: new Set(),
    ledger: [],
    stripe: [], // checkout sessions created
    auto: new Map(), // user id -> {customer, pack, lastAt}
    charges: [], // off-session payment intents (auto top-up)
    declineCharge: false,
    noCard: false,
    image: [], // image API calls
    failImage: 0, // make the next N image calls fail with HTTP 500
    declineImage: 0, // ...or be declined by moderation
    rejectFidelity: true, // behave like a model that rejects input_fidelity
    imageDelay: 300,
    stagings: new Map(),
    promos: new Map(), // code -> {credits, max, expires, users:Set}
    rates: new Map(),
    events: [],
    nudgeCandidates: [],
    nudgesSent: new Set(),
    optedOut: new Set(),
    emails_sent: [], // alert emails sent through the Resend stand-in
    turnstileGood: 'XXXX.DUMMY.TOKEN.XXXX',
    usage: { input_tokens: 1300, input_tokens_details: { text_tokens: 300, image_tokens: 1000 }, output_tokens: 5400 },
  };
  const userFor = (email) => {
    if (!state.users.has(email)) state.users.set(email, { id: crypto.randomUUID(), email });
    return state.users.get(email);
  };
  const byToken = (t) => [...state.users.values()].find((u) => t === 'at-' + u.id);
  const session = (u) => ({ access_token: 'at-' + u.id, refresh_token: 'rt-' + u.id, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: u });

  const rpc = {
    ensure_account({ p_user, p_email, p_free }) {
      if (!state.accounts.has(p_user)) {
        state.accounts.set(p_user, p_free);
        if (p_free > 0) state.ledger.push({ user: p_user, delta: p_free, reason: 'signup' });
      }
      return state.accounts.get(p_user);
    },
    spend_credit({ p_user, p_ref }) {
      const c = state.accounts.get(p_user) || 0;
      if (c <= 0) return -1;
      state.accounts.set(p_user, c - 1);
      state.ledger.push({ user: p_user, delta: -1, reason: 'stage', ref: p_ref });
      return c - 1;
    },
    get_account({ p_user }) {
      if (!state.accounts.has(p_user)) return null; // like the real query: no row, no account
      const a = state.auto.get(p_user) || {};
      return { credits: state.accounts.get(p_user) ?? 0, auto_pack: a.pack || null, has_card: !!a.customer, stripe_customer: a.customer || null };
    },
    set_auto_topup({ p_user, p_pack, p_customer }) {
      const a = state.auto.get(p_user) || {};
      state.auto.set(p_user, { ...a, pack: p_pack, customer: p_customer || a.customer || null });
      return null;
    },
    claim_auto_topup({ p_user, p_threshold, p_min_seconds }) {
      const a = state.auto.get(p_user);
      const credits = state.accounts.get(p_user) ?? 0;
      if (!a || !a.pack || !a.customer || credits > p_threshold) return null;
      if (a.lastAt && Date.now() - a.lastAt < p_min_seconds * 1000) return null;
      a.lastAt = Date.now();
      return { pack: a.pack, customer: a.customer, stamp: a.lastAt };
    },
    set_stripe_customer({ p_user, p_customer }) {
      const a = state.auto.get(p_user) || { pack: null };
      if (!a.customer) a.customer = p_customer;
      state.auto.set(p_user, a);
      return a.customer;
    },
    rate_hit({ p_kind, p_key, p_limit, p_minutes }) {
      const k = p_kind + ':' + p_key;
      const cut = Date.now() - p_minutes * 60000;
      const list = (state.rates.get(k) || []).filter((t) => t > cut);
      if (list.length >= p_limit) return false;
      list.push(Date.now());
      state.rates.set(k, list);
      return true;
    },
    trim_rate_events() {
      return null;
    },
    nudge_candidates({ p_limit }) {
      return state.nudgeCandidates.filter((c) => !state.optedOut.has(c.user_id) && !state.nudgesSent.has(c.user_id + ':' + c.kind)).slice(0, p_limit);
    },
    mark_nudge({ p_user, p_kind }) {
      const k = p_user + ':' + p_kind;
      if (state.nudgesSent.has(k)) return false;
      state.nudgesSent.add(k);
      return true;
    },
    set_emails_off({ p_user }) {
      state.optedOut.add(p_user);
      return null;
    },
    note_event({ p_kind, p_key }) {
      state.events.push({ kind: p_kind, key: p_key, at: Date.now() });
      return null;
    },
    recent_event({ p_kind, p_key, p_minutes }) {
      return state.events.some((e) => e.kind === p_kind && e.key === p_key && e.at > Date.now() - p_minutes * 60000);
    },
    record_staging_usage({ p_id, p_input, p_output, p_cost }) {
      const j = state.stagings.get(p_id);
      if (j) Object.assign(j, { input_tokens: p_input, output_tokens: p_output, cost_usd: p_cost });
      return null;
    },
    usage_today() {
      const day = new Date().toISOString().slice(0, 10);
      const today = [...state.stagings.values()].filter((j) => String(j.created_at).startsWith(day));
      return { stagings: today.length, cost_usd: today.reduce((s, j) => s + (Number(j.cost_usd) || 0), 0) };
    },
    period_stats() {
      const done = [...state.stagings.values()].filter((j) => j.status === 'done');
      return { new_accounts: state.accounts.size, free_credits: 0, promo_credits: 0, purchases: 0, revenue_cents: 3400, stagings_done: done.length, stagings_failed: 0,
        cost_usd: done.reduce((s, j) => s + (Number(j.cost_usd) || 0), 0), avg_cost_usd: 0.18, credits_unused: 7, limit_hits: { 'hit:code-ip': 2 } };
    },
    // ---- background stagings ----
    create_staging(a) {
      const c = state.accounts.get(a.p_user) || 0;
      if (c <= 0) return -1;
      state.accounts.set(a.p_user, c - 1);
      state.ledger.push({ user: a.p_user, delta: -1, reason: 'stage', ref: 'stage:' + a.p_id, at: new Date().toISOString() });
      state.stagings.set(a.p_id, { id: a.p_id, user_id: a.p_user, name: a.p_name, room: a.p_room, style: a.p_style, custom: a.p_custom, width: a.p_width, height: a.p_height,
        label: !!a.p_label, status: 'queued', error: null, created_at: new Date().toISOString(), finished_at: null });
      return c - 1;
    },
    start_staging({ p_id }) {
      const j = state.stagings.get(p_id);
      if (!j || !['queued', 'running'].includes(j.status)) return null;
      j.status = 'running';
      return { id: j.id, user_id: j.user_id, room: j.room, style: j.style, custom: j.custom, width: j.width, height: j.height };
    },
    finish_staging({ p_id, p_ok, p_error }) {
      const j = state.stagings.get(p_id);
      if (!j || !['queued', 'running'].includes(j.status)) return false;
      j.status = p_ok ? 'done' : 'error';
      j.error = p_ok ? null : p_error;
      j.finished_at = new Date().toISOString();
      if (!p_ok && !state.refs.has('refund:' + p_id)) {
        state.refs.add('refund:' + p_id);
        state.accounts.set(j.user_id, (state.accounts.get(j.user_id) || 0) + 1);
        state.ledger.push({ user: j.user_id, delta: 1, reason: 'refund', ref: 'refund:' + p_id });
      }
      return true;
    },
    list_stagings({ p_user }) {
      return [...state.stagings.values()].filter((j) => j.user_id === p_user).reverse().map(({ id, name, room, style, label, status, error, created_at, finished_at }) => ({ id, name, room, style, label, status, error, created_at, finished_at }));
    },
    staging_status({ p_user, p_id }) {
      const j = state.stagings.get(p_id);
      return j && j.user_id === p_user ? j.status : null;
    },
    delete_staging({ p_user, p_id }) {
      const j = state.stagings.get(p_id);
      if (!j || j.user_id !== p_user || !['done', 'error'].includes(j.status)) return false;
      state.stagings.delete(p_id);
      return true;
    },
    purge_stagings({ p_days }) {
      const cut = Date.now() - p_days * 86400000;
      const gone = [...state.stagings.values()].filter((j) => Date.parse(j.created_at) < cut);
      for (const j of gone) state.stagings.delete(j.id);
      return gone.map((j) => ({ id: j.id, user_id: j.user_id }));
    },
    fail_stale_stagings({ p_minutes }) {
      const cut = Date.now() - p_minutes * 60000;
      const stuck = [...state.stagings.values()].filter((j) => ['queued', 'running'].includes(j.status) && Date.parse(j.created_at) < cut);
      for (const j of stuck) rpc.finish_staging({ p_id: j.id, p_ok: false, p_error: 'Staging took too long and was stopped. Your credit was returned.' });
      return stuck.map((j) => ({ id: j.id, user_id: j.user_id }));
    },
    note_payment({ p_ref, p_cents }) {
      const row = state.ledger.find((l) => l.ref === p_ref);
      if (row) row.amount_cents = p_cents;
      return null;
    },
    redeem_promo({ p_user, p_code }) {
      const code = String(p_code || '').replace(/\s/g, '').toUpperCase();
      const c = state.promos.get(code);
      if (!c) return { ok: false, error: 'invalid' };
      if (c.expires && c.expires < Date.now()) return { ok: false, error: 'expired' };
      if (c.users.has(p_user)) return { ok: false, error: 'already' };
      if (c.max && c.users.size >= c.max) return { ok: false, error: 'used_up' };
      c.users.add(p_user);
      state.accounts.set(p_user, (state.accounts.get(p_user) || 0) + c.credits);
      state.ledger.push({ user: p_user, delta: c.credits, reason: 'promo', ref: `promo:${code}:${p_user}`, at: new Date().toISOString() });
      return { ok: true, added: c.credits, credits: state.accounts.get(p_user), code };
    },
    list_purchases({ p_user }) {
      return state.ledger.filter((l) => l.user === p_user && ['purchase', 'auto-topup', 'promo'].includes(l.reason)).map((l) => ({ created_at: l.at, credits: l.delta, reason: l.reason, ref: l.ref, amount_cents: l.amount_cents ?? null })).reverse();
    },
    add_credits({ p_user, p_amount, p_reason, p_ref }) {
      if (!state.refs.has(p_ref)) {
        state.refs.add(p_ref);
        state.accounts.set(p_user, (state.accounts.get(p_user) || 0) + p_amount);
        state.ledger.push({ user: p_user, delta: p_amount, reason: p_reason, ref: p_ref, at: new Date().toISOString() });
      }
      return state.accounts.get(p_user);
    },
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      const send = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
      const body = () => JSON.parse(raw.toString() || '{}');
      const p = url.pathname;

      if (p === '/auth/v1/otp') {
        if (!req.headers.apikey) return send(401, { msg: 'no api key' });
        state.emails.push(body().email);
        return send(200, {});
      }
      if (p === '/auth/v1/verify') {
        const b = body();
        return b.token === state.code && b.type === 'email' ? send(200, session(userFor(b.email))) : send(403, { msg: 'Token has expired or is invalid' });
      }
      if (p === '/auth/v1/token') {
        const u = [...state.users.values()].find((x) => body().refresh_token === 'rt-' + x.id);
        return u ? send(200, session(u)) : send(400, { msg: 'Invalid Refresh Token' });
      }
      if (p === '/auth/v1/user') {
        const u = byToken((req.headers.authorization || '').replace('Bearer ', ''));
        return u ? send(200, u) : send(401, { msg: 'invalid JWT' });
      }
      if (p.startsWith('/rest/v1/rpc/')) {
        if (req.headers.apikey !== 'secret-key' || req.headers.authorization !== 'Bearer secret-key') return send(401, { message: 'bad key' });
        if (state.rpcFail && p.endsWith('/' + state.rpcFail)) return send(404, { code: 'PGRST202', message: 'Could not find the function' });
        const fn = rpc[p.split('/').pop()];
        return fn ? send(200, fn(body())) : send(404, { message: 'no such function' });
      }
      if (p === '/v1/checkout/sessions') {
        const params = Object.fromEntries(new URLSearchParams(raw.toString()));
        const id = 'cs_test_' + (state.stripe.length + 1);
        state.stripe.push({ id, auth: req.headers.authorization, params });
        return send(200, { id, url: 'https://checkout.stripe.test/pay/' + id });
      }
      if (/^\/v1\/customers\/[^/]+\/payment_methods$/.test(p)) {
        return send(200, { data: state.noCard ? [] : [{ id: 'pm_card_1', type: 'card' }] });
      }
      if (/^\/v1\/checkout\/sessions\/cs_/.test(p) && req.method === 'GET') {
        return send(200, { id: p.split('/').pop(), payment_intent: { latest_charge: { receipt_url: 'https://pay.stripe.test/receipts/' + p.split('/').pop() } } });
      }
      if (/^\/v1\/payment_intents\/pi_/.test(p) && req.method === 'GET') {
        return send(200, { id: p.split('/').pop(), latest_charge: { receipt_url: 'https://pay.stripe.test/receipts/' + p.split('/').pop() } });
      }
      if (p === '/emails') {
        state.emails_sent.push({ auth: req.headers.authorization, ...JSON.parse(raw.toString()) });
        return send(200, { id: 'email_' + state.emails_sent.length });
      }
      if (p === '/turnstile/v0/siteverify') {
        const text = raw.toString('latin1');
        const field = (name) => (new RegExp(`name="${name}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`).exec(text) || [])[1];
        const ok = field('secret') === 'turnstile-secret' && field('response') === state.turnstileGood;
        return send(200, ok ? { success: true } : { success: false, 'error-codes': ['invalid-input-response'] });
      }
      if (p === '/v1/customers' && req.method === 'POST') {
        const params = Object.fromEntries(new URLSearchParams(raw.toString()));
        const key = req.headers['idempotency-key'];
        state.customers = state.customers || [];
        const seen = state.customers.find((c) => c.key === key);
        if (seen) return send(200, { id: seen.id });
        const id = 'cus_new_' + (state.customers.length + 1);
        state.customers.push({ id, key, params });
        return send(200, { id });
      }
      if (p === '/v1/billing_portal/sessions') {
        const params = Object.fromEntries(new URLSearchParams(raw.toString()));
        state.portals = state.portals || [];
        state.portals.push(params);
        if (state.portalNotConfigured) return send(400, { error: { message: 'No configuration provided and your test mode default configuration has not been created.' } });
        return send(200, { url: 'https://billing.stripe.test/p/session/' + params.customer });
      }
      if (p === '/v1/payment_intents') {
        const params = Object.fromEntries(new URLSearchParams(raw.toString()));
        const key = req.headers['idempotency-key'];
        const seen = state.charges.find((c) => c.key === key);
        if (seen) return send(200, { id: seen.id, status: 'succeeded' }); // Stripe replays the first answer
        if (state.declineCharge) return send(402, { error: { code: 'card_declined', message: 'Your card was declined.' } });
        const id = 'pi_test_' + (state.charges.length + 1);
        state.charges.push({ id, key, params });
        return send(200, { id, status: 'succeeded' });
      }
      if (p === '/v1/images/edits') {
        const text = raw.toString('latin1');
        const field = (name) => (new RegExp(`name="${name}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`).exec(text) || [])[1];
        const call = { auth: req.headers.authorization, prompt: field('prompt'), size: field('size'), fidelity: field('input_fidelity'), model: field('model'), quality: field('quality'), hasImage: /name="image"; filename=/.test(text) };
        state.image.push(call);
        if (call.fidelity && state.rejectFidelity) return send(400, { error: { message: "Unknown parameter: 'input_fidelity'.", param: 'input_fidelity' } });
        if (state.declineImage-- > 0) return send(400, { error: { message: 'Your request was rejected by the safety system.', code: 'moderation_blocked' } });
        if (state.failImage-- > 0) return send(500, { error: { message: 'Mock server exploded' } });
        return setTimeout(() => send(200, { data: [{ b64_json: imageBase64 }], usage: state.usage }), state.imageDelay);
      }
      send(404, { message: 'mock: unknown path ' + p });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, state, close: () => server.close() };
}

// Sign a payload the way Stripe signs webhooks.
export function stripeSign(payload, secret, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
}
