(() => {
  const SAF = globalThis.SAF;
  const $ = (id) => document.getElementById(id);
  const FIELDS = ['apiKey', 'model', 'quality', 'inputFidelity', 'apiBase', 'maxInputEdge', 'concurrency', 'style', 'basePrompt', 'stageUploads', 'reviewBeforeUpload',
    'autoReplace', 'backupOriginal', 'disclosureLabel', 'disclosureText', 'pagePattern', 'photoSelector', 'uploadInputSelector', 'deleteSelector', 'minPhotoSize'];

  for (const [value, label] of SAF.STYLES) $('style').append(new Option(label, value));

  const read = (el) => (el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) || SAF.DEFAULTS[el.id] : el.value.trim());
  const write = (el, v) => (el.type === 'checkbox' ? (el.checked = !!v) : (el.value = v));

  let timer;
  const flash = () => {
    $('saved').textContent = 'Saved';
    $('saved').classList.add('show');
    clearTimeout(timer);
    timer = setTimeout(() => $('saved').classList.remove('show'), 1200);
  };

  const save = async (id) => {
    let value = read($(id));
    if (value === '' && ['model', 'apiBase', 'basePrompt', 'pagePattern', 'disclosureText'].includes(id)) write($(id), (value = SAF.DEFAULTS[id]));
    await chrome.storage.local.set({ [id]: value });
    flash();
  };

  chrome.storage.local.get(null).then((stored) => {
    const s = { ...SAF.DEFAULTS, ...stored };
    for (const id of FIELDS) {
      write($(id), s[id]);
      $(id).addEventListener('change', () => save(id));
    }
  });
  chrome.storage.onChanged.addListener((changes) => {
    for (const [k, c] of Object.entries(changes)) if ($(k) && document.activeElement !== $(k)) write($(k), c.newValue === undefined ? SAF.DEFAULTS[k] : c.newValue);
  });

  $('resetPrompt').addEventListener('click', () => {
    $('basePrompt').value = SAF.DEFAULT_PROMPT;
    save('basePrompt');
  });

  $('test').addEventListener('click', async () => {
    const out = $('testResult');
    out.className = '';
    out.textContent = 'Checking…';
    const base = ($('apiBase').value.trim() || SAF.DEFAULTS.apiBase).replace(/\/+$/, '');
    try {
      const res = await fetch(`${base}/models/${encodeURIComponent($('model').value.trim())}`, { headers: { Authorization: 'Bearer ' + $('apiKey').value.trim() } });
      if (res.ok) (out.className = 'ok'), (out.textContent = 'Key works and the model is available.');
      else if (res.status === 401) (out.className = 'bad'), (out.textContent = 'That key was rejected.');
      else if (res.status === 404) (out.className = 'bad'), (out.textContent = 'Key works, but this account cannot use that model. Check the model name, or verify your organization with the provider.');
      else (out.className = 'bad'), (out.textContent = `Unexpected response (HTTP ${res.status}).`);
    } catch {
      out.className = 'bad';
      out.textContent = 'Could not reach the API. Check the base URL.';
    }
  });

  $('grant').addEventListener('click', async () => {
    const out = $('grantResult');
    const host = $('host').value.trim().replace(/^https?:\/\//, '').split('/')[0];
    if (!/^[\w.-]+\.[a-z]{2,}$/i.test(host)) return (out.className = 'bad'), (out.textContent = 'Enter a host like images.example.com');
    try {
      const granted = await chrome.permissions.request({ origins: [`https://${host}/*`] });
      out.className = granted ? 'ok' : 'bad';
      out.textContent = granted ? `Access to ${host} granted.` : 'Not granted.';
    } catch (e) {
      out.className = 'bad';
      out.textContent = String(e.message || e);
    }
  });
})();
