// Flow 1 — new uploads. With "Stage new uploads" on, picking or dropping
// photos into AppFolio's uploader is paused: the user chooses which photos to
// stage, those are staged, and then the final set is handed back to AppFolio's
// own uploader as if the user had picked those files.
(() => {
  const SAF = globalThis.SAF;
  const { h, ui } = SAF;
  const A = SAF.appfolio;

  SAF.batches = [];
  const isImage = (f) => /^image\/(jpeg|png|webp)$/i.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name);
  const wanted = (files) => SAF.settings.stageUploads && A.isTargetPage() && files.some(isImage);

  function onFileEvent(e) {
    const input = e.target;
    if (A.passing || !(input instanceof HTMLInputElement) || input.type !== 'file' || ui.isOurs(input)) return;
    const files = [...(input.files || [])];
    if (!files.some(isImage)) return;
    const sink = { type: 'input', el: input };
    if (A.isTargetPage()) A.lastSink = sink;
    if (!wanted(files)) return;
    e.stopImmediatePropagation();
    if (e.type === 'change') openPicker(sink, files);
  }

  function onDrop(e) {
    if (A.passing || ui.isOurs(e.target) || !e.dataTransfer) return;
    const files = [...e.dataTransfer.files];
    if (!files.some(isImage)) return;
    const sink = { type: 'drop', el: e.target };
    if (A.isTargetPage()) A.lastSink = sink;
    if (!wanted(files)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // Let the page's drop zone know the drag is over, so it un-highlights.
    A.passing = true;
    try {
      e.target.dispatchEvent(new DragEvent('dragleave', { bubbles: true, composed: true }));
    } finally {
      A.passing = false;
    }
    openPicker(sink, files);
  }

  // While we click an "Upload photo" button for the user, keep the native
  // file chooser from opening.
  function onClick(e) {
    if (A.suppressChooser > Date.now() && e.target instanceof HTMLInputElement && e.target.type === 'file') e.preventDefault();
  }

  window.addEventListener('input', onFileEvent, true);
  window.addEventListener('change', onFileEvent, true);
  window.addEventListener('drop', onDrop, true);
  window.addEventListener('click', onClick, true);

  const reset = (sink) => {
    if (sink.type === 'input' && sink.el.isConnected) sink.el.value = '';
  };

  function openPicker(sink, files) {
    const images = files.filter(isImage);
    const others = files.filter((f) => !isImage(f));
    const picks = images.map((file) => ({ file, on: false, room: 'auto' }));
    const fields = ui.stagingFields();
    const stageBtn = h('button', { class: 'btn primary' });
    const count = () => picks.filter((p) => p.on).length;
    const refresh = () => {
      const n = count();
      stageBtn.textContent = n ? `Stage ${n} & upload` : 'Choose photos to stage';
      stageBtn.disabled = !n || !SAF.settings.apiKey;
      allBox.checked = n === picks.length;
    };

    const tiles = picks.map((p) => {
      const box = h('input', { type: 'checkbox' });
      const room = SAF.select(SAF.ROOMS, 'auto', { disabled: true, onchange: () => (p.room = room.value), 'aria-label': 'Room type' });
      const tile = h('div', { class: 'tile' });
      const set = (on) => {
        p.on = box.checked = on;
        room.disabled = !on;
        tile.classList.toggle('on', on);
        refresh();
      };
      p.set = set;
      box.addEventListener('change', () => set(box.checked));
      const thumb = SAF.thumb(p.file, 360, 270);
      thumb.addEventListener('click', () => set(!p.on));
      tile.append(h('label', { class: 'check' }, box, 'Stage this photo'), thumb, h('div', { class: 'name', title: p.file.name }, p.file.name), room);
      return tile;
    });

    const allBox = h('input', { type: 'checkbox', onchange: () => picks.forEach((p) => p.set(allBox.checked)) });
    let decided = false;
    const done = (fn) => () => {
      decided = true;
      modal.close();
      fn();
    };

    const modal = ui.modal({
      wide: true,
      title: 'Stage these photos before uploading?',
      subtitle: `${images.length} photo${images.length === 1 ? '' : 's'} selected. Tick the empty rooms you want furnished; the rest upload as they are.`,
      body: [
        !SAF.settings.apiKey && h('p', { class: 'err' }, 'Add your API key in StagedAF settings to stage photos. ', h('button', { class: 'link', onclick: () => SAF.send({ type: 'saf:open-options' }) }, 'Open settings')),
        h('label', { class: 'row', style: 'margin-bottom:12px;font-weight:600;cursor:pointer' }, allBox, 'Select all'),
        h('div', { class: 'grid' }, tiles),
        h('div', { class: 'opts' }, fields.styleField, fields.customField),
      ],
      footer: [
        h('button', { class: 'btn', onclick: done(() => reset(sink)) }, 'Cancel upload'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: done(() => A.deliver(sink, files)) }, 'Upload without staging'),
        stageBtn,
      ],
      onClose: () => !decided && reset(sink),
    });
    stageBtn.addEventListener('click', done(() => startBatch(sink, picks, others, fields.values())));
    refresh();
  }

  function startBatch(sink, picks, others, { style, custom }) {
    const batch = { sink, others, state: 'staging', modal: null };
    batch.items = picks.map((p) => ({
      file: p.file,
      choice: p.on ? 'staged' : 'original',
      job: p.on ? SAF.createJob({ name: p.file.name, source: { file: p.file }, room: p.room, style, custom, origin: 'upload', meta: { batch } }) : null,
    }));
    SAF.batches.push(batch);
    SAF.emit('batches');
    const jobs = batch.items.filter((it) => it.job).map((it) => it.job);
    ui.toast(`Staging ${jobs.length} photo${jobs.length === 1 ? '' : 's'}. Nothing uploads until they're ready — keep this page open.`);
    Promise.all(jobs.map((j) => j.finished)).then(() => {
      if (!SAF.batches.includes(batch)) return;
      batch.state = 'ready';
      SAF.emit('batches');
      const allGood = jobs.every((j) => j.status === 'done');
      if (allGood && !SAF.settings.reviewBeforeUpload) SAF.finalizeBatch(batch);
      else SAF.reviewBatch(batch);
    });
  }

  const dropBatch = (batch) => {
    SAF.batches = SAF.batches.filter((b) => b !== batch);
    for (const it of batch.items) if (it.job) SAF.removeJob(it.job);
    SAF.emit('batches');
  };

  SAF.discardBatch = (batch) => {
    reset(batch.sink);
    dropBatch(batch);
  };

  SAF.finalizeBatch = async (batch) => {
    const files = [];
    const staged = [];
    for (const it of batch.items) {
      const ok = it.job && it.job.status === 'done';
      if (ok && it.choice !== 'original') {
        const f = SAF.jobFile(it.job);
        files.push(f);
        staged.push(f);
      }
      if (!ok || it.choice !== 'staged') files.push(it.file);
    }
    files.push(...batch.others);

    let sink = batch.sink;
    if (!sink.el.isConnected) {
      if (A.lastSink === sink) A.lastSink = null;
      sink = await A.findSink();
    }
    if (!sink) {
      for (const f of staged) await SAF.download(f, f.name).catch(() => {});
      ui.toast("AppFolio's uploader is no longer on this page, so the staged photos were saved to Downloads/StagedAF. Upload them from there.", { kind: 'error', ms: 20000 });
    } else {
      try {
        await A.deliver(sink, files);
        ui.toast(`${files.length} file${files.length === 1 ? '' : 's'} handed to AppFolio's uploader (${staged.length} staged).`, { kind: 'ok' });
      } catch (e) {
        ui.toast('Could not hand the photos to AppFolio: ' + ((e && e.message) || e), { kind: 'error', ms: 15000 });
        return;
      }
    }
    dropBatch(batch);
  };
})();
