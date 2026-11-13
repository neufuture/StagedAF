(() => {
  const SAF = globalThis.SAF;
  const $ = (id) => document.getElementById(id);
  const FIELDS = ['serverUrl', 'apiKey', 'model', 'quality', 'inputFidelity', 'apiBase', 'maxInputEdge', 'concurrency', 'style', 'basePrompt', 'stageUploads', 'reviewBeforeUpload',
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
    if (value === '' && ['model', 'apiBase', 'basePrompt', 'pagePattern', 'disclosureText', 'serverUrl'].includes(id)) write($(id), (value = SAF.DEFAULTS[id]));
    await chrome.storage.local.set({ [id]: value });
    flash();
  };

  chrome.storage.local.get(null).then((stored) => {
    const s = SAF.merge(stored);
    for (const id of FIELDS) {
      write($(id), s[id]);
      $(id).addEventListener('change', () => save(id));
    }
  });
  chrome.storage.onChanged.addListener((changes) => {
    for (const [k, c] of Object.entries(changes)) if ($(k) && document.activeElement !== $(k)) write($(k), c.newValue === undefined ? SAF.DEFAULTS[k] : c.newValue);
  });

  // ---- Account -----------------------------------------------------------

  const account = async (op, args) => {
    const res = await chrome.runtime.sendMessage({ type: 'saf:account', op, args });
    if (!res || !res.ok) throw Object.assign(new Error((res && res.error) || 'Something went wrong.'), { code: res && res.code });
    return res.value;
  };
  const say = (text, cls = '') => {
    $('authResult').className = cls;
    $('authResult').textContent = text;
  };
  const money = (cents) => '$' + (cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100));

  function showAccount(s) {
    const signedIn = !!(s.session && s.session.access_token);
    const ownKey = s.mode === 'own-key';
    $('accountSection').hidden = ownKey;
    $('ownKey').hidden = !ownKey;
    $('ownKeyMode').checked = ownKey;
    $('signedOut').hidden = signedIn;
    $('signedIn').hidden = !signedIn;
    if (signedIn) {
      $('who').textContent = s.session.email || 'your account';
      $('credits').textContent = typeof s.credits === 'number' ? s.credits : '–';
      $('creditsLabel').textContent = s.credits === 1 ? 'credit' : 'credits';
    }
  }
  const reshow = () => chrome.storage.local.get(null).then((stored) => showAccount(SAF.merge(stored)));

  function showPacks(packs) {
    $('packs').replaceChildren(
      ...(packs || []).map((p) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'primary';
        b.textContent = `Buy ${p.credits} credits – ${money(p.amount)}`;
        b.addEventListener('click', async () => {
          say('Opening checkout…');
          try {
            window.open(await account('checkout', { pack: p.id }), '_blank', 'noopener');
            say('Finish paying in the new tab. Your credits appear here afterwards.');
          } catch (e) {
            say(e.message, 'bad');
          }
        });
        return b;
      })
    );
  }

  // Ask the server for the current balance and packs (also after a purchase).
  async function refreshAccount(quiet) {
    const s = SAF.merge(await chrome.storage.local.get(null));
    if (s.mode === 'own-key' || !s.session) return;
    try {
      showPacks((await account('me')).packs);
      if (!quiet) say('');
    } catch (e) {
      if (!quiet || e.code === 'auth') say(e.message, 'bad');
    }
  }

  $('sendCode').addEventListener('click', async () => {
    const email = $('email').value.trim();
    say('Sending…');
    try {
      await account('start', { email });
      $('codeRow').hidden = false;
      $('code').focus();
      say(`We emailed a code to ${email}. It can take a minute; check spam too.`);
    } catch (e) {
      say(e.message, 'bad');
    }
  });
  $('verify').addEventListener('click', async () => {
    say('Checking…');
    try {
      const out = await account('verify', { email: $('email').value.trim(), code: $('code').value.trim() });
      $('code').value = '';
      $('codeRow').hidden = true;
      say(`Signed in. You have ${out.credits} credit${out.credits === 1 ? '' : 's'}.`, 'ok');
      refreshAccount(true);
    } catch (e) {
      say(e.message, 'bad');
    }
  });
  for (const [id, btn] of [['email', 'sendCode'], ['code', 'verify']]) $(id).addEventListener('keydown', (e) => e.key === 'Enter' && $(btn).click());
  $('refresh').addEventListener('click', () => (say('Checking…'), refreshAccount(false)));
  $('signOut').addEventListener('click', async () => {
    await account('signOut');
    say('Signed out.');
  });
  $('ownKeyMode').addEventListener('change', async () => {
    await chrome.storage.local.set({ mode: $('ownKeyMode').checked ? 'own-key' : 'account' });
    flash();
  });
  chrome.storage.onChanged.addListener((changes) => (changes.session || changes.credits || changes.mode) && reshow());
  // Coming back to this tab after paying: pick up the new balance.
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refreshAccount(true));
  reshow().then(() => refreshAccount(true));

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
