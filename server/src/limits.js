// Abuse limits. Counts live in the database (rate_hit in schema.sql), keyed by
// the visitor's IP address as Cloudflare reports it, or by email address.
import { HttpError } from './http.js';
import { rpc } from './supabase.js';

// [limit, window in minutes]. RATE_LIMIT_SCALE multiplies every limit (tests).
const LIMITS = {
  'code-ip': [10, 60], // sign-in code emails per IP per hour
  'code-email': [5, 60], // sign-in code emails per address per hour
  'verify-ip': [30, 60], // sign-in attempts per IP per hour
  'promo-ip': [20, 60], // promo code attempts per IP per hour
  'free-ip': [3, 43200], // new accounts given free credits per IP per 30 days
};

export const clientIp = (request) => request.headers.get('CF-Connecting-IP') || request.headers.get('X-Real-IP') || 'unknown';

// True if within the limit (and counts it); false if over.
export async function allow(env, kind, key) {
  const [limit, minutes] = LIMITS[kind];
  const scale = Math.max(1, Number(env.RATE_LIMIT_SCALE) || 1);
  return rpc(env, 'rate_hit', { p_kind: kind, p_key: String(key).toLowerCase().slice(0, 200), p_limit: limit * scale, p_minutes: minutes });
}

export async function enforce(env, kind, key, message) {
  if (!(await allow(env, kind, key))) throw new HttpError(429, message, 'rate-limit');
}
