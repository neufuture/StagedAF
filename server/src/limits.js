// Abuse limits. Counts live in the database (rate_hit in schema.sql), keyed by
// the visitor's IP address as Cloudflare reports it, or by email address.
//
// Every limit can be changed without a code change: add a plain-text variable
// with the name below in Cloudflare (Worker → Settings → Variables and
// Secrets). RATE_LIMIT_SCALE multiplies them all (used by tests).
import { alert } from './alerts.js';
import { HttpError } from './http.js';
import { rpc } from './supabase.js';

// kind: [variable name, default limit, window in minutes, description]
const LIMITS = {
  'code-ip': ['LIMIT_CODES_PER_IP_HOUR', 30, 60, 'sign-in code emails per network per hour (Turnstile passed)'],
  'code-ip-unverified': ['LIMIT_CODES_PER_IP_HOUR_UNVERIFIED', 10, 60, 'sign-in code emails per network per hour (no Turnstile)'],
  'code-email': ['LIMIT_CODES_PER_EMAIL_HOUR', 8, 60, 'sign-in code emails per address per hour'],
  'verify-ip': ['LIMIT_SIGNINS_PER_IP_HOUR', 60, 60, 'sign-in attempts per network per hour'],
  'promo-ip': ['LIMIT_PROMO_PER_IP_HOUR', 30, 60, 'promo code attempts per network per hour'],
  'free-ip': ['LIMIT_FREE_ACCOUNTS_PER_IP_MONTH', 10, 43200, 'new accounts given free credits per network per 30 days'],
};

export const clientIp = (request) => request.headers.get('CF-Connecting-IP') || request.headers.get('X-Real-IP') || 'unknown';
const mask = (key) => (/@/.test(key) ? key.replace(/^(.).*(@.*)$/, '$1…$2') : key.replace(/(\d+)$/, 'x'));

// True if within the limit (and counts it); false if over (and raises an alert).
export async function allow(env, kind, key) {
  const [name, def, minutes, about] = LIMITS[kind];
  const limit = Math.max(1, Number(env[name]) || def) * Math.max(1, Number(env.RATE_LIMIT_SCALE) || 1);
  const k = String(key).toLowerCase().slice(0, 200);
  const ok = await rpc(env, 'rate_hit', { p_kind: kind, p_key: k, p_limit: limit, p_minutes: minutes });
  if (!ok) {
    await rpc(env, 'note_event', { p_kind: 'hit:' + kind, p_key: k }).catch(() => {});
    await alert(env, 'limit:' + kind, `Limit reached: ${about}`,
      `The limit of ${limit} ${about} was reached (by ${mask(k)}).\n\nIf this is real customers, raise it by setting ${name} in Cloudflare (Worker → Settings → Variables and Secrets). If it looks like abuse, leave it.\n\nYou'll get at most one of these per hour for this limit.`);
  }
  return ok;
}

export async function enforce(env, kind, key, message) {
  if (!(await allow(env, kind, key))) throw new HttpError(429, message, 'rate-limit');
}
