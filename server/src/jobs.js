// Background staging. The upload is stored in R2 and a message is queued;
// the queue consumer (runJob) calls the image service and stores the result
// in R2, so staging finishes even if the customer closes the page. Results
// are kept for 30 days (cleanup runs hourly from the cron trigger).
//
//   POST   /api/jobs              multipart photo      -> {id, credits}   (1 credit)
//   GET    /api/jobs                                   -> the last 30 days' stagings
//   GET    /api/jobs/<id>/result                       -> the staged image (JSON, base64)
//   DELETE /api/jobs/<id>                              delete a finished staging
import { CORS, HttpError, json, requireEnv } from './http.js';
import { buildPrompt } from './prompt.js';
import { callImageModel, describeFailure, readUpload } from './stage.js';
import { maybeAutoTopUp } from './stripe.js';
import { alert } from './alerts.js';
import { rpc } from './supabase.js';

export const KEEP_DAYS = 30;
const STALE_MINUTES = 20;
const MAX_ATTEMPTS = 3;

const keyIn = (userId, id) => `stagings/${userId}/${id}/original.jpg`;
const keyOut = (userId, id) => `stagings/${userId}/${id}/staged.json`;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function requireStorage(env) {
  requireEnv(env, 'OPENAI_API_KEY');
  if (!env.PHOTOS || !env.STAGING_QUEUE) throw new HttpError(500, 'Server is not configured (photo storage or queue is missing).', 'config');
}

export async function createJob(request, env, user, ctx) {
  requireStorage(env);
  // Optional safety cap on stagings per day (DAILY_STAGING_CAP; off unless set).
  const cap = Number(env.DAILY_STAGING_CAP) || 0;
  if (cap > 0) {
    const today = (await rpc(env, 'usage_today', {}).catch(() => null)) || {};
    if (today.stagings >= cap) {
      await alert(env, 'daily-cap', 'Daily staging cap reached', `UnitStager has reached its daily cap of ${cap} stagings and is turning new stagings away until midnight UTC.\n\nRaise or remove DAILY_STAGING_CAP in Cloudflare (Worker → Settings → Variables and Secrets) if this is real demand.`, 720);
      throw new HttpError(503, 'UnitStager is very busy right now. Please try again later today.', 'busy');
    }
  }
  const up = await readUpload(request);
  const id = crypto.randomUUID();
  // Store the photo first: if the credit can't be taken, it's simply deleted.
  await env.PHOTOS.put(keyIn(user.id, id), await up.image.arrayBuffer(), { httpMetadata: { contentType: up.image.type } });
  let credits;
  try {
    credits = await rpc(env, 'create_staging', {
      p_user: user.id, p_id: id, p_name: up.name, p_room: up.room, p_style: up.style, p_custom: up.custom, p_width: up.width, p_height: up.height, p_label: up.label,
      p_property_id: up.place.property_id, p_property: up.place.property, p_unit_id: up.place.unit_id, p_unit: up.place.unit,
    });
  } catch (e) {
    await env.PHOTOS.delete(keyIn(user.id, id)).catch(() => {});
    throw e;
  }
  if (!(credits >= 0)) {
    await env.PHOTOS.delete(keyIn(user.id, id)).catch(() => {});
    throw new HttpError(402, "You're out of credits.", 'no-credits');
  }
  try {
    await env.STAGING_QUEUE.send({ id, user: user.id });
  } catch (e) {
    console.error('queue send failed', id, e && e.message);
    await rpc(env, 'finish_staging', { p_id: id, p_ok: false, p_error: "Couldn't start staging. Your credit was returned — try again." }).catch(() => {});
    await env.PHOTOS.delete(keyIn(user.id, id)).catch(() => {});
    throw new HttpError(502, "Couldn't start staging. Your credit was returned — try again.", 'upstream');
  }
  const topUp = maybeAutoTopUp(env, user, credits);
  if (ctx && ctx.waitUntil) ctx.waitUntil(topUp);
  return json({ id, credits }, 202, { 'X-Credits': String(credits) });
}

