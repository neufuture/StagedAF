// Before/after review, and the "replace an existing photo" routine.
(() => {
  const SAF = globalThis.SAF;
  const { h, ui } = SAF;
  const A = SAF.appfolio;

  const pair = (job) =>
    h(
      'div',
      { class: 'pair' },
      h('figure', null, h('figcaption', null, 'Original'), job.beforeBlob ? SAF.thumb(job.beforeBlob, 900, 700) : h('div', { class: 'muted' }, 'No preview')),
      h('figure', null, h('figcaption', null, 'Staged'), job.resultBlob ? SAF.thumb(job.resultBlob, 900, 700) : h('div', { class: 'muted' }, 'No preview'))
    );

  const originalName = (name) => {
    const base = (String(name).split(/[?#]/)[0].split('/').pop() || 'photo').replace(/[^\w.-]+/g, '_');
    return 'original-' + (/\.[a-z0-9]{2,5}$/i.test(base) ? base : base + '.jpg');
  };

  // Upload the staged photo, then (optionally) delete the original. The
  // original is only deleted after the staged photo is confirmed on the page.
  SAF.replaceExisting = async (job, { deleteOriginal }) => {
    const key = job.meta.key;
    const img = A.findPhotos().find((p) => A.photoKey(p) === key);
    const file = SAF.jobFile(job);
    job.meta.replacing = true;
    SAF.emit('jobs', job);
    try {
      const sink = await A.findSink(img);
      if (!sink) {
        await SAF.download(job.resultBlob, file.name).catch(() => {});
        ui.toast("Couldn't find AppFolio's photo uploader on this page. The staged photo was saved to Downloads/StagedAF so you can add it by hand.", { kind: 'error', ms: 15000 });
        return false;
      }
      if (deleteOriginal && SAF.settings.backupOriginal) {
        await SAF.download(job.meta.url, originalName(job.name)).catch(() => (job.beforeBlob ? SAF.download(job.beforeBlob, originalName(job.name)) : null)).catch(() => {});
      }
      const wasDefault = !!img && A.isDefault(img);
      const before = new Set(A.findPhotos().map(A.photoKey));
      const closeToast = ui.toast('Uploading the staged photo to AppFolio…', { ms: 0 });
      await A.deliver(sink, [file]);
      const appeared = await A.waitForNewPhoto(before);
      closeToast();
      if (!appeared) {
        ui.toast("The staged photo was handed to AppFolio, but it hasn't shown up on the page, so the original was left alone. If AppFolio is waiting for a Save or Upload click, do that, then remove the original yourself.", { kind: 'error', ms: 20000 });
        return false;
      }
      if (!deleteOriginal) {
        ui.toast('Staged photo added. The original was kept.', { kind: 'ok' });
        SAF.removeJob(job);
        return true;
      }
      // If the original was the unit's default photo, hand that over first.
      const defaultMoved = wasDefault ? await A.makeDefault(appeared) : true;
      const res = await A.deletePhoto(key);
      if (res.ok) ui.toast('Photo replaced with the staged version.' + (defaultMoved ? '' : ' It was the default photo — pick a new default.'), { kind: 'ok', ms: defaultMoved ? 6000 : 15000 });
      else ui.toast(`The staged photo is uploaded, but the original is still there: ${res.reason} Please delete it by hand.`, { kind: 'error', ms: 20000 });
      SAF.removeJob(job);
      return res.ok;
    } catch (e) {
      ui.toast('Replacing the photo failed: ' + ((e && e.message) || e), { kind: 'error', ms: 15000 });
      return false;
    } finally {
      job.meta.replacing = false;
      SAF.emit('jobs', job);
    }
  };

  // Review one staged existing photo.
  SAF.reviewExisting = (job) => {
    if (job.meta.closeToast) job.meta.closeToast();
    const fields = ui.stagingFields({ style: job.style, custom: job.custom });
    const act = (fn) => () => {
      modal.close();
      fn();
    };
    const modal = ui.modal({
      wide: true,
      title: 'Review staged photo',
      subtitle: 'Check that the room itself is unchanged before replacing the original.',
      body: [
        pair(job),
        h('details', { style: 'margin-top:14px' }, h('summary', { class: 'muted', style: 'cursor:pointer' }, 'Not right? Adjust and regenerate'), h('div', { style: 'margin-top:10px' }, fields.styleField, fields.customField,
          h('button', { class: 'btn', onclick: act(() => {
            Object.assign(job, fields.values());
            SAF.retryJob(job).then(SAF.existingJobDone);
          }) }, 'Regenerate'))),
      ],
      footer: [
        h('button', { class: 'btn danger', onclick: act(() => SAF.removeJob(job)) }, 'Discard'),
        h('button', { class: 'btn', onclick: () => SAF.download(job.resultBlob, SAF.stagedName(job.name)).catch((e) => ui.toast(e.message, { kind: 'error' })) }, 'Download'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: act(() => SAF.replaceExisting(job, { deleteOriginal: false })) }, 'Add, keep original'),
        h('button', { class: 'btn primary', onclick: act(() => SAF.replaceExisting(job, { deleteOriginal: true })) }, 'Replace original'),
      ],
    });
  };

  // Review a batch of new uploads before they are handed to AppFolio.
  SAF.reviewBatch = (batch) => {
    if (batch.modal) return;
    const body = h('div');
    const uploadBtn = h('button', { class: 'btn primary', onclick: () => (close(), SAF.finalizeBatch(batch)) });
    const close = () => modal.close();

    const render = () => {
      const busy = batch.items.some((it) => it.job && ['queued', 'running'].includes(it.job.status));
      body.replaceChildren(
        ...batch.items
          .filter((it) => it.job)
          .map((it) => {
            const job = it.job;
            if (job.status === 'queued' || job.status === 'running')
              return h('div', { class: 'item' }, h('span', { class: 'spin dark' }), `Staging ${it.file.name}…`);
            if (job.status !== 'done') {
              it.choice = 'original';
              return h('div', { class: 'item' }, h('b', null, it.file.name), h('div', { class: 'err' }, job.error || 'Cancelled'),
                h('div', { class: 'bar' }, h('button', { class: 'btn small', onclick: () => SAF.retryJob(job) }, 'Retry'), h('span', { class: 'muted' }, 'Otherwise the original will be uploaded.')));
            }
            const seg = h('div', { class: 'seg' }, [['staged', 'Use staged'], ['original', 'Use original'], ['both', 'Upload both']].map(([v, label]) =>
              h('button', { class: it.choice === v ? 'on' : '', onclick: () => ((it.choice = v), render()) }, label)));
            const redo = h('input', { type: 'text', placeholder: 'Instructions for a redo (optional)', value: job.custom, style: 'border:1px solid #d1d5db;border-radius:8px;padding:5px 8px;font-size:12px' , class: 'grow' });
            return h('div', { class: 'item' }, pair(job),
              h('div', { class: 'bar' }, h('b', { class: 'nm' }, it.file.name), seg, redo,
                h('button', { class: 'btn small', onclick: () => ((job.custom = redo.value.trim()), (it.choice = 'staged'), SAF.retryJob(job)) }, 'Redo')));
          })
      );
      const n = batch.items.reduce((sum, it) => sum + (it.job && it.job.status === 'done' && it.choice === 'both' ? 2 : 1), 0) + batch.others.length;
      uploadBtn.textContent = `Upload ${n} file${n === 1 ? '' : 's'} to AppFolio`;
      uploadBtn.disabled = busy;
    };

    const onJobs = (job) => batch.modal && batch.items.some((it) => it.job === job) && render();
    SAF.on('jobs', onJobs);
    const modal = (batch.modal = ui.modal({
      wide: true,
      title: 'Review staged photos',
      subtitle: 'Nothing has been uploaded yet. Choose which version of each photo goes to AppFolio.',
      body,
      footer: [
        h('button', { class: 'btn danger', onclick: () => (close(), SAF.discardBatch(batch)) }, 'Discard all'),
        h('span', { class: 'muted' }, 'Close this to decide later — the batch stays in the StagedAF panel.'),
        h('span', { class: 'spacer' }),
        uploadBtn,
      ],
      onClose: () => (batch.modal = null),
    }));
    render();
  };
})();
