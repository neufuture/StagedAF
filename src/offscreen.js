// Offscreen document: runs the staging requests. Content scripts connect with
// a port named "saf-stage", post one {type:'run'} message and get back
// {type:'done', dataUrl, inputDataUrl, credits} or {type:'error', error, code}.
(() => {
  const SAF = globalThis.SAF;

  const fail = (message, code) => Object.assign(new Error(message), { code });

  async function ask(msg, fallback) {
    const res = await chrome.runtime.sendMessage(msg);
    if (!res || !res.ok) throw fail((res && res.error) || fallback, res && res.code);
    return res.value;
  }

  async function loadSource(source, signal) {
    if (source.dataUrl) return SAF.dataUrlToBlob(source.dataUrl);
    let res;
    try {
      res = await fetch(source.url, { credentials: 'include', signal });
    } catch {
      try {
        res = await fetch(source.url, { credentials: 'omit', signal });
      } catch {
        throw fail('Could not download the original photo.', 'fetch-source');
      }
    }
    if (!res.ok) throw fail(`Could not download the original photo (HTTP ${res.status}).`, 'fetch-source');
    return res.blob();
  }

  // The UnitStager server stages the photo and takes one credit.
  async function callServer(job, image, signal) {
    const auth = await ask({ type: 'saf:get-auth' }, 'Sign in to UnitStager first.');
    const form = new FormData();
    form.append('image', image.blob, 'photo.jpg');
    form.append('room', job.room || 'auto');
    form.append('style', job.style || 'modern');
    form.append('custom', job.custom || '');
    form.append('width', String(image.width));
    form.append('height', String(image.height));
    let res;
    try {
      res = await fetch(auth.serverUrl + '/api/stage', { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token }, body: form, signal });
    } catch {
      if (signal.aborted) throw fail('Cancelled.', 'cancelled');
      throw fail("Can't reach the UnitStager server. Check your connection and try again.", 'network');
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw fail((body && body.error) || `The UnitStager server returned an error (${res.status}).`, (body && body.code) || (res.status === 401 ? 'auth' : undefined));
    const item = body && body.data && body.data[0];
    if (!item || !item.b64_json) throw fail('The server returned no image.');
    const credits = Number(res.headers.get('X-Credits'));
    return { dataUrl: 'data:image/jpeg;base64,' + item.b64_json, credits: Number.isFinite(credits) ? credits : undefined };
  }

  async function run(job, signal) {
    const settings = await ask({ type: 'saf:get-settings' }, 'Could not load UnitStager settings.');
    if (!settings.session) throw fail('Sign in to UnitStager first.', 'auth');
    const raw = await loadSource(job.source, signal);
    const image = await SAF.normalizeImage(raw, Number(settings.maxInputEdge) || 2048);
    const out = await callServer(job, image, signal);
    return { ...out, inputDataUrl: job.wantInput ? await SAF.blobToDataUrl(image.blob) : undefined };
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'saf-stage') return;
    const ctl = new AbortController();
    let open = true;
    port.onDisconnect.addListener(() => {
      open = false;
      ctl.abort();
    });
    port.onMessage.addListener((msg) => {
      if (!msg || msg.type !== 'run') return;
      run(msg.job, ctl.signal)
        .then((out) => open && port.postMessage({ type: 'done', ...out }))
        .catch((e) => open && port.postMessage({ type: 'error', error: String((e && e.message) || e), code: e && e.code }));
    });
  });
})();
