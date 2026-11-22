// Stripe: selling credit packs through Checkout, and the webhook that adds
// the credits once a payment has gone through.
import { HttpError, json, requireEnv } from './http.js';
import { alert } from './alerts.js';
import { addCredits, claimAutoTopup, getAccount, listPurchases, notePayment, setAutoTopup, setStripeCustomer } from './supabase.js';

// Credit packs. `amount` is in cents. Override with the PACKS variable (JSON, same shape).
const DEFAULT_PACKS = [
  { id: 'pack25', name: '25 staged photos', credits: 25, amount: 1900 },
  { id: 'pack50', name: '50 staged photos', credits: 50, amount: 3400 },
  { id: 'pack100', name: '100 staged photos', credits: 100, amount: 5900 },
];

// Auto top-up buys the chosen pack again when the balance falls to this.
export const AUTO_THRESHOLD = 3;
const AUTO_MIN_SECONDS = 600;

export function packs(env) {
  try {
    const list = JSON.parse(env.PACKS);
    if (Array.isArray(list) && list.every((p) => p.id && p.credits > 0 && p.amount > 0)) return list;
  } catch {}
  return DEFAULT_PACKS;
}

// What the website and extension show: each pack with its per-photo price and
// the saving compared with the dearest per-photo price on offer.
export function publicPacks(env) {
  const list = packs(env);
  const dearest = Math.max(...list.map((p) => p.amount / p.credits));
  return list.map(({ id, name, credits, amount }) => ({ id, name, credits, amount, each: Math.round(amount / credits), save: Math.round((1 - amount / credits / dearest) * 100) }));
}

const siteUrl = (env, request) => String(env.SITE_URL || new URL(request.url).origin).replace(/\/+$/, '');
const stripeBase = (env) => String(env.STRIPE_BASE || 'https://api.stripe.com').replace(/\/+$/, '');

async function stripe(env, path, { params, idempotencyKey } = {}) {
  const res = await fetch(stripeBase(env) + path, {
    method: params ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer ' + String(env.STRIPE_SECRET_KEY).trim(),
      ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: params ? new URLSearchParams(params) : undefined,
  });
  return { res, data: await res.json().catch(() => null) };
}

// Start a purchase. With `auto`, the card is also saved (Stripe shows the
// customer a notice) so the same pack can be bought again automatically.
// `from` says where to send the customer afterwards: the website's account
// page ('web') or the thank-you page that points back to the extension.
export async function createCheckout(request, env, user, packId, auto, from) {
  requireEnv(env, 'STRIPE_SECRET_KEY');
  const pack = packs(env).find((p) => p.id === packId);
  if (!pack) throw new HttpError(400, 'Unknown credit pack.');
  const site = siteUrl(env, request);
  const web = from === 'web';
  const params = {
    mode: 'payment',
    client_reference_id: user.id,
    success_url: web ? site + '/account.html?paid=1' : site + '/thanks.html',
    cancel_url: web ? site + '/account.html' : site + '/#pricing',
    'metadata[user_id]': user.id,
    'metadata[credits]': String(pack.credits),
    'metadata[pack]': pack.id,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(pack.amount),
    'line_items[0][price_data][product_data][name]': 'UnitStager – ' + (pack.name || pack.credits + ' credits'),
  };
  // Reuse the customer on file, or have Stripe create one, so every purchase,
  // receipt and saved card belongs to the same Stripe customer.
  const account = await getAccount(env, user.id).catch(() => null);
  if (account && account.stripe_customer) params.customer = account.stripe_customer;
  else {
    if (user.email) params.customer_email = user.email;
    params.customer_creation = 'always';
  }
  if (auto) {
    params['metadata[auto_pack]'] = pack.id;
    params['payment_intent_data[setup_future_usage]'] = 'off_session';
  }
  const { res, data } = await stripe(env, '/v1/checkout/sessions', { params });
  if (!res.ok || !data || !data.url) {
    console.error('stripe checkout failed', res.status, data && data.error && data.error.message);
    throw new HttpError(502, 'Could not start checkout. Try again shortly.', 'stripe');
  }
  return json({ url: data.url });
}

