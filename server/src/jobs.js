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
  const up = await readUpload(request);
  const id = crypto.randomUUID();
  // Store the photo first: if the credit can't be taken, it's simply deleted.
  await env.PHOTOS.put(keyIn(user.id, id), await up.image.arrayBuffer(), { httpMetadata: { contentType: up.image.type } });
  const credits = await rpc(env, 'create_staging', {
    p_user: user.id, p_id: id, p_name: up.name, p_room: up.room, p_style: up.style, p_custom: up.custom, p_width: up.width, p_height: up.height, p_label: up.label,
  });
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
      return msg.ack();
    }
    // Store the service's JSON as-is (base64 image inside); the browser decodes it.
    await env.PHOTOS.put(keyOut(job.user_id, id), await out.res.arrayBuffer(), { httpMetadata: { contentType: 'application/json' } });
    await rpc(env, 'finish_staging', { p_id: id, p_ok: true, p_error: null });
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
  if (stale.length || old.length) console.log('cleanup: failed', stale.length, 'stuck, purged', old.length, 'expired');
  return { stale: stale.length, purged: old.length };
}
