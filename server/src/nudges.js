// Follow-up emails to customers who signed up but haven't staged, ran out of
// credits, or went quiet (see nudge_candidates in schema.sql). Sent once per
// kind per account, from the daily cron, through Resend. Every email has an
// unsubscribe link and the business's postal address (US CAN-SPAM).
//
// Needs RESEND_API_KEY and BUSINESS_ADDRESS (a postal address or PO box);
// without either, nothing is sent. NUDGES=off stops them entirely.
import { HttpError } from './http.js';
import { rpc } from './supabase.js';

const MAX_PER_DAY = 150;
const site = (env) => String(env.SITE_URL || 'https://unitstager.com').replace(/\/+$/, '');
const enc = new TextEncoder();

async function hmac(env, text) {
  const secret = String(env.EMAIL_LINK_SECRET || env.SUPABASE_SECRET_KEY || '');
  if (!secret) throw new Error('no signing secret');
  const key = await crypto.subtle.importKey('raw', enc.encode('unsubscribe:' + secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
  return [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function unsubscribeUrl(env, userId) {
  return `${site(env)}/api/unsubscribe?u=${userId}&t=${await hmac(env, userId)}`;
}

const link = (env, path, campaign) => `${site(env)}${path}${path.includes('?') ? '&' : '?'}utm_source=email&utm_medium=followup&utm_campaign=${campaign}`;

// The four messages. Plain, short, one link each.
function compose(env, c) {
  const studio = link(env, '/app.html', c.kind);
  const account = link(env, '/account.html', c.kind);
  const n = c.credits;
  switch (c.kind) {
    case 'stage-1':
      return { subject: `Your ${n} free staged photos are waiting`, intro: `You signed up for UnitStager but haven't staged a photo yet. Your ${n} free credits are ready.`, body: 'Drop in a photo of an empty room, pick a style, and in about a minute you get a furnished version to compare side by side. Walls, floors and windows stay as they are.', cta: 'Stage a photo', url: studio };
    case 'stage-4':
      return { subject: 'Try UnitStager on your next vacancy', intro: `Still have an empty unit to list? You have ${n} free staged photos on your account.`, body: 'Property managers use UnitStager to furnish vacant-unit photos before they go on the listing. If you use AppFolio, the browser extension does it right on the unit page.', cta: 'Open the Studio', url: studio };
    case 'buy-2':
      return { subject: "You've used your free photos", intro: "You've used all your UnitStager credits. Hope the staged photos helped.", body: 'Credit packs start at 25 photos for $19, and the larger packs save up to 22%. Credits never expire, and auto top-up can refill them for you when you run low.', cta: 'Get more credits', url: account };
    case 'return-30':
      return { subject: 'Have a vacancy coming up?', intro: "It's been about a month since you last staged a photo with UnitStager.", body: n > 0 ? `You still have ${n} credits. New listings go out faster with furnished photos; there are eight styles to choose from, from Scandinavian to Industrial.` : 'New listings go out faster with furnished photos; there are eight styles to choose from, from Scandinavian to Industrial.', cta: 'Stage a photo', url: studio };
  }
  return null;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function render(env, m, unsub) {
  const address = String(env.BUSINESS_ADDRESS);
  const text = `${m.intro}\n\n${m.body}\n\n${m.cta}: ${m.url}\n\nQuestions? Just reply to this email.\n\n—\nUnitStager, by Neufuture, LLC · ${address}\nDon't want these emails? Unsubscribe: ${unsub}\n`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#ffffff;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#16171a;font-size:16px;line-height:1.55">
<div style="max-width:520px;margin:0 auto">
<p style="font-weight:800;font-size:18px;margin:0 0 20px">Unit<span style="color:#4f46e5">Stager</span></p>
<p style="margin:0 0 14px">${esc(m.intro)}</p>
<p style="margin:0 0 22px;color:#5d6068">${esc(m.body)}</p>
<p style="margin:0 0 26px"><a href="${esc(m.url)}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:10px">${esc(m.cta)}</a></p>
<p style="margin:0 0 28px;color:#5d6068">Questions? Just reply to this email.</p>
<p style="margin:0;font-size:12.5px;color:#8a8d94;border-top:1px solid #e6e7ea;padding-top:14px">UnitStager, by Neufuture, LLC · ${esc(address)}<br><a href="${esc(unsub)}" style="color:#8a8d94">Unsubscribe</a> from these emails.</p>
</div></body></html>`;
  return { text, html };
}

// Send today's follow-ups. Returns how many were sent.
export async function sendNudges(env) {
  if (String(env.NUDGES).toLowerCase() === 'off') return 0;
  if (!env.RESEND_API_KEY || !env.BUSINESS_ADDRESS) {
    console.log('follow-up emails skipped: RESEND_API_KEY and BUSINESS_ADDRESS are both needed');
    return 0;
  }
  const list = (await rpc(env, 'nudge_candidates', { p_limit: MAX_PER_DAY })) || [];
  let sent = 0;
  for (const c of list) {
    const m = compose(env, c);
    if (!m || !c.email) continue;
    if (!(await rpc(env, 'mark_nudge', { p_user: c.user_id, p_kind: c.kind }))) continue; // already sent
    const unsub = await unsubscribeUrl(env, c.user_id);
    const { text, html } = render(env, m, unsub);
    const res = await fetch(String(env.RESEND_BASE || 'https://api.resend.com').replace(/\/+$/, '') + '/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + String(env.RESEND_API_KEY).trim(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.NUDGE_FROM || 'UnitStager <hello@unitstager.com>',
        reply_to: env.NUDGE_REPLY_TO || 'hello@unitstager.com',
        to: [c.email],
        subject: m.subject,
        text,
        html,
        headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        tags: [{ name: 'kind', value: c.kind.replace(/[^\w-]/g, '_') }],
      }),
    }).catch(() => ({ ok: false, status: 0 }));
    if (res.ok) sent++;
    else console.error('follow-up email failed', c.kind, res.status);
  }
  if (list.length) console.log('follow-up emails sent:', sent, 'of', list.length);
  return sent;
}

// GET shows a confirmation page; POST is the one-click unsubscribe mail apps use.
export async function unsubscribe(request, env) {
  const url = new URL(request.url);
  const u = url.searchParams.get('u') || '';
  const t = url.searchParams.get('t') || '';
  const ok = /^[0-9a-f-]{36}$/.test(u) && t.length === 32 && t === (await hmac(env, u));
  if (!ok) throw new HttpError(400, 'That unsubscribe link is not valid.');
  await rpc(env, 'set_emails_off', { p_user: u });
  if (request.method === 'POST') return new Response(null, { status: 204 });
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Unsubscribed – UnitStager</title><link rel="stylesheet" href="/style.css"></head><body><div class="wrap"><div class="prose"><h1>You're unsubscribed</h1><p>You won't get any more follow-up emails from UnitStager. Sign-in codes and receipts still arrive when you ask for them.</p><p><a href="/">Back to UnitStager</a></p></div></div></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }
  );
}