// Stripe's customer portal: add, remove or change saved cards, and see past
// payments. Creates the Stripe customer first if this account has none yet.
export async function billingPortal(request, env, user) {
  requireEnv(env, 'STRIPE_SECRET_KEY');
  const account = (await getAccount(env, user.id)) || {};
  let customer = account.stripe_customer;
  if (!customer) {
    const params = { 'metadata[user_id]': user.id };
    if (user.email) params.email = user.email;
    const made = await stripe(env, '/v1/customers', { params, idempotencyKey: 'customer-' + user.id });
    if (!made.res.ok || !made.data || !made.data.id) {
      console.error('stripe customer create failed', made.res.status, made.data && made.data.error && made.data.error.message);
      throw new HttpError(502, 'Could not open payment settings. Try again shortly.', 'stripe');
    }
    customer = await setStripeCustomer(env, user.id, made.data.id);
  }
  const { res, data } = await stripe(env, '/v1/billing_portal/sessions', { params: { customer, return_url: siteUrl(env, request) + '/account.html' } });
  if (!res.ok || !data || !data.url) {
    const msg = (data && data.error && data.error.message) || '';
    console.error('stripe portal failed', res.status, msg);
    // Stripe refuses until the portal has been set up once in its dashboard.
    if (/configuration/i.test(msg)) throw new HttpError(503, 'Payment settings are not switched on yet. Please email hello@unitstager.com.', 'portal-config');
    throw new HttpError(502, 'Could not open payment settings. Try again shortly.', 'stripe');
  }
  return json({ url: data.url });
}

// Called after a staging: if the balance is low and auto top-up is on, charge
// the saved card for the chosen pack and add the credits. Never throws.
export async function maybeAutoTopUp(env, user, credits) {
  try {
    if (!(credits <= AUTO_THRESHOLD) || !env.STRIPE_SECRET_KEY) return;
    const claim = await claimAutoTopup(env, user.id, AUTO_THRESHOLD, AUTO_MIN_SECONDS);
    if (!claim) return;
    const off = async (why) => {
      console.error('auto top-up turned off:', why, user.id);
      await setAutoTopup(env, user.id, null);
      await alert(env, 'autotopup-off', 'An auto top-up was declined', `Auto top-up was switched off for ${user.email || user.id} (${why}). They can buy credits again normally.\n\nAt most one of these per hour.`);
    };
    const pack = packs(env).find((p) => p.id === claim.pack);
    if (!pack) return await off('pack no longer exists');

    const cards = await stripe(env, `/v1/customers/${encodeURIComponent(claim.customer)}/payment_methods?type=card&limit=1`);
    const card = cards.res.ok && cards.data && cards.data.data && cards.data.data[0];
    if (!card) return cards.res.ok ? await off('no saved card') : console.error('auto top-up: could not list cards', cards.res.status);

    const params = {
      amount: String(pack.amount),
      currency: 'usd',
      customer: claim.customer,
      payment_method: card.id,
      off_session: 'true',
      confirm: 'true',
      description: 'UnitStager auto top-up – ' + (pack.name || pack.credits + ' credits'),
      'metadata[user_id]': user.id,
      'metadata[credits]': String(pack.credits),
      'metadata[pack]': pack.id,
      'metadata[kind]': 'auto-topup',
    };
    if (user.email) params.receipt_email = user.email;
    // The key ties this charge to this one claim, so a retry can never charge twice.
    const { res, data } = await stripe(env, '/v1/payment_intents', { params, idempotencyKey: `auto-${user.id}-${claim.stamp}` });
    if (res.ok && data && data.status === 'succeeded') {
      await addCredits(env, user.id, pack.credits, 'auto-topup', 'stripe:' + data.id);
      await notePayment(env, 'stripe:' + data.id, pack.amount).catch(() => {});
    } else if (res.status === 402 || (res.ok && data && data.status !== 'processing')) {
      // Declined, or the bank wants the customer present: stop trying until they buy again.
      await off((data && data.error && data.error.code) || (data && data.status) || 'declined');
    } else {
      console.error('auto top-up: charge did not complete', res.status, data && data.error && data.error.message);
    }
  } catch (e) {
    console.error('auto top-up failed', e && e.message);
  }
}

