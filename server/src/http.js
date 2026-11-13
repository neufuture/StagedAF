// Small HTTP helpers shared by the API modules.

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'X-Credits',
  'Access-Control-Max-Age': '86400',
};

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...headers } });

// Thrown anywhere in a handler; turned into a JSON error response by the router.
export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function readJson(request) {
  try {
    const body = await request.json();
    if (body && typeof body === 'object') return body;
  } catch {}
  throw new HttpError(400, 'Expected a JSON body.');
}

export function requireEnv(env, ...names) {
  for (const name of names) if (!env[name]) throw new HttpError(500, `Server is not configured (${name} is missing).`, 'config');
}
