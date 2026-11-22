// Account page: balance, top-up packs (with auto top-up), Stripe's portal for
// saved cards, and the transaction list with receipts.
(() => {
  const $ = (id) => document.getElementById(id);
  const money = (c) => '$' + (c % 100 ? (c / 100).toFixed(2) : String(c / 100));
  const say = (t, cls = '') => {
    $('acctMsg').className = 'msg ' + cls;
    $('acctMsg').textContent = t;
  };
  let packs = [];

  function start() {
    if (!US.signedIn()) {
      $('account').hidden = true;
      mountSignIn($('gate'), () => {
        $('gate').replaceChildren();
        start();
      });
      return;
    }
    $('account').hidden = false;
    const out = $('signOut');
    if (out) out.hidden = false;
    $('who').textContent = (US.session() || {}).email || '';
    if (new URLSearchParams(location.search).has('paid')) {
      $('paid').hidden = false;
      history.replaceState(null, '', '/account.html');
      // The payment notification can arrive a moment after the redirect.
      setTimeout(load, 3000);
      setTimeout(load, 8000);
    }
    US.redeemPending().then((r) => {
      if (!r) return;
      sayPromo(r.message, r.ok ? 'ok' : 'bad');
      if (r.ok) load();
    });
    load();
  }

  const sayPromo = (t, cls = '') => {
    $('promoResult').className = 'msg ' + cls;
    $('promoResult').textContent = t;
  };
  $('promoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('promoCode').value.trim();
    if (!code) return;
    const btn = $('promoForm').querySelector('button');
    btn.disabled = true;
    sayPromo('Checking…');
    try {
      const r = await US.redeem(code);
      sayPromo(`${r.added} credits added.`, 'ok');
      $('promoCode').value = '';
      load();
    } catch (err) {
      sayPromo(err.message, 'bad');
    } finally {
      btn.disabled = false;
    }
  });

  async function load() {
    try {
      const { data } = await US.api('/api/me');
      $('balance').textContent = data.credits;
      packs = data.packs || [];
      const thr = (data.auto && data.auto.threshold) || 3;
      for (const t of document.querySelectorAll('.thr')) t.textContent = thr;
      const auto = data.auto && data.auto.pack;
      const p = packs.find((x) => x.id === auto);
      $('autoRow').hidden = !!auto;
      $('autoOn').hidden = !auto;
      if (auto) $('autoWhat').textContent = p ? `buys ${p.credits} credits for ${money(p.amount)}` : 'buys your chosen pack';
      showPacks();
      const { data: h } = await US.api('/api/purchases');
      showTx(h.purchases || []);
    } catch (e) {
      if (e.code === 'auth') return start();
      say(e.message, 'bad');
    }
  }

  function showPacks() {
    $('packs2').replaceChildren(
      ...packs.map((p) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pack';
        b.innerHTML = '<b></b><span class="each"></span>';
        b.querySelector('b').textContent = `${p.credits} credits – ${money(p.amount)}`;
        b.querySelector('.each').textContent = `${money(p.each)} per photo`;
        if (p.save > 0) {
          const s = document.createElement('span');
          s.className = 'save';
          s.textContent = `Save ${p.save}%`;
          b.append(s);
        }
        b.addEventListener('click', async () => {
          say('Opening checkout…');
          try {
            const auto = !$('autoRow').hidden && $('autoBox').checked;
            const { data } = await US.api('/api/checkout', { method: 'POST', body: { pack: p.id, auto, from: 'web' } });
            location.href = data.url;
          } catch (e) {
            say(e.message, 'bad');
          }
        });
        return b;
      })
    );
  }

  function showTx(list) {
    const body = $('tx').tBodies[0];
    $('txEmpty').hidden = list.length > 0;
    $('tx').hidden = !list.length;
    body.replaceChildren(
      ...list.map((p) => {
        const tr = document.createElement('tr');
        const td = (t) => {
          const c = document.createElement('td');
          c.textContent = t;
          return c;
        };
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn small';
        btn.textContent = 'Receipt';
        btn.addEventListener('click', async () => {
          try {
            const { data } = await US.api('/api/receipt', { method: 'POST', body: { id: p.id } });
            window.open(data.url, '_blank', 'noopener');
          } catch (e) {
            say(e.message, 'bad');
          }
        });
        const last = document.createElement('td');
        if (p.id) last.append(btn);
        const date = new Date(p.date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        const what = p.promo ? `${p.credits} credits (promo code ${p.promo})` : `${p.credits} credits${p.auto ? ' (auto top-up)' : ''}`;
        tr.append(td(date), td(what), td(p.promo ? 'Free' : p.amount != null ? money(p.amount) : ''), last);
        return tr;
      })
    );
  }

  $('autoOff').addEventListener('click', async () => {
    try {
      await US.api('/api/auto-topup', { method: 'POST', body: { enabled: false } });
      say('Auto top-up is off. Your card will not be charged automatically.', 'ok');
      load();
    } catch (e) {
      say(e.message, 'bad');
    }
  });

  $('portal').addEventListener('click', async () => {
    say('Opening payment settings…');
    try {
      const { data } = await US.api('/api/billing-portal', { method: 'POST' });
      location.href = data.url;
    } catch (e) {
      say(e.message, 'bad');
    }
  });

  addEventListener('pageshow', (e) => e.persisted && US.signedIn() && load());
  start();
})();
