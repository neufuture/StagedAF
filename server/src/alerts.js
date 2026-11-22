// Email alerts and the daily summary, sent through Resend to ALERT_EMAIL.
// Without RESEND_API_KEY / ALERT_EMAIL set, alerts only go to the Worker logs.
import { rpc } from './supabase.js';

const SITE = (env) => String(env.SITE_URL || 'https://unitstager.com').replace(/\/+$/, '');

async function send(env, subject, text) {
  console.log('ALERT:', subject, '|', text.replace(/\s+/g, ' ').slice(0, 500));
  if (!env.RESEND_API_KEY || !env.ALERT_EMAIL) return false;
  const res = await fetch(String(env.RESEND_BASE || 'https://api.resend.com').replace(/\/+$/, '') + '/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + String(env.RESEND_API_KEY).trim(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.ALERT_FROM || 'UnitStager alerts <alerts@unitstager.com>', to: String(env.ALERT_EMAIL).split(',').map((s) => s.trim()), subject, text }),
  }).catch((e) => ({ ok: false, status: 0, e }));
  if (!res.ok) console.error('alert email failed', res.status);
  return res.ok;
}

// Send an alert at most once per `every` minutes for the same `key`. Never throws.
export async function alert(env, key, subject, text, every = 60) {
  try {
    const fresh = await rpc(env, 'rate_hit', { p_kind: 'alert', p_key: key, p_limit: 1, p_minutes: every });
    if (fresh) await send(env, '[UnitStager] ' + subject, text);
  } catch (e) {
    console.error('alert failed', key, e && e.message);
  }
}

const usd = (n) => '$' + Number(n || 0).toFixed(2);

export async function dailySummary(env, extra = {}) {
  const s = (await rpc(env, 'period_stats', { p_hours: 24 })) || {};
  const hits = Object.entries(s.limit_hits || {}).map(([k, n]) => `  ${k.replace(/^hit:/, '')}: ${n}`).join('\n') || '  none';
  const revenue = (s.revenue_cents || 0) / 100;
  const text = `UnitStager — last 24 hours

Sign-ups:          ${s.new_accounts || 0}
Free credits:      ${s.free_credits || 0} (promo: ${s.promo_credits || 0})
Stagings:          ${s.stagings_done || 0} done, ${s.stagings_failed || 0} failed (refunded)
Image cost (est.): ${usd(s.cost_usd)}${s.avg_cost_usd != null ? ` (avg ${usd(s.avg_cost_usd)} per photo)` : ''}
Revenue:           ${usd(revenue)} from ${s.purchases || 0} purchase(s), before Stripe fees
Credits unused:    ${s.credits_unused || 0} across all accounts
Follow-up emails:  ${extra.nudged || 0} sent today

Limits hit:
${hits}

Limits and alert thresholds can be changed in Cloudflare (Worker → Settings →
Variables and Secrets); see docs/SETUP.md. ${SITE(env)}
`;
  await send(env, `[UnitStager] Daily summary: ${s.stagings_done || 0} stagings, ${usd(revenue)} revenue`, text);
  return s;
}
