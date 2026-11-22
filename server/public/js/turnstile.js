// Cloudflare Turnstile on the sign-in form. Loads only if the server has a
// site key configured; normally invisible, it only asks the visitor to do
// something if Cloudflare is unsure. US_TURNSTILE.mount(el) -> {token(), reset()}.
(() => {
  let config = null;
  let scriptLoad = null;
  const getConfig = () => (config = config || fetch('/api/config').then((r) => r.json()).catch(() => ({})));
  const loadScript = () =>
    (scriptLoad = scriptLoad || new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = () => resolve(window.turnstile);
      s.onerror = () => reject(new Error('Turnstile could not load'));
      document.head.append(s);
    }));

  window.US_TURNSTILE = {
    async mount(el) {
      let token = '';
      let waiters = [];
      let widget = null;
      const settle = (t) => {
        token = t || '';
        waiters.forEach((w) => w(token));
        waiters = [];
      };
      try {
        const { turnstile_site_key: sitekey } = await getConfig();
        if (sitekey) {
          const ts = await loadScript();
          widget = ts.render(el, {
            sitekey,
            appearance: 'interaction-only',
            size: 'flexible',
            callback: settle,
            'expired-callback': () => (token = ''),
            'error-callback': () => settle(''),
          });
        }
      } catch {}
      return {
        // The current token, waiting up to `ms` for the check to finish.
        token(ms = 6000) {
          if (token || !widget) return Promise.resolve(token);
          return new Promise((resolve) => {
            waiters.push(resolve);
            setTimeout(() => resolve(token), ms);
          });
        },
        // Tokens work once; get a fresh one after each use.
        reset() {
          token = '';
          if (widget && window.turnstile) window.turnstile.reset(widget);
        },
      };
    },
  };
})();
