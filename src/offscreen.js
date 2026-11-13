// Offscreen document: runs the staging requests. Content scripts connect with
// a port named "saf-stage", post one {type:'run'} message and get back
// {type:'done', dataUrl, inputDataUrl} or {type:'error', error, code}.
(() => {
  const SAF = globalThis.SAF;

  const fail = (message, code) => Object.assign(new Error(message), { code });

  async function ask(msg, fallback) {
    const res = await chrome.runtime.sendMessage(msg);
    if (!res || !res.ok) throw fail((res && res.error) || fallback, res && res.code);
    return res.value;
  }
  const getSettings = () => ask({ type: 'saf:get-settings' }, 'Could not load UnitStager settings.');

  // Account mode: the UnitStager server stages the photo and takes a credit.
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

  const STANDARD = [
    [1536, 1024],
    [1024, 1536],
    [1024, 1024],
  ];

  function standardSize(w, h) {
    const r = w / h;
    let best = STANDARD[0];
    for (const s of STANDARD) if (Math.abs(Math.log(s[0] / s[1] / r)) < Math.abs(Math.log(best[0] / best[1] / r))) best = s;
    return best.join('x');
  }

  // Newer GPT Image models accept any size whose sides are multiples of 16, so
  // the staged photo can keep the original's aspect ratio. Older ones only take
  // the three standard sizes; we fall back to those on a 400.
  function matchedSize(w, h) {
    const r = Math.min(3, Math.max(1 / 3, w / h));
    const long = 1536;
    const round16 = (n) => Math.max(256, Math.round(n / 16) * 16);
    return r >= 1 ? `${long}x${round16(long / r)}` : `${round16(long * r)}x${long}`;
  }

  const quirks = {}; // model -> parameters it rejected this session

  async function callImagesEdit(settings, prompt, image, signal) {
    const fields = {
      model: settings.model,
      prompt,
      n: '1',
      size: /^gpt-image-1/.test(settings.model) ? standardSize(image.width, image.height) : matchedSize(image.width, image.height),
      quality: settings.quality,
      output_format: 'jpeg',
    };
    if (settings.inputFidelity && settings.inputFidelity !== 'default') fields.input_fidelity = settings.inputFidelity;
    for (const k of Object.keys(fields)) if (fields[k] === '' || fields[k] == null || fields[k] === 'default') delete fields[k];
    // Apply what earlier requests taught us about this model.
    const learned = (quirks[settings.model] = quirks[settings.model] || { drop: new Set(), standardSize: false });
    for (const k of learned.drop) delete fields[k];
    if (learned.standardSize) fields.size = standardSize(image.width, image.height);

    const base = String(settings.apiBase || 'https://api.openai.com/v1').replace(/\/+$/, '');
    let lastError = 'The image service rejected the request.';
    // Models differ in which optional parameters they accept. When the API
    // names a parameter it does not like, drop it (or simplify it) and retry.
    for (let attempt = 0; attempt < 5; attempt++) {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      form.append('image', image.blob, 'photo.jpg');
      let res;
      try {
        res = await fetch(base + '/images/edits', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + settings.apiKey },
          body: form,
          signal,
        });
      } catch (e) {
        if (signal.aborted) throw fail('Cancelled.', 'cancelled');
        throw fail('Could not reach the image service. Check your connection and the API base URL.');
      }
      let body = null;
      try {
        body = await res.json();
      } catch {}
      if (res.ok) {
        const item = body && body.data && body.data[0];
        if (item && item.b64_json) return 'data:image/jpeg;base64,' + item.b64_json;
        if (item && item.url) return SAF.blobToDataUrl(await (await fetch(item.url, { signal })).blob());
        throw fail('The image service returned no image.');
      }
      const err = (body && body.error) || {};
      lastError = err.message || `The image service returned HTTP ${res.status}.`;
      if (res.status === 401) throw fail('The API key was rejected. Check it in UnitStager settings.', 'auth');
      if (res.status !== 400) break;
      const param = err.param || (/(input_fidelity|output_format|quality|size)/.exec(lastError) || [])[1];
      if (param === 'size' && fields.size && fields.size !== standardSize(image.width, image.height)) {
        fields.size = standardSize(image.width, image.height);
        learned.standardSize = true;
      } else if (param && param in fields && !['model', 'prompt'].includes(param)) {
        delete fields[param];
        learned.drop.add(param);
      } else break;
    }
    throw fail(lastError);
  }

  async function run(job, signal) {
    const settings = await getSettings();
    const ownKey = settings.mode === 'own-key';
    if (ownKey && !settings.apiKey) throw fail('Add your API key in UnitStager settings first.', 'auth');
    if (!ownKey && !settings.session) throw fail('Sign in to UnitStager first.', 'auth');
    const raw = await loadSource(job.source, signal);
    const image = await SAF.normalizeImage(raw, Number(settings.maxInputEdge) || 2048);
    const out = ownKey ? { dataUrl: await callImagesEdit(settings, job.prompt, image, signal) } : await callServer(job, image, signal);
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
