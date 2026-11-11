// Flow 2 — photos already in AppFolio. Each detected photo gets a "Stage"
// chip. Chips float in our own layer (position: fixed, tracked to the photo)
// rather than being inserted into AppFolio's markup, so the page's own
// rendering can never wipe them out or be broken by them.
(() => {
  const SAF = globalThis.SAF;
  const { h, ui } = SAF;
  const A = SAF.appfolio;

  let layer = null;
  let chips = new Map(); // img element -> chip button
  let pop = null;

  const jobFor = (key) => [...SAF.jobs].reverse().find((j) => j.origin === 'existing' && j.meta.key === key);

  function occluded(img, r) {
    const x = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2));
    const y = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
    const el = document.elementFromPoint(x, y);
    if (!el) return true;
    const card = (img.parentElement && img.parentElement.parentElement) || img.parentElement || img;
    return !(el === img || card.contains(el));
  }

  function paint(chip, job) {
    let cls = 'chip';
    let label = '✦ Stage';
    if (job && job.meta.replacing) (cls += ' busy'), (label = 'Replacing…');
    else if (job && (job.status === 'queued' || job.status === 'running')) (cls += ' busy'), (label = job.status === 'queued' ? 'Queued…' : 'Staging… ' + SAF.elapsed(job));
    else if (job && job.status === 'done') (cls += ' ready'), (label = 'Review staged');
    else if (job && job.status === 'error') (cls += ' failed'), (label = 'Failed — retry');
    if (chip.dataset.label === cls + label) return;
    chip.dataset.label = cls + label;
    if (chip.className === cls && chip.lastChild) return void (chip.lastChild.textContent = label); // just the timer ticking
    chip.className = cls;
    chip.replaceChildren(cls.includes('busy') ? h('span', { class: 'spin' }) : '', document.createTextNode(label));
  }

  function refresh() {
    if (!layer) return;
    const photos = A.isTargetPage() ? A.findPhotos() : [];
    const live = new Set(photos);
    for (const [img, chip] of chips) {
      if (!live.has(img)) {
        chip.remove();
        chips.delete(img);
      }
    }
    for (const img of photos) {
      let chip = chips.get(img);
      if (!chip) {
        chip = h('button', { class: 'chip', title: 'Virtually stage this photo', onclick: () => onChip(img, chip) });
        chips.set(img, chip);
        layer.append(chip);
      }
      const r = img.getBoundingClientRect();
      const show = r.bottom > 30 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && !occluded(img, r);
      chip.style.display = show ? '' : 'none';
      if (!show) continue;
      chip.style.left = Math.max(4, r.left + 8) + 'px';
      chip.style.top = r.bottom - 34 + 'px';
      paint(chip, jobFor(A.photoKey(img)));
    }
  }

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      refresh();
    });
  };

  function onChip(img, chip) {
    const job = jobFor(A.photoKey(img));
    if (job && job.meta.replacing) return;
    if (job && job.status === 'done') return SAF.reviewExisting(job);
    openPopover(img, chip, job);
  }

  function closePopover() {
    if (pop) pop.remove();
    pop = null;
  }

  function openPopover(img, chip, job) {
    closePopover();
    const busy = job && (job.status === 'queued' || job.status === 'running');
    const room = SAF.select(SAF.ROOMS, (job && job.room) || 'auto');
    const fields = ui.stagingFields(job || {});
    const go = () => {
      const key = A.photoKey(img);
      const url = A.bestUrl(img);
      if (job) SAF.removeJob(job);
      closePopover();
      const next = SAF.createJob({ name: A.photoName(img), source: { url }, room: room.value, ...fields.values(), origin: 'existing', meta: { key, url } });
      next.finished.then(SAF.existingJobDone);
      schedule();
    };
    pop = h(
      'div',
      { class: 'pop', role: 'dialog', 'aria-label': 'Stage this photo' },
      h('h3', null, busy ? 'Staging in progress' : 'Stage this photo'),
      busy
        ? [h('p', { class: 'muted' }, job.status === 'queued' ? 'Waiting for another photo to finish first.' : `Sent to the image service ${SAF.elapsed(job)} ago. This usually takes 30 seconds to 2 minutes, and is stopped automatically at 5.`), h('div', { class: 'row end' }, h('button', { class: 'btn small danger', onclick: () => (SAF.removeJob(job), closePopover(), schedule()) }, 'Cancel staging'))]
        : [
            job && job.status === 'error' && h('p', { class: 'err' }, job.error),
            !SAF.settings.apiKey && h('p', { class: 'err' }, 'Add your API key first. ', h('button', { class: 'link', onclick: () => SAF.send({ type: 'saf:open-options' }) }, 'Open settings')),
            h('label', { class: 'field' }, 'Room', room),
            fields.styleField,
            fields.customField,
            h('p', { class: 'muted', style: 'margin:0 0 10px' }, 'Leave the instructions blank for default staging.'),
            h('div', { class: 'row end' }, h('button', { class: 'btn small', onclick: closePopover }, 'Cancel'), h('button', { class: 'btn small primary', disabled: !SAF.settings.apiKey, onclick: go }, 'Stage photo')),
          ]
    );
    ui.root().append(pop);
    const c = chip.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(c.left, innerWidth - p.width - 8)) + 'px';
    pop.style.top = (c.top - p.height - 8 > 8 ? c.top - p.height - 8 : Math.min(c.bottom + 8, Math.max(8, innerHeight - p.height - 8))) + 'px';
  }

  SAF.existingJobDone = (job) => {
    schedule();
    if (!SAF.jobs.includes(job)) return;
    if (job.status === 'error') return ui.toast('Staging failed: ' + job.error, { kind: 'error', ms: 12000 });
    if (job.status !== 'done') return;
    if (SAF.settings.autoReplace) return SAF.replaceExisting(job, { deleteOriginal: true });
    job.meta.closeToast = ui.toast('Staged photo is ready.', { kind: 'ok', action: 'Review', onAction: () => SAF.reviewExisting(job), ms: 15000 });
  };

  SAF.startExisting = () => {
    layer = h('div', { class: 'chips' });
    ui.root().prepend(layer);
    setInterval(refresh, 600);
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    document.addEventListener('mousedown', (e) => pop && !ui.isOurs(e.target) && closePopover(), true);
    document.addEventListener('keydown', (e) => e.key === 'Escape' && closePopover(), true);
    SAF.on('jobs', schedule);
    SAF.on('settings', schedule);
    refresh();
  };
})();
