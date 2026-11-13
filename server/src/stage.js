// POST /api/stage — spend one credit, stage one photo, refund on failure.
import { CORS, HttpError, requireEnv } from './http.js';
import { buildPrompt } from './prompt.js';
import { addCredits, spendCredit } from './supabase.js';

const MAX_BYTES = 12 * 1024 * 1024;
const STANDARD = [[1536, 1024], [1024, 1536], [1024, 1024]];

function standardSize(w, h) {
  const r = w / h;
  let best = STANDARD[0];
  for (const s of STANDARD) if (Math.abs(Math.log(s[0] / s[1] / r)) < Math.abs(Math.log(best[0] / best[1] / r))) best = s;
  return best.join('x');
}

// Newer GPT Image models accept any size whose sides are multiples of 16, so
// the result can keep the photo's aspect ratio; older ones take three sizes.
function matchedSize(w, h) {
  const r = Math.min(3, Math.max(1 / 3, w / h));
  const round16 = (n) => Math.max(256, Math.round(n / 16) * 16);
  return r >= 1 ? `1536x${round16(1536 / r)}` : `${round16(1536 * r)}x1536`;
}

const quirks = new Map(); // model -> what it rejected, remembered while this instance lives

async function callImageModel(env, { image, prompt, width, height }) {
  const model = env.OPENAI_MODEL || 'gpt-image-2';
  const learned = quirks.get(model) || { drop: new Set(), standardSize: false };
  quirks.set(model, learned);
  const fields = {
    model,
    prompt,
    n: '1',
    size: learned.standardSize || /^gpt-image-1/.test(model) ? standardSize(width, height) : matchedSize(width, height),
    quality: env.OPENAI_QUALITY || 'high',
    output_format: 'jpeg',
    input_fidelity: 'high',
  };
  for (const k of learned.drop) delete fields[k];

  const base = String(env.OPENAI_BASE || 'https://api.openai.com/v1').replace(/\/+$/, '');
  let last = { status: 502, message: 'The image service rejected the request.' };
  for (let attempt = 0; attempt < 5; attempt++) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('image', image, 'photo.jpg');
    const res = await fetch(base + '/images/edits', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY },
      body: form,
      signal: AbortSignal.timeout(280000),
    });
    if (res.ok) return { ok: true, res };
    let err = {};
    try {
      err = (await res.json()).error || {};
    } catch {}
    last = { status: res.status, message: err.message || `HTTP ${res.status}`, code: err.code, type: err.type };
    if (res.status !== 400) break;
    // Models differ in the optional parameters they accept: drop what this one rejects and retry.
    const param = err.param || (/(input_fidelity|output_format|quality|size)/.exec(last.message) || [])[1];
    if (param === 'size' && fields.size !== standardSize(width, height)) {
      fields.size = standardSize(width, height);
      learned.standardSize = true;
    } else if (param && param in fields && !['model', 'prompt'].includes(param)) {
      delete fields[param];
      learned.drop.add(param);
    } else break;
  }
  return { ok: false, ...last };
}

export async function stage(request, env, user) {
  requireEnv(env, 'OPENAI_API_KEY');
  let form;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, 'Expected a photo upload.');
  }
  const image = form.get('image');
  if (!image || typeof image === 'string') throw new HttpError(400, 'No photo was sent.');
  if (image.size > MAX_BYTES) throw new HttpError(413, 'That photo is too large.');
  if (!/^image\/(jpeg|png|webp)$/.test(image.type)) throw new HttpError(415, 'Photos must be JPEG, PNG or WebP.');
  const width = Math.min(8192, Math.max(1, parseInt(form.get('width'), 10) || 1536));
  const height = Math.min(8192, Math.max(1, parseInt(form.get('height'), 10) || 1024));
  const prompt = buildPrompt({ room: form.get('room'), style: form.get('style'), custom: form.get('custom') });

  const job = crypto.randomUUID();
  const credits = await spendCredit(env, user.id, 'stage:' + job);
  if (!(credits >= 0)) throw new HttpError(402, "You're out of credits.", 'no-credits');

  const refund = () => addCredits(env, user.id, 1, 'refund', 'refund:' + job).catch((e) => console.error('REFUND FAILED', user.id, job, e && e.message));

  let out;
  try {
    out = await callImageModel(env, { image, prompt, width, height });
  } catch (e) {
    await refund();
    console.error('image service unreachable', e && e.message);
    throw new HttpError(502, 'The image service did not answer. Your credit was returned — try again.', 'upstream');
  }
  if (!out.ok) {
    await refund();
    console.error('image service error', out.status, out.code, out.message);
    const declined = out.status === 400 && /moderation|safety|content.policy/i.test(`${out.code} ${out.type} ${out.message}`);
    throw new HttpError(
      declined ? 422 : 502,
      declined ? 'The image service declined this photo or these instructions. Your credit was returned.' : 'Staging failed on our side. Your credit was returned — try again.',
      declined ? 'declined' : 'upstream'
    );
  }
  // Pass the image service's response straight through (it can be several
  // megabytes); the remaining balance rides along in a header.
  return new Response(out.res.body, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Credits': String(credits), ...CORS } });
}
