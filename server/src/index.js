// UnitStager server (Cloudflare Worker).
//
//   POST /api/auth/start     {email}                 email a sign-in code
//   POST /api/auth/verify    {email, code}           -> session + credits
//   POST /api/auth/refresh   {refresh_token}         -> session
//   GET  /api/me                                     -> email, credits, packs
//   GET  /api/packs                                  -> packs (public, for the website)
//   POST /api/stage          multipart photo         -> staged photo (costs 1 credit)
//   POST /api/checkout       {pack, auto?}           -> Stripe Checkout URL
//   POST /api/auto-topup     {enabled:false}         turn auto top-up off
//   GET  /api/purchases                              -> the account's purchases
//   POST /api/receipt        {id}                    -> Stripe receipt URL for one purchase
//   POST /api/stripe/webhook                         Stripe -> add purchased credits
//
// Everything else is the static website in ./public.
import { CORS, HttpError, json, readJson } from './http.js';
import { stage } from './stage.js';
import { AUTO_THRESHOLD, createCheckout, publicPacks, purchases, receipt, webhook } from './stripe.js';
import { ensureAccount, getAccount, refreshSession, requireUser, sendCode, setAutoTopup, verifyCode } from './supabase.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function api(request, env, path, ctx) {
  const route = request.method + ' ' + path;
  switch (route) {
    case 'POST /api/auth/start': {
      const email = String((await readJson(request)).email || '').trim().toLowerCase();
      if (!EMAIL.test(email) || email.length > 254) throw new HttpError(400, 'Enter a valid email address.');
      await sendCode(env, email);
      return json({ ok: true });
    }
    case 'POST /api/auth/verify': {
      const body = await readJson(request);
      const email = String(body.email || '').trim().toLowerCase();
      const code = String(body.code || '').replace(/\s+/g, '');
      if (!EMAIL.test(email) || !/^\d{6,10}$/.test(code)) throw new HttpError(400, 'Enter the code from the email.');
      const session = await verifyCode(env, email, code);
      const credits = await ensureAccount(env, session.user);
      return json({ ...session, credits });
    }
    case 'POST /api/auth/refresh': {
      const token = String((await readJson(request)).refresh_token || '');
      if (!token) throw new HttpError(401, 'Sign in again.', 'auth');
      return json(await refreshSession(env, token));
    }
    case 'GET /api/me': {
      const user = await requireUser(env, request);
      const credits = await ensureAccount(env, user);
      // Tolerate a database that has not had the latest schema.sql run yet.
      const account = (await getAccount(env, user.id).catch(() => null)) || {};
      return json({ email: user.email, credits, packs: publicPacks(env), auto: { pack: account.auto_pack || null, threshold: AUTO_THRESHOLD } });
    }
    case 'GET /api/packs':
      return json({ packs: publicPacks(env), free_credits: Number(env.FREE_CREDITS ?? 10) || 0, auto_threshold: AUTO_THRESHOLD });
    case 'POST /api/stage':
      return stage(request, env, await requireUser(env, request), ctx);
    case 'POST /api/checkout': {
      const user = await requireUser(env, request);
      const body = await readJson(request);
      return createCheckout(request, env, user, String(body.pack || ''), body.auto === true);
    }
    case 'GET /api/purchases':
      return purchases(env, await requireUser(env, request));
    case 'POST /api/receipt': {
      const user = await requireUser(env, request);
      return receipt(env, user, String((await readJson(request)).id || ''));
    }
    case 'POST /api/auto-topup': {
      // Turning it ON happens by buying a pack with the box ticked (that is
      // when the card is saved); this endpoint only turns it off.
      const user = await requireUser(env, request);
      if ((await readJson(request)).enabled !== false) throw new HttpError(400, 'Buy a pack with auto top-up ticked to turn it on.');
      await setAutoTopup(env, user.id, null);
      return json({ auto: { pack: null, threshold: AUTO_THRESHOLD } });
    }
    case 'POST /api/stripe/webhook':
      return webhook(request, env);
  }
  throw new HttpError(404, 'Not found.');
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      return await api(request, env, pathname.replace(/\/+$/, ''), ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
      console.error('unhandled', e && e.stack);
      return json({ error: 'Something went wrong on our side.' }, 500);
    }
  },
};