// The signed-in customer's purchases, for the "Purchase history" list.
export async function purchases(env, user) {
  const rows = (await listPurchases(env, user.id)) || [];
  return json({
    purchases: rows.map((r) =>
      r.reason === 'promo'
        ? { id: null, date: r.created_at, credits: r.credits, amount: 0, promo: String(r.ref || '').split(':')[1] || 'promo' }
        : { id: String(r.ref || '').replace(/^stripe:/, ''), date: r.created_at, credits: r.credits, amount: r.amount_cents ?? null, auto: r.reason === 'auto-topup' }
    ),
  });
}

// Stripe's receipt page for one of the customer's own purchases.
export async function receipt(env, user, id) {
  requireEnv(env, 'STRIPE_SECRET_KEY');
  const rows = (await listPurchases(env, user.id)) || [];
  if (!/^(cs|pi)_[A-Za-z0-9_]+$/.test(id) || !rows.some((r) => r.ref === 'stripe:' + id)) throw new HttpError(404, 'That purchase was not found on your account.');
  const path = id.startsWith('cs_') ? `/v1/checkout/sessions/${id}?expand[]=payment_intent.latest_charge` : `/v1/payment_intents/${id}?expand[]=latest_charge`;
  const { res, data } = await stripe(env, path);
  const intent = data && (id.startsWith('cs_') ? data.payment_intent : data);
  const url = res.ok && intent && intent.latest_charge && intent.latest_charge.receipt_url;
  if (!url) throw new HttpError(502, 'The receipt is not available right now. Try again shortly.', 'stripe');
  return json({ url });
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Checks the Stripe-Signature header so nobody else can post fake payments.
export async function verifySignature(payload, header, secret, now = Date.now()) {
  const parts = Object.create(null);
  const sigs = [];
  for (const piece of String(header || '').split(',')) {
    const i = piece.indexOf('=');
    if (i < 0) continue;
    const k = piece.slice(0, i).trim();
    const v = piece.slice(i + 1).trim();
    if (k === 'v1') sigs.push(v);
    else parts[k] = v;
  }
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${parts.t}.${payload}`)));
  return sigs.some((s) => timingSafeEqual(s, expected));
}

export async function webhook(request, env) {
  requireEnv(env, 'STRIPE_WEBHOOK_SECRET');
  const payload = await request.text();
  if (!(await verifySignature(payload, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET))) throw new HttpError(400, 'Bad signature.');
  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    throw new HttpError(400, 'Bad payload.');
  }
  const paidEvents = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
  if (paidEvents.includes(event.type)) {
    const session = event.data && event.data.object;
    const meta = (session && session.metadata) || {};
    const credits = parseInt(meta.credits, 10);
    if (session && session.payment_status === 'paid' && meta.user_id && credits > 0) {
      // Keyed on the Stripe session id, so Stripe retrying the webhook can never add credits twice.
      // If this fails the error makes Stripe retry later.
      await addCredits(env, meta.user_id, credits, 'purchase', 'stripe:' + session.id);
      if (session.amount_total > 0) await notePayment(env, 'stripe:' + session.id, session.amount_total).catch(() => {});
      if (session.customer) await setStripeCustomer(env, meta.user_id, String(session.customer)).catch(() => {});
      // Bought with "auto top-up" ticked: the card was saved, so switch it on.
      if (meta.auto_pack && session.customer) await setAutoTopup(env, meta.user_id, meta.auto_pack, String(session.customer));
    }
  }
  return json({ received: true });
}
