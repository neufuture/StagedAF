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

export async function serve(env, port = 0) {
  const server = http.createServer(async (req, res) => {
    try {
      const hasBody = !['GET', 'HEAD'].includes(req.method);
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: 'half' });
      const response = await worker.fetch(request, { ASSETS, ...env });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).pipe(res);
      else res.end();
    } catch (e) {
      console.error(e);
      res.writeHead(500).end('adapter error');
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await serve(process.env, Number(process.env.PORT) || 8787);
  console.log('UnitStager server on ' + url);
}
