// The small StagedAF panel in the bottom-right corner: the "Stage new
// uploads" switch, the queue, and links to settings / diagnostics.
(() => {
  const SAF = globalThis.SAF;
  const { h, ui } = SAF;
  const A = SAF.appfolio;

  let dock = null;
  let minimized = false;

  const STATUS = { queued: 'Waiting', running: 'Staging…', done: 'Ready', error: 'Failed', cancelled: 'Cancelled' };

  async function copyDiagnostics() {
    const text = JSON.stringify(A.diagnostics(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      ui.toast('Page diagnostics copied. They describe page structure only — no names, addresses or photos.', { kind: 'ok' });
    } catch {
      ui.modal({ title: 'Page diagnostics', subtitle: 'Copy this text.', body: h('textarea', { style: 'height:320px;font:12px ui-monospace,monospace', value: text, readOnly: true }) });
    }
  }

  const statusText = (job) => (job.status === 'running' ? 'Staging… ' + SAF.elapsed(job) : STATUS[job.status]);

  function jobRow(job) {
    const actions = [];
    if (job.origin === 'existing') {
      if (job.status === 'done') actions.push(h('button', { class: 'link', onclick: () => SAF.reviewExisting(job) }, 'Review'));
      if (job.status === 'error') actions.push(h('button', { class: 'link', onclick: () => SAF.retryJob(job).then(SAF.existingJobDone) }, 'Retry'));
      actions.push(h('button', { class: 'link', title: 'Remove from queue', onclick: () => SAF.removeJob(job) }, '✕'));
    }
    const shortName = String(job.name).split(/[?#]/)[0].split('/').pop();
    return h('div', { class: 'job', title: job.error || '' }, h('span', { class: 'dot ' + job.status }), h('span', { class: 'nm grow' }, shortName), (job.statusEl = h('span', { class: 'muted' }, statusText(job))), actions);
  }

  function render() {
    if (!dock) return;
    const show = A.isTargetPage() || SAF.jobs.length > 0;
    dock.style.display = show ? '' : 'none';
    if (!show) return;
    const active = SAF.activeJobs().length;
    const ready = SAF.batches.filter((b) => b.state === 'ready');
    dock.className = 'dock' + (minimized ? ' min' : '');
    const head = h('div', { class: 'head', role: 'button', tabIndex: 0, 'aria-expanded': String(!minimized), onclick: () => ((minimized = !minimized), render()) },
      h('b', null, '✦ StagedAF'), active > 0 && h('span', { class: 'count' }, String(active)), ready.length > 0 && h('span', { class: 'count', style: 'background:#059669' }, 'Review'), h('span', { class: 'caret' }, minimized ? '▲' : '▼'));
    if (minimized) return dock.replaceChildren(head);

    const toggle = h('input', { type: 'checkbox', checked: !!SAF.settings.stageUploads, onchange: () => SAF.saveSetting('stageUploads', toggle.checked) });
    const parts = [
      head,
      !SAF.settings.apiKey && h('div', { class: 'warn' }, 'Add your image API key to start staging. ', h('button', { class: 'link', onclick: () => SAF.send({ type: 'saf:open-options' }) }, 'Open settings')),
      h('div', { class: 'sect' }, h('label', { class: 'switch' }, toggle, 'Stage new uploads'),
        h('div', { class: 'muted', style: 'margin-top:6px' }, SAF.settings.stageUploads ? "Upload photos as usual — you'll pick which ones to stage before anything is sent." : 'Off: uploads go straight to AppFolio. Use the Stage button on any existing photo.')),
      ready.map((b) => h('div', { class: 'sect row' }, h('span', { class: 'grow' }, `${b.items.length} photos ready`), h('button', { class: 'btn small primary', onclick: () => SAF.reviewBatch(b) }, 'Review & upload'))),
      SAF.jobs.length > 0 && h('div', { class: 'sect jobs' }, SAF.jobs.map(jobRow)),
      h('div', { class: 'sect row' }, h('button', { class: 'link', onclick: () => SAF.send({ type: 'saf:open-options' }) }, 'Settings'), h('span', { class: 'spacer grow' }), h('button', { class: 'link', title: 'Copies a description of this page’s structure, for troubleshooting photo detection', onclick: copyDiagnostics }, 'Copy page diagnostics')),
    ];
    dock.replaceChildren(...parts.flat().filter(Boolean));
  }

  SAF.startDock = () => {
    dock = h('div', { class: 'dock' });
    ui.root().append(dock);
    for (const ev of ['jobs', 'batches', 'settings', 'navigate']) SAF.on(ev, render);
    render();
    // Tick the elapsed time on running jobs without rebuilding the panel.
    setInterval(() => {
      for (const job of SAF.jobs) if (job.status === 'running' && job.statusEl) job.statusEl.textContent = statusText(job);
    }, 1000);
  };
})();
