// Stand-in for https://challenges.cloudflare.com/turnstile/v0/api.js in
// browser tests: "passes" every check with Cloudflare's dummy test token.
window.turnstile = {
  widgets: {},
  n: 0,
  render(el, opts) {
    const id = 'w' + ++this.n;
    this.widgets[id] = opts;
    el.setAttribute('data-fake-turnstile', id);
    setTimeout(() => opts.callback('XXXX.DUMMY.TOKEN.XXXX'), 100);
    return id;
  },
  reset(id) {
    const o = this.widgets[id];
    if (o) setTimeout(() => o.callback('XXXX.DUMMY.TOKEN.XXXX'), 100);
  },
  remove() {},
};
