// Cloudflare Turnstile: a check, normally invisible, that the person signing
// up isn't a bot. Off until TURNSTILE_SECRET_KEY is set. While
// TURNSTILE_REQUIRED isn't "true", sign-in still works without it (for
// extension versions that predate it), but with tighter limits and no free
// credits.
import { HttpError } from './http.js';

export const turnstileOn = (env) => !!env.TURNSTILE_SECRET_KEY;
export const turnstileRequired = (env) => turnstileOn(env) && String(env.TURNSTILE_REQUIRED).toLowerCase() === 'true';

// true = passed, false = no token given. Throws on a bad token.
export async function checkTurnstile(env, token, ip) {
  if (!turnstileOn(env)) return false;
  if (!token) {
    if (turnstileRequired(env)) throw new HttpError(403, 'Please complete the security check and try again.', 'captcha');
    return false;
  }
  const form = new FormData();
  form.append('secret', String(env.TURNSTILE_SECRET_KEY).trim());
  form.append('response', String(token).slice(0, 2048));
  if (ip && ip !== 'unknown') form.append('remoteip', ip);
  let data = null;
  try {
    const res = await fetch(env.TURNSTILE_VERIFY_URL || 'https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    data = await res.json();
  } catch (e) {
    console.error('turnstile unreachable', e && e.message);
    return false; // Cloudflare unreachable: treat like no token rather than lock everyone out
  }
  if (data && data.success) return true;
  console.error('turnstile rejected', JSON.stringify(data && data['error-codes']));
  throw new HttpError(403, 'The security check failed. Reload the page and try again.', 'captcha');
}
