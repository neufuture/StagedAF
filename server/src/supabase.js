// Supabase: email sign-in (Auth) and the accounts / credits database.
//
// Two keys are used:
//   SUPABASE_PUBLISHABLE_KEY – for sign-in calls made on behalf of a visitor
//   SUPABASE_SECRET_KEY      – for the credits database; never leaves the server
import { HttpError, requireEnv } from './http.js';

const base = (env) => String(env.SUPABASE_URL).replace(/\/+$/, '');

async function parse(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function auth(env, path, { method = 'POST', body, token } = {}) {
  requireEnv(env, 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY');
  const headers = { apikey: env.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(base(env) + '/auth/v1' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { res, data: await parse(res) };
}

const sessionOut = (data) => ({
  access_token: data.access_token,
  refresh_token: data.refresh_token,
  expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
  user: { id: data.user && data.user.id, email: data.user && data.user.email },
});

// Email the visitor a 6-digit sign-in code (creates the user if new).
export async function sendCode(env, email) {
  const { res, data } = await auth(env, '/otp', { body: { email, create_user: true } });
  if (res.ok) return;
  if (res.status === 429) throw new HttpError(429, 'Too many sign-in emails. Wait a minute and try again.', 'rate-limit');
  throw new HttpError(res.status === 422 || res.status === 400 ? 400 : 502, (data && (data.msg || data.error_description || data.message)) || 'Could not send the sign-in email.');
}

export async function verifyCode(env, email, code) {
  const { res, data } = await auth(env, '/verify', { body: { type: 'email', email, token: code } });
  if (!res.ok || !data || !data.access_token) throw new HttpError(401, 'That code is wrong or has expired. Request a new one.', 'bad-code');
  return sessionOut(data);
}

export async function refreshSession(env, refreshToken) {
  const { res, data } = await auth(env, '/token?grant_type=refresh_token', { body: { refresh_token: refreshToken } });
  if (!res.ok || !data || !data.access_token) throw new HttpError(401, 'Your sign-in has expired. Sign in again.', 'auth');
  return sessionOut(data);
}

// Who is making this request? Checks the "Authorization: Bearer" token with Supabase.
export async function requireUser(env, request) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'Sign in to UnitStager first.', 'auth');
  const { res, data } = await auth(env, '/user', { method: 'GET', token });
  if (!res.ok || !data || !data.id) throw new HttpError(401, 'Your sign-in has expired. Sign in again.', 'auth');
  return { id: data.id, email: data.email || '' };
}

// Call one of the database functions in supabase/schema.sql.
async function rpc(env, fn, args) {
  requireEnv(env, 'SUPABASE_URL', 'SUPABASE_SECRET_KEY');
  const res = await fetch(`${base(env)}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const data = await parse(res);
  if (!res.ok) {
    console.error('database call failed', fn, res.status, JSON.stringify(data));
    throw new HttpError(502, 'The account database is unavailable. Try again shortly.', 'database');
  }
  return data;
}

// Create the account on first sign-in (with the free credits); returns the balance.
export const ensureAccount = (env, user) => rpc(env, 'ensure_account', { p_user: user.id, p_email: user.email, p_free: Number(env.FREE_CREDITS ?? 10) || 0 });

// Take one credit. Returns the new balance, or -1 if there were none.
export const spendCredit = (env, userId, ref) => rpc(env, 'spend_credit', { p_user: userId, p_ref: ref });

// Add credits. `ref` makes it safe to repeat: the same ref is only ever applied once.
export const addCredits = (env, userId, amount, reason, ref) => rpc(env, 'add_credits', { p_user: userId, p_amount: amount, p_reason: reason, p_ref: ref });
