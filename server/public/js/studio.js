// The website studio: sign in, drop a batch of photos, pick a room per photo
// and one style / instructions for the batch, and stage them. Staging runs on
// the server, so it finishes even if this page is closed; results are kept for
// 30 days and listed under "Recent stagings". One credit per photo.
(() => {
  const $ = (id) => document.getElementById(id);
  const ROOMS = [['auto', 'Auto-detect room'], ['living room', 'Living room'], ['bedroom', 'Bedroom'], ['primary bedroom', 'Primary bedroom'], ['dining room', 'Dining room'],
    ['kitchen', 'Kitchen'], ['home office', 'Home office'], ['bathroom', 'Bathroom'], ['studio apartment', 'Studio'], ['entryway', 'Entryway'],
    ['patio or balcony', 'Patio / balcony'], ['basement or bonus room', 'Basement / bonus room']];
  const STYLE_NAMES = { modern: 'Modern', Scandinavian: 'Scandinavian', 'mid-century modern': 'Mid-century modern', transitional: 'Transitional',
    'modern farmhouse': 'Modern farmhouse', coastal: 'Coastal', industrial: 'Industrial', traditional: 'Traditional' };
  const MAX_EDGE = 2048;
  const UPLOADS_AT_ONCE = 3;
  const POLL_MS = 3000;

  let credits = null;
  let autoOn = false;
  const items = []; // photos added on this page: {id, file, name, room, status, jobId, before, after, ...}
  let recent = []; // the account's stagings from the server
  const results = new Map(); // job id -> object URL of the staged photo (cached)
  let seq = 0;

  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'class') n.className = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    n.append(...kids.flat().filter((k) => k != null && k !== false));
    return n;
  };

  // ---- sign-in gate ----------------------------------------------------------
  function start() {
    if (!US.signedIn()) {
      $('studio').hidden = true;
      mountSignIn($('gate'), () => {
        $('gate').replaceChildren();
        start();
      });
      return;
    }
    $('gate').replaceChildren();
    $('studio').hidden = false;
    const out = $('signOut');
    if (out) out.hidden = false;
    loadBalance();
    poll();
    US.redeemPending().then((r) => {
      if (!r) return;
      $('promoMsg').hidden = false;
      $('promoMsg').className = 'msg banner ' + (r.ok ? 'ok' : 'bad');
      $('promoMsg').textContent = r.message;
      if (r.ok) setCredits(r.credits);
    });
  }

  async function loadBalance() {
    try {
      const { data } = await US.api('/api/me');
      setCredits(data.credits);
      autoOn = !!(data.auto && data.auto.pack);
    } catch (e) {
      if (e.code === 'auth') return start();
      $('credits').textContent = 'Credits';
    }
  }
  function setCredits(n) {
    credits = n;
    $('credits').textContent = `${n} credit${n === 1 ? '' : 's'}`;
    $('credits').classList.toggle('low', n <= 3);
    refreshGo();
  }

  // ---- adding photos ----------------------------------------------------------
  const isImage = (f) => /^image\/(jpeg|png|webp)$/i.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name);

  function addFiles(list) {
    const files = [...list];
    const bad = files.filter((f) => !isImage(f));
    for (const file of files.filter(isImage)) {
      const it = { id: ++seq, file, name: file.name, room: 'auto', status: 'ready', before: URL.createObjectURL(file) };
      items.push(it);
      $('tiles').append(render(it));
    }
    $('opts').hidden = !items.length;
    $('addMsg').textContent = bad.length ? `Skipped ${bad.length} file${bad.length === 1 ? '' : 's'} that ${bad.length === 1 ? "isn't" : "aren't"} JPEG, PNG or WebP (iPhone HEIC photos need converting first).` : '';
    refreshGo();
  }

  $('files').addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });
  const drop = $('drop');
  for (const t of ['dragenter', 'dragover']) drop.addEventListener(t, (e) => (e.preventDefault(), drop.classList.add('over')));
  for (const t of ['dragleave', 'drop']) drop.addEventListener(t, () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  });

  // ---- tiles ------------------------------------------------------------------
  function render(it) {
    const img = el('img', { src: it.before, alt: '' });
    const room = el('select', { 'aria-label': 'Room type', onchange: () => (it.room = room.value) }, ROOMS.map(([v, t]) => el('option', { value: v }, t)));
    const tile = el('div', { class: 'tile' },
      el('div', { class: 'ph' }, img, el('span', { class: 'state' })),
      el('div', { class: 'meta' }, el('span', { class: 'nm', title: it.name }, it.name), el('button', { class: 'x', type: 'button', 'aria-label': 'Remove', onclick: () => remove(it) }, '×')),
      room,
      el('div', { class: 'actions' }));
    it.el = tile;
    it.img = img;
    it.roomSel = room;
    return tile;
  }

  function remove(it) {
    if (it.status === 'uploading') return;
    it.el.remove();
    URL.revokeObjectURL(it.before);
    items.splice(items.indexOf(it), 1);
    $('opts').hidden = !items.length;
    refreshGo();
  }

  function paint(it) {
    const state = it.el.querySelector('.state');
    const actions = it.el.querySelector('.actions');
    it.el.className = 'tile ' + (it.status === 'uploading' ? 'running' : it.status);
    it.roomSel.disabled = it.status !== 'ready' && it.status !== 'error';
    state.textContent = { uploading: 'Uploading…', running: `Staging… ${progress(it.startedAt)}%`, done: 'Staged', error: 'Failed' }[it.status] || '';
    actions.replaceChildren();
    if (it.status === 'done' && it.after) {
      const toggle = el('button', { class: 'btn small', type: 'button', onclick: () => {
        const showingAfter = it.img.src === it.after;
        it.img.src = showingAfter ? it.before : it.after;
        toggle.textContent = showingAfter ? 'Show staged' : 'Show original';
      } }, 'Show original');
      actions.append(toggle, el('a', { class: 'btn small primary', href: it.after, download: stagedName(it.name) }, 'Download'));
    } else if (it.status === 'error') {
      actions.append(el('p', { class: 'msg bad' }, it.error), el('button', { class: 'btn small', type: 'button', onclick: () => submit([it]) }, 'Try again'));
      if (it.code === 'no-credits') actions.append(el('a', { class: 'btn small primary', href: '/account.html' }, 'Buy credits'));
    }
  }

  const stagedName = (n) => String(n || 'photo').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[^\w.-]+/g, '_').slice(0, 80) + '-staged.jpg';

  // Estimated progress: the image service gives none, so this follows how long
  // staging has usually taken (about 90% at the typical time, never 100 early).
  const typical = () => {
    try {
      return Math.max(15000, Number(localStorage.getItem('unitstager.typicalMs')) || 60000);
    } catch {
      return 60000;
    }
  };
  const progress = (since) => Math.min(99, Math.max(1, Math.round(100 * (1 - Math.exp((-2.3 * (Date.now() - since)) / typical())))));
  const learn = (took) => {
    try {
      if (took > 5000 && took < 300000) localStorage.setItem('unitstager.typicalMs', String(Math.round(typical() * 0.7 + took * 0.3)));
    } catch {}
  };
  setInterval(() => {
    items.filter((i) => i.status === 'running').forEach(paint);
    for (const row of document.querySelectorAll('[data-since]')) row.textContent = `Staging… ${progress(Number(row.dataset.since))}%`;
  }, 1000);

  // ---- submitting -------------------------------------------------------------
  const waiting = () => items.filter((i) => i.status === 'ready');

  function refreshGo() {
    const n = waiting().length;
    const btn = $('stageBtn');
    btn.textContent = n ? `Stage ${n} photo${n === 1 ? '' : 's'}` : 'Stage photos';
    const short = !autoOn && credits != null && n > credits;
    btn.disabled = !n || short;
    $('goMsg').replaceChildren();
    if (short) $('goMsg').append(`You have ${credits} credit${credits === 1 ? '' : 's'}. `, el('a', { href: '/account.html' }, 'Top up'), ' or remove some photos.');
    $('afterAll').hidden = !items.some((i) => i.status === 'done' && i.after);
  }

  $('stageBtn').addEventListener('click', () => submit(waiting()));

  let uploading = 0;
  const pending = [];
  function submit(list) {
    for (const it of list) {
      it.status = 'uploading';
      it.error = '';
      paint(it);
      pending.push(it);
    }
    refreshGo();
    pumpUploads();
  }
  function pumpUploads() {
    while (uploading < UPLOADS_AT_ONCE && pending.length) {
      const it = pending.shift();
      uploading++;
      upload(it).finally(() => {
        uploading--;
        pumpUploads();
        refreshGo();
      });
    }
  }

  async function prepare(file) {
    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      throw Object.assign(new Error("This file couldn't be read as a photo."), { code: 'bad-file' });
    }
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    return { blob, width: c.width, height: c.height };
  }

  async function upload(it) {
    try {
      const photo = await prepare(it.file);
      const form = new FormData();
      form.append('image', photo.blob, 'photo.jpg');
      form.append('name', it.name);
      form.append('room', it.room);
      form.append('style', $('style').value);
      form.append('custom', $('custom').value.trim());
      form.append('label', $('label').checked ? '1' : '0');
      form.append('width', String(photo.width));
      form.append('height', String(photo.height));
      const { data } = await US.api('/api/jobs', { method: 'POST', form });
      it.jobId = data.id;
      it.status = 'running';
      it.startedAt = Date.now();
      if (typeof data.credits === 'number') setCredits(data.credits);
      if (autoOn && data.credits <= 3) setTimeout(loadBalance, 8000);
      schedulePoll(POLL_MS);
    } catch (e) {
      it.status = 'error';
      it.code = e.code;
      it.error = e.message;
      if (e.code === 'auth') setTimeout(start, 50);
    }
    paint(it);
  }

  // ---- results ----------------------------------------------------------------
  // The stored result is the image service's JSON (base64 inside); decode it
  // here and add the disclosure label if that staging asked for one.
  async function resultUrl(job) {
    if (results.has(job.id)) return results.get(job.id);
    const { data } = await US.api(`/api/jobs/${job.id}/result`);
    const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
    if (!b64) throw new Error('The staged photo could not be read.');
    let blob = new Blob([Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))], { type: 'image/jpeg' });
    if (job.label) blob = await addLabel(blob, 'Virtually staged');
    const url = URL.createObjectURL(blob);
    results.set(job.id, url);
    return url;
  }

  async function addLabel(blob, text) {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const size = Math.max(14, Math.round(Math.min(bmp.width, bmp.height) * 0.028));
    ctx.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const pad = Math.round(size * 0.6);
    const bw = ctx.measureText(text).width + pad * 2;
    const bh = size + pad * 1.4;
    const y = bmp.height - bh - pad;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.roundRect(pad, y, bw, bh, bh / 4);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, pad * 2, y + bh / 2 + 1);
    bmp.close();
    return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
  }

  // ---- polling ----------------------------------------------------------------
  let pollTimer = null;
  function schedulePoll(ms) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, ms);
  }

  async function poll() {
    let list;
    try {
      list = (await US.api('/api/jobs')).data.stagings || [];
    } catch (e) {
      if (e.code === 'auth') return start();
      return schedulePoll(POLL_MS * 3);
    }
    recent = list;
    const byId = new Map(list.map((j) => [j.id, j]));
    for (const it of items.filter((i) => i.status === 'running' && i.jobId)) {
      const job = byId.get(it.jobId);
      if (!job) continue;
      if (job.status === 'done') {
        try {
          it.after = await resultUrl(job);
          it.img.src = it.after;
          it.status = 'done';
          learn(Date.now() - it.startedAt);
        } catch (e) {
          it.status = 'error';
          it.error = e.message;
        }
        paint(it);
      } else if (job.status === 'error') {
        it.status = 'error';
        it.error = job.error || 'Staging failed. Your credit was returned.';
        paint(it);
        loadBalance();
      }
    }
    renderRecent();
    refreshGo();
    const busy = list.some((j) => j.status === 'queued' || j.status === 'running') || items.some((i) => i.status === 'uploading');
    if (busy) schedulePoll(POLL_MS);
  }

  // ---- recent stagings --------------------------------------------------------
  const fmt = (d) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  function renderRecent() {
    $('recent').hidden = !recent.length;
    $('recentCount').textContent = recent.length ? `${recent.length} in the last 30 days` : '';
    $('recentBody').replaceChildren(
      ...recent.map((job) => {
        const acts = el('div', { class: 'acts' });
        let status;
        if (job.status === 'done') {
          status = fmt(job.finished_at || job.created_at);
          acts.append(
            el('button', { class: 'btn small primary', type: 'button', onclick: (e) => download(job, e.currentTarget) }, 'Download'),
            el('button', { class: 'btn small', type: 'button', 'aria-label': `Delete ${job.name}`, onclick: () => removeJob(job) }, 'Delete'));
        } else if (job.status === 'error') {
          status = el('span', { class: 'st-err', title: job.error || '' }, 'Failed — credit returned');
          acts.append(el('button', { class: 'btn small', type: 'button', 'aria-label': `Delete ${job.name}`, onclick: () => removeJob(job) }, 'Delete'));
        } else {
          status = el('span', { 'data-since': String(Date.parse(job.created_at)) }, `Staging… ${progress(Date.parse(job.created_at))}%`);
        }
        return el('tr', {},
          el('td', {}, el('div', { class: 'nm', title: job.name }, job.name)),
          el('td', {}, STYLE_NAMES[job.style] || job.style || ''),
          el('td', {}, status),
          el('td', { class: 'muted' }, fmt(job.expires_at)),
          el('td', {}, acts));
      })
    );
  }

  async function download(job, btn) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Preparing…';
    try {
      el('a', { href: await resultUrl(job), download: stagedName(job.name) }).click();
    } catch (e) {
      alert(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  async function removeJob(job) {
    if (!confirm(`Delete the staged photo "${job.name}"? This can't be undone.`)) return;
    try {
      await US.api(`/api/jobs/${job.id}`, { method: 'DELETE' });
      recent = recent.filter((j) => j.id !== job.id);
      renderRecent();
    } catch (e) {
      alert(e.message);
    }
  }

  // ---- after ------------------------------------------------------------------
  $('downloadAll').addEventListener('click', async () => {
    for (const it of items.filter((i) => i.status === 'done' && i.after)) {
      el('a', { href: it.after, download: stagedName(it.name) }).click();
      await new Promise((r) => setTimeout(r, 400));
    }
  });
  $('clearDone').addEventListener('click', () => items.filter((i) => i.status === 'done').forEach(remove));

  // Only an upload still in progress is lost by leaving; staging itself carries on.
  addEventListener('beforeunload', (e) => {
    if (items.some((i) => i.status === 'uploading')) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  addEventListener('visibilitychange', () => document.visibilityState === 'visible' && US.signedIn() && poll());

  start();
})();