export async function listJobs(env, user) {
  const rows = (await rpc(env, 'list_stagings', { p_user: user.id, p_days: KEEP_DAYS })) || [];
  const expires = (d) => new Date(new Date(d).getTime() + KEEP_DAYS * 86400000).toISOString();
  return json({ keep_days: KEEP_DAYS, stagings: rows.map((r) => ({ ...r, expires_at: expires(r.created_at) })) });
}

export async function jobResult(env, user, id) {
  if (!ID.test(id)) throw new HttpError(404, 'Not found.');
  const status = await rpc(env, 'staging_status', { p_user: user.id, p_id: id });
  if (status !== 'done') throw new HttpError(404, status ? 'That staging is not finished.' : 'Not found.');
  const obj = await env.PHOTOS.get(keyOut(user.id, id));
  if (!obj) throw new HttpError(410, 'This staged photo is no longer stored.', 'expired');
  return new Response(obj.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=3600', ...CORS } });
}

export async function deleteJob(env, user, id) {
  if (!ID.test(id)) throw new HttpError(404, 'Not found.');
  const gone = await rpc(env, 'delete_staging', { p_user: user.id, p_id: id });
  if (!gone) throw new HttpError(409, "That staging can't be deleted while it is running.");
  await env.PHOTOS.delete([keyIn(user.id, id), keyOut(user.id, id)]);
  return json({ deleted: true });
}

// ---- queue consumer ----------------------------------------------------------

const transient = (out) => out.status === 429 || out.status >= 500;

// ---- cost tracking ----------------------------------------------------------

// The image service reports token usage at the end of its (large) JSON reply.
// Read just the tail, so the multi-megabyte image never has to be parsed.
export function readUsage(buf) {
  const bytes = new Uint8Array(buf);
  const tail = new TextDecoder().decode(bytes.subarray(Math.max(0, bytes.length - 8192)));
  const at = tail.lastIndexOf('"usage"');
  if (at < 0) return null;
  const start = tail.indexOf('{', at);
  let depth = 0;
  for (let i = start; i >= 0 && i < tail.length; i++) {
    if (tail[i] === '{') depth++;
    else if (tail[i] === '}' && --depth === 0) {
      try {
        return JSON.parse(tail.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Estimated cost in USD from token usage. Prices per million tokens can be
// changed with PRICE_TEXT_INPUT_PER_M, PRICE_IMAGE_INPUT_PER_M and
// PRICE_IMAGE_OUTPUT_PER_M; the defaults are published GPT Image rates.
export function estimateCost(env, usage) {
  const p = (name, def) => Number(env[name]) || def;
  const details = usage.input_tokens_details || {};
  const imageIn = details.image_tokens ?? 0;
  const textIn = details.text_tokens ?? Math.max(0, (usage.input_tokens || 0) - imageIn);
  const out = usage.output_tokens || 0;
  return (textIn * p('PRICE_TEXT_INPUT_PER_M', 5) + imageIn * p('PRICE_IMAGE_INPUT_PER_M', 8) + out * p('PRICE_IMAGE_OUTPUT_PER_M', 30)) / 1e6;
}

async function recordCost(env, id, body) {
  try {
    const usage = readUsage(body);
    if (!usage) return;
    const cost = Math.round(estimateCost(env, usage) * 10000) / 10000;
    await rpc(env, 'record_staging_usage', { p_id: id, p_input: usage.input_tokens || 0, p_output: usage.output_tokens || 0, p_cost: cost });
    const limit = Number(env.ALERT_DAILY_COST_USD) || 25;
    const today = (await rpc(env, 'usage_today', {})) || {};
    if (Number(today.cost_usd) >= limit) {
      await alert(env, 'daily-cost', `Image spend today passed $${limit}`, `Estimated image-service spend since midnight UTC is $${Number(today.cost_usd).toFixed(2)} across ${today.stagings} stagings.\n\nThis is just a heads-up. Change the threshold with ALERT_DAILY_COST_USD, or set DAILY_STAGING_CAP to stop new stagings after a number per day (Cloudflare → Worker → Settings → Variables and Secrets).`, 720);
    }
  } catch (e) {
    console.error('cost tracking failed', id, e && e.message);
  }
}

async function fail(env, job, message) {
  await rpc(env, 'finish_staging', { p_id: job.id, p_ok: false, p_error: message });
  await env.PHOTOS.delete(keyIn(job.user_id, job.id)).catch(() => {});
}

export async function runJob(msg, env) {
  const { id } = msg.body || {};
  const job = ID.test(id || '') ? await rpc(env, 'start_staging', { p_id: id }) : null;
  if (!job) return msg.ack(); // unknown, or already finished
  try {
    const obj = await env.PHOTOS.get(keyIn(job.user_id, id));
    if (!obj) {
      await fail(env, job, 'The uploaded photo was missing. Your credit was returned — try again.');
      return msg.ack();
    }
    const image = new Blob([await obj.arrayBuffer()], { type: (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg' });
    const prompt = buildPrompt({ room: job.room, style: job.style, custom: job.custom });
    let out;
    try {
      out = await callImageModel(env, { image, prompt, width: job.width || 1536, height: job.height || 1024 });
    } catch (e) {
      out = { ok: false, status: 503, message: 'unreachable: ' + (e && e.message) };
    }
    if (!out.ok) {
      console.error('image service error', id, out.status, out.code, out.message, 'attempt', msg.attempts);
      if (transient(out) && msg.attempts < MAX_ATTEMPTS) return msg.retry({ delaySeconds: 15 * msg.attempts });
      await fail(env, job, describeFailure(out).message);
      if (describeFailure(out).code !== 'declined') {
        await alert(env, 'staging-failed', 'Stagings are failing', `A staging failed after retries: the image service answered ${out.status} ${out.code || ''} ${String(out.message || '').slice(0, 300)}\n\nCredits are refunded automatically. Check the Worker's Observability logs, and your OpenAI account (billing, limits, key).\n\nAt most one of these per hour.`);
      }
      return msg.ack();
    }
    // Store the service's JSON as-is (base64 image inside); the browser decodes it.
    const body = await out.res.arrayBuffer();
    await env.PHOTOS.put(keyOut(job.user_id, id), body, { httpMetadata: { contentType: 'application/json' } });
    await rpc(env, 'finish_staging', { p_id: id, p_ok: true, p_error: null });
    await recordCost(env, id, body);
    await env.PHOTOS.delete(keyIn(job.user_id, id)).catch(() => {});
    msg.ack();
  } catch (e) {
    console.error('staging job crashed', id, e && e.stack);
    if (msg.attempts < MAX_ATTEMPTS) return msg.retry({ delaySeconds: 30 });
    await fail(env, job, 'Staging failed on our side. Your credit was returned — try again.').catch(() => {});
    msg.ack();
  }
}

// ---- hourly cleanup ----------------------------------------------------------

export async function cleanup(env) {
  const stale = (await rpc(env, 'fail_stale_stagings', { p_minutes: STALE_MINUTES })) || [];
  const old = (await rpc(env, 'purge_stagings', { p_days: KEEP_DAYS })) || [];
  const keys = [...stale.map((r) => keyIn(r.user_id, r.id)), ...old.flatMap((r) => [keyIn(r.user_id, r.id), keyOut(r.user_id, r.id)])];
  for (let i = 0; i < keys.length; i += 1000) await env.PHOTOS.delete(keys.slice(i, i + 1000));
  await rpc(env, 'trim_rate_events', {}).catch(() => {});
  if (stale.length || old.length) console.log('cleanup: failed', stale.length, 'stuck, purged', old.length, 'expired');
  return { stale: stale.length, purged: old.length };
}
