(() => {
  const SAF = globalThis.SAF;
  const $ = (id) => document.getElementById(id);
  const FIELDS = ['maxInputEdge', 'concurrency', 'style', 'stageUploads', 'reviewBeforeUpload',
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
    if (value === '' && ['pagePattern', 'disclosureText'].includes(id)) write($(id), (value = SAF.DEFAULTS[id]));
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

  let packList = [];
  let threshold = 3;

  function showAccount(s) {
    const signedIn = !!(s.session && s.session.access_token);
    $('signedOut').hidden = signedIn;
    $('signedIn').hidden = !signedIn;
    if (!signedIn) return;
    $('who').textContent = s.session.email || 'your account';
    $('credits').textContent = typeof s.credits === 'number' ? s.credits : '–';
    $('creditsLabel').textContent = s.credits === 1 ? 'credit' : 'credits';
    const auto = packList.find((p) => p.id === s.autoPack);
    $('autoRow').hidden = !!s.autoPack;
    $('autoOn').hidden = !s.autoPack;
    if (s.autoPack) $('autoWhat').textContent = auto ? `buys ${auto.credits} credits for ${money(auto.amount)}` : 'buys your chosen pack';
    for (const el of document.querySelectorAll('.thr')) el.textContent = threshold;
  }
  const reshow = () => chrome.storage.local.get(null).then((stored) => showAccount(SAF.merge(stored)));

  function showPacks(packs) {
    packList = packs || [];
    $('packs').replaceChildren(
      ...packList.map((p) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pack';
        const title = document.createElement('b');
        title.textContent = `${p.credits} credits – ${money(p.amount)}`;
        const each = document.createElement('span');
        each.className = 'each';
        each.textContent = `${money(p.each)} per photo`;
        b.append(title, each);
        if (p.save > 0) {
          const save = document.createElement('span');
          save.className = 'save';
          save.textContent = `Save ${p.save}%`;
          save.title = `${p.save}% less per photo than the ${packList[0] ? packList[0].credits : 'smallest'}-credit pack`;
          b.append(save);
        }
        b.addEventListener('click', async () => {
          const auto = !$('autoRow').hidden && $('autoBox').checked;
          say('Opening checkout…');
          try {
            window.open(await account('checkout', { pack: p.id, auto }), '_blank', 'noopener');
            say(auto ? 'Finish paying in the new tab. Your credits appear here afterwards, and auto top-up switches on.' : 'Finish paying in the new tab. Your credits appear here afterwards.');
          } catch (e) {
            say(e.message, 'bad');
          }
        });
        return b;
      })
    );
  }

  // Ask the server for the current balance and packs (also after a purchase).
  // Purchases with a link to each Stripe receipt.
  function showHistory(list) {
    const body = $('history').tBodies[0];
    $('historyEmpty').hidden = list.length > 0;
    body.replaceChildren(
      ...list.map((p) => {
        const row = document.createElement('tr');
        const cell = (text) => {
          const td = document.createElement('td');
          td.textContent = text;
          return td;
        };
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Receipt';
        btn.addEventListener('click', async () => {
          try {
            window.open(await account('receipt', { id: p.id }), '_blank', 'noopener');
          } catch (e) {
            say(e.message, 'bad');
          }
        });
        const last = document.createElement('td');
        last.append(btn);
        const date = new Date(p.date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        row.append(cell(date), cell(`${p.credits} credits${p.auto ? ' (auto top-up)' : ''}`), cell(p.amount != null ? '$' + (p.amount / 100).toFixed(2) : ''), last);
        return row;
      })
    );
  }

  async function refreshAccount(quiet) {
    const s = SAF.merge(await chrome.storage.local.get(null));
    if (!s.session) return;
    try {
      const me = await account('me');
      threshold = (me.auto && me.auto.threshold) || threshold;
      showPacks(me.packs);
      await reshow();
      showHistory(await account('purchases').catch(() => []));
      if (!quiet) say('');
    } catch (e) {
      if (!quiet || e.code === 'auth') say(e.message, 'bad');
    }
  }

  $('autoOff').addEventListener('click', async () => {
    try {
      await account('autoOff');
      $('autoBox').checked = false;
      say('Auto top-up is off. Your card will not be charged automatically.');
    } catch (e) {
      say(e.message, 'bad');
    }
  });

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
  chrome.storage.onChanged.addListener((changes) => (changes.session || changes.credits || changes.autoPack) && reshow());
  // Coming back to this tab after paying: pick up the new balance.
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refreshAccount(true));
  reshow().then(() => refreshAccount(true));
})();
