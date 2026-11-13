// Stripe: selling credit packs through Checkout, and the webhook that adds
// the credits once a payment has gone through.
import { HttpError, json, requireEnv } from './http.js';
import { addCredits } from './supabase.js';

// PLACEHOLDER PRICING — set real packs with the PACKS variable (JSON, same shape).
// `amount` is in cents.
const DEFAULT_PACKS = [
  { id: 'pack25', name: '25 staged photos', credits: 25, amount: 1900 },
  { id: 'pack100', name: '100 staged photos', credits: 100, amount: 5900 },
];

export function packs(env) {
  try {
    const list = JSON.parse(env.PACKS);
    if (Array.isArray(list) && list.every((p) => p.id && p.credits > 0 && p.amount > 0)) return list;
  } catch {}
  return DEFAULT_PACKS;
}

const siteUrl = (env, request) => String(env.SITE_URL || new URL(request.url).origin).replace(/\/+$/, '');

export async function createCheckout(request, env, user, packId) {
  requireEnv(env, 'STRIPE_SECRET_KEY');
  const pack = packs(env).find((p) => p.id === packId);
  if (!pack) throw new HttpError(400, 'Unknown credit pack.');
  const site = siteUrl(env, request);
  const params = new URLSearchParams({
    mode: 'payment',
    client_reference_id: user.id,
    success_url: site + '/thanks.html',
    cancel_url: site + '/#pricing',
    'metadata[user_id]': user.id,
    'metadata[credits]': String(pack.credits),
    'metadata[pack]': pack.id,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(pack.amount),
    'line_items[0][price_data][product_data][name]': 'UnitStager – ' + (pack.name || pack.credits + ' credits'),
  });
  if (user.email) params.set('customer_email', user.email);
  const res = await fetch(String(env.STRIPE_BASE || 'https://api.stripe.com').replace(/\/+$/, '') + '/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.url) {
    console.error('stripe checkout failed', res.status, data && data.error && data.error.message);
    throw new HttpError(502, 'Could not start checkout. Try again shortly.', 'stripe');
  }
  return json({ url: data.url });
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
    }
  }
  return json({ received: true });
}
