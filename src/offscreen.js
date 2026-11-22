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

  // Original photos are only ever fetched from AppFolio (over HTTPS).
  const fromAppFolio = (u) => {
    try {
      const url = new URL(u);
      return url.protocol === 'https:' && (url.hostname === 'appfolio.com' || url.hostname.endsWith('.appfolio.com'));
    } catch {
      return false;
    }
  };

  async function loadSource(source, signal) {
    if (source.dataUrl) return SAF.dataUrlToBlob(source.dataUrl);
    if (!fromAppFolio(source.url)) throw fail('UnitStager only reads photos from AppFolio.', 'fetch-source');
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

  // The UnitStager server stages the photo in the background and takes one
  // credit: submit the job, wait for it to finish, then fetch the result. If
  // this page goes away first, the staging still finishes and is kept for 30
  // days under "Recent stagings" on unitstager.com.
  async function callServer(job, image, signal) {
    const call = async (path, init = {}) => {
      const auth = await ask({ type: 'saf:get-auth' }, 'Sign in to UnitStager first.');
      let res;
      try {
        res = await fetch(auth.serverUrl + path, { ...init, headers: { Authorization: 'Bearer ' + auth.token }, signal });
      } catch {
        if (signal.aborted) throw fail('Cancelled.', 'cancelled');
        throw fail("Can't reach the UnitStager server. Check your connection and try again.", 'network');
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) throw fail((body && body.error) || `The UnitStager server returned an error (${res.status}).`, (body && body.code) || (res.status === 401 ? 'auth' : undefined));
      return body;
    };
    const form = new FormData();
    form.append('image', image.blob, 'photo.jpg');
    form.append('name', String(job.name || 'photo.jpg').slice(0, 120));
    form.append('room', job.room || 'auto');
    form.append('style', job.style || 'modern');
    form.append('custom', job.custom || '');
    form.append('label', '0'); // the extension adds its own label, from its settings
    form.append('width', String(image.width));
    form.append('height', String(image.height));
    // The AppFolio property and unit, for per-property usage (see appfolio.js).
    const place = job.place || {};
    for (const [k, v] of [['property_id', place.propertyId], ['property', place.property], ['unit_id', place.unitId], ['unit', place.unit]]) {
      if (v) form.append(k, String(v).slice(0, 200));
    }
    const created = await call('/api/jobs', { method: 'POST', body: form });
    for (;;) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 3000);
        signal.addEventListener('abort', () => (clearTimeout(t), reject(fail('Cancelled.', 'cancelled'))), { once: true });
      });
      const { stagings } = await call('/api/jobs');
      const mine = (stagings || []).find((s) => s.id === created.id);
      if (!mine) throw fail('The staging could not be found. Check Recent stagings on unitstager.com.');
      if (mine.status === 'error') throw fail(mine.error || 'Staging failed. Your credit was returned.', 'upstream');
      if (mine.status === 'done') break;
    }
    const result = await call(`/api/jobs/${created.id}/result`);
    const item = result && result.data && result.data[0];
    if (!item || !item.b64_json) throw fail('The server returned no image.');
    return { dataUrl: 'data:image/jpeg;base64,' + item.b64_json, credits: typeof created.credits === 'number' ? created.credits : undefined };
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
