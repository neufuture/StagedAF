// Runs Turnstile inside the extension's settings page (embedded as a frame)
// and posts the token to that page. Only extension pages may embed this page
// (see _headers), and the token is only good for one sign-in request.
(() => {
  const parentOrigin = (() => {
    try {
      return new URL(document.referrer).origin;
    } catch {
      return '';
    }
  })();
  const toParent = (msg) => parent.postMessage({ source: 'unitstager-verify', ...msg }, parentOrigin && /^(chrome|moz|ms-browser)-extension:/.test(parentOrigin) ? parentOrigin : '*');
  const size = () => toParent({ type: 'size', height: document.body.scrollHeight });
  (async () => {
    let check;
    try {
      check = await US_TURNSTILE.mount(document.getElementById('ts'));
    } catch {
      return toParent({ type: 'token', token: '' });
    }
    const send = async () => toParent({ type: 'token', token: await check.token(15000) });
    addEventListener('message', (e) => {
      if (e.source === parent && e.data && e.data.type === 'reset') {
        check.reset();
        send();
      }
    });
    new ResizeObserver(size).observe(document.body);
    send();
  })();
})();
