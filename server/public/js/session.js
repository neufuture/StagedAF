// Website sign-in, shared by the studio and account pages. The session lives
// in this browser's localStorage; access tokens are refreshed when they near
// expiry. Talks to the same /api the extension uses.
(() => {
  const KEY = 'unitstager.session';
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || null;
    } catch {
      return null;
    }
  };
  const write = (s) => {
    try {
      if (s) localStorage.setItem(KEY, JSON.stringify(s));
      else localStorage.removeItem(KEY);
    } catch {}
  };
  const fail = (message, code, status) => Object.assign(new Error(message), { code, status });

  async function request(path, { method = 'GET', body, token, form } = {}) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: form || (body ? JSON.stringify(body) : undefined),
      });
    } catch {
      throw fail("Can't reach UnitStager. Check your connection and try again.", 'network');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw fail((data && data.error) || `Something went wrong (${res.status}).`, data && data.code, res.status);
    return { data, res };
  }

  let refreshing = null;
  async function token() {
    const s = read();
    if (!s) throw fail('Please sign in.', 'auth');
    if (s.expires_at - Date.now() / 1000 > 120) return s.access_token;
    if (!refreshing) {
      refreshing = request('/api/auth/refresh', { method: 'POST', body: { refresh_token: s.refresh_token } })
        .then(({ data }) => {
          write({ ...s, access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_at });
          return data.access_token;
        })
        .catch((e) => {
          if (e.status === 401) write(null);
          throw e.status === 401 ? fail('Your sign-in has expired. Please sign in again.', 'auth') : e;
        })
        .finally(() => (refreshing = null));
    }
    return refreshing;
  }

  window.US = {
    session: read,
    signedIn: () => !!read(),
    async start(email) {
      await request('/api/auth/start', { method: 'POST', body: { email } });
    },
    async verify(email, code) {
      const { data } = await request('/api/auth/verify', { method: 'POST', body: { email, code } });
      write({ access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_at, email: (data.user && data.user.email) || email });
      return data;
    },
    signOut() {
      write(null);
    },
    // Authenticated call. Returns {data, res}.
    async api(path, opts = {}) {
      return request(path, { ...opts, token: await token() });
    },
  };

  // Header: show who is signed in, and a sign-out link, on pages that have one.
  document.addEventListener('DOMContentLoaded', () => {
    const out = document.getElementById('signOut');
    if (out) {
      out.hidden = !read();
      out.addEventListener('click', (e) => {
        e.preventDefault();
        write(null);
        location.href = '/app.html';
      });
    }
  });
})();
