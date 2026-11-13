// UnitStager account: sign-in, credits and purchases, via the UnitStager
// server. Runs in the service worker only, so there is exactly one place
// that refreshes the session.
(() => {
  const SAF = globalThis.SAF;

  const settings = async () => SAF.merge(await chrome.storage.local.get(null));
  const base = (s) => String(s.serverUrl || SAF.DEFAULTS.serverUrl).replace(/\/+$/, '');
  const fail = (message, code, status) => Object.assign(new Error(message), { code, status });

  async function request(s, path, { method = 'GET', body, token } = {}) {
    let res;
    try {
      res = await fetch(base(s) + path, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw fail("Can't reach the UnitStager server. Check your connection and try again.", 'network');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw fail((data && data.error) || `The UnitStager server returned an error (${res.status}).`, data && data.code, res.status);
    return data;
  }

  const toSession = (d, fallbackEmail) => ({
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: d.expires_at,
    email: (d.user && d.user.email) || fallbackEmail || '',
  });

  let refreshing = null;

  // A valid access token, refreshed first if it is about to expire.
  async function auth() {
    const s = await settings();
    const sess = s.session;
    if (!sess || !sess.access_token) throw fail('Sign in to UnitStager first.', 'auth');
    if (sess.expires_at - Date.now() / 1000 > 120) return { token: sess.access_token, serverUrl: base(s) };
    if (!refreshing) {
      refreshing = (async () => {
        try {
          const next = toSession(await request(s, '/api/auth/refresh', { method: 'POST', body: { refresh_token: sess.refresh_token } }), sess.email);
          await chrome.storage.local.set({ session: next });
          return next;
        } catch (e) {
          if (e.status === 401) await chrome.storage.local.set({ session: null });
          throw e.status === 401 ? fail('Your sign-in has expired. Sign in again in UnitStager settings.', 'auth') : e;
        } finally {
          refreshing = null;
        }
      })();
    }
    return { token: (await refreshing).access_token, serverUrl: base(s) };
  }

  SAF.account = {
    auth,
    async start({ email }) {
      await request(await settings(), '/api/auth/start', { method: 'POST', body: { email } });
      return true;
    },
    async verify({ email, code }) {
      const d = await request(await settings(), '/api/auth/verify', { method: 'POST', body: { email, code } });
      await chrome.storage.local.set({ session: toSession(d, email), credits: d.credits });
      return { email: (d.user && d.user.email) || email, credits: d.credits };
    },
    async me() {
      const { token } = await auth();
      const d = await request(await settings(), '/api/me', { token });
      await chrome.storage.local.set({ credits: d.credits });
      return d;
    },
    async checkout({ pack }) {
      const { token } = await auth();
      return (await request(await settings(), '/api/checkout', { method: 'POST', token, body: { pack } })).url;
    },
    async signOut() {
      await chrome.storage.local.set({ session: null, credits: null });
      return true;
    },
  };
})();
