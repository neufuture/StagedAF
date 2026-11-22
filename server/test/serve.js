// Runs the Worker under plain Node (no Cloudflare tooling), for tests and
// local development: node test/serve.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };

// Minimal stand-in for Cloudflare's static asset binding.
const ASSETS = {
  async fetch(request) {
    let p = decodeURIComponent(new URL(request.url).pathname);
    if (p.endsWith('/')) p += 'index.html';
    let file = path.join(publicDir, p);
    if (!file.startsWith(publicDir)) return new Response('Not found', { status: 404 });
    if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return new Response('Not found', { status: 404 });
    return new Response(fs.readFileSync(file), { headers: { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' } });
  },
};

// In-memory stand-in for an R2 bucket binding.
export function memoryBucket() {
  const files = new Map();
  const toBytes = async (v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(await new Response(v).arrayBuffer()));
  return {
    files,
    async put(key, value, opts = {}) {
      files.set(key, { bytes: await toBytes(value), httpMetadata: opts.httpMetadata || {} });
    },
    async get(key) {
      const f = files.get(key);
      if (!f) return null;
      return { httpMetadata: f.httpMetadata, get body() { return new Response(f.bytes).body; }, arrayBuffer: async () => f.bytes.slice().buffer, text: async () => new TextDecoder().decode(f.bytes) };
    },
    async delete(keys) {
      for (const k of [].concat(keys)) files.delete(k);
    },
  };
}

export async function serve(env, port = 0) {
  const background = new Set(); // work the Worker asked to finish after replying
  const ctx = {
    waitUntil(p) {
      const tracked = Promise.resolve(p).catch(() => {}).finally(() => background.delete(tracked));
      background.add(tracked);
    },
  };
  // In-memory stand-ins for the R2 bucket and the queue. Queued messages are
  // delivered to the Worker's queue() handler shortly after they are sent,
  // with ack / retry / attempts like the real thing (retries come back fast).
  const PHOTOS = env.PHOTOS || memoryBucket();
  const fullEnv = () => ({ ASSETS, PHOTOS, STAGING_QUEUE, ...env });
  const deliver = (body, attempts) => {
    const run = (async () => {
      await new Promise((r) => setTimeout(r, 20));
      let outcome = 'ack';
      let delay = 0;
      const msg = { id: crypto.randomUUID(), body, attempts, ack: () => (outcome = 'ack'), retry: (o = {}) => ((outcome = 'retry'), (delay = o.delaySeconds || 0)) };
      try {
        await worker.queue({ messages: [msg] }, fullEnv());
      } catch {
        outcome = 'retry';
      }
      if (outcome === 'retry' && attempts < 4) setTimeout(() => deliver(body, attempts + 1), Math.min(200, delay * 5));
    })();
    ctx.waitUntil(run);
  };
  const STAGING_QUEUE = env.STAGING_QUEUE || { sent: [], async send(body) { this.sent.push(body); deliver(body, 1); } };
  const server = http.createServer(async (req, res) => {
    try {
      const hasBody = !['GET', 'HEAD'].includes(req.method);
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: 'half' });
      const response = await worker.fetch(request, fullEnv(), ctx);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).pipe(res);
      else res.end();
    } catch (e) {
      console.error(e);
      res.writeHead(500).end('adapter error');
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const idle = async () => {
    // Keep waiting while finishing work schedules more (queue retries, top-ups).
    for (let i = 0; i < 50; i++) {
      if (!background.size) await new Promise((r) => setTimeout(r, 250));
      if (!background.size) return;
      await Promise.all([...background]);
    }
  };
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close(),
    idle,
    photos: PHOTOS,
    queue: STAGING_QUEUE,
    cron: () => worker.scheduled({ cron: 'test', scheduledTime: Date.now() }, fullEnv(), ctx),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await serve(process.env, Number(process.env.PORT) || 8787);
  console.log('UnitStager server on ' + url);
}
