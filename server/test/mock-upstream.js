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
    note_payment({ p_ref, p_cents }) {
      const row = state.ledger.find((l) => l.ref === p_ref);
      if (row) row.amount_cents = p_cents;
      return null;
    },
    list_purchases({ p_user }) {
      return state.ledger.filter((l) => l.user === p_user && ['purchase', 'auto-topup'].includes(l.reason)).map((l) => ({ created_at: l.at, credits: l.delta, reason: l.reason, ref: l.ref, amount_cents: l.amount_cents ?? null })).reverse();
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
        return setTimeout(() => send(200, { data: [{ b64_json: imageBase64 }] }), state.imageDelay);
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
