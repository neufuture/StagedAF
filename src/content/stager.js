// The staging queue. A job is one photo to stage; jobs run a few at a time
// through the offscreen document and survive the service worker going idle.
(() => {
  const SAF = globalThis.SAF;
  let seq = 0;
  let running = 0;

  SAF.jobs = [];

  // source: {file: File|Blob} or {url: string}
  SAF.createJob = ({ name, source, room, style, custom, origin, meta }) => {
    const job = {
      id: ++seq,
      name: name || 'photo',
      source,
      room: room || 'auto',
      style: style || SAF.settings.style,
      custom: custom || '',
      origin,
      meta: meta || {},
      status: 'queued', // queued | running | done | error | cancelled
      error: '',
      beforeBlob: source.file || null,
      resultBlob: null,
      port: null,
    };
    job.finished = new Promise((resolve) => (job.settle = resolve));
    SAF.jobs.push(job);
    SAF.emit('jobs', job);
    pump();
    return job;
  };

  SAF.retryJob = (job) => {
    if (job.status === 'running' || job.status === 'queued') return job.finished;
    job.status = 'queued';
    job.error = '';
    job.resultBlob = null;
    job.finished = new Promise((resolve) => (job.settle = resolve));
    SAF.emit('jobs', job);
    pump();
    return job.finished;
  };

  SAF.cancelJob = (job) => {
    if (job.status === 'queued') finish(job, 'cancelled');
    else if (job.status === 'running' && job.port) {
      try {
        job.port.disconnect();
      } catch {}
      job.cancelled = true;
    }
  };

  SAF.removeJob = (job) => {
    SAF.cancelJob(job);
    SAF.jobs = SAF.jobs.filter((j) => j !== job);
    SAF.emit('jobs', job);
  };

  SAF.activeJobs = () => SAF.jobs.filter((j) => j.status === 'queued' || j.status === 'running');

  function finish(job, status, error) {
    job.status = status;
    job.error = error || '';
    job.port = null;
    SAF.emit('jobs', job);
    job.settle(job);
  }

  function pump() {
    const limit = Math.max(1, Math.min(4, Number(SAF.settings.concurrency) || 2));
    while (running < limit) {
      const job = SAF.jobs.find((j) => j.status === 'queued');
      if (!job) return;
      job.status = 'running';
      job.startedAt = Date.now();
      running++;
      SAF.emit('jobs', job);
      run(job)
        .then(() => finish(job, 'done'))
        .catch((e) => finish(job, job.cancelled ? 'cancelled' : 'error', String((e && e.message) || e)))
        .finally(() => {
          running--;
          job.cancelled = false;
          pump();
        });
    }
  }

  function remote(job, payload) {
    return new Promise((resolve, reject) => {
      let port;
      try {
        port = chrome.runtime.connect({ name: 'saf-stage' });
      } catch {
        return reject(new Error('StagedAF was updated or reloaded. Refresh this page to keep using it.'));
      }
      job.port = port;
      let settled = false;
      // Staging normally takes 30 seconds to 2 minutes. Give up after 5.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('The image service took more than 5 minutes to answer, so this was stopped. Try again, or use a lower quality in settings.'));
        port.disconnect();
      }, 5 * 60 * 1000);
      port.onMessage.addListener((msg) => {
        if (settled) return;
        clearTimeout(timer);
        settled = true;
        if (msg.type === 'done') resolve(msg);
        else reject(Object.assign(new Error(msg.error || 'Staging failed'), { code: msg.code }));
        port.disconnect();
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        clearTimeout(timer);
        if (!settled) reject(new Error(job.cancelled ? 'Cancelled' : 'Lost connection to the staging worker. Try again.'));
      });
      port.postMessage({ type: 'run', job: payload });
    });
  }

  async function run(job) {
    const s = SAF.settings;
    if (!s.apiKey) throw new Error('Add your API key in StagedAF settings first.');
    await SAF.send({ type: 'saf:ensure-offscreen' });
    const prompt = SAF.buildPrompt({ basePrompt: s.basePrompt, room: job.room, style: job.style, custom: job.custom });

    let source;
    if (job.source.file) {
      const norm = await SAF.normalizeImage(job.source.file, Number(s.maxInputEdge) || 2048);
      source = { dataUrl: await SAF.blobToDataUrl(norm.blob) };
    } else source = { url: job.source.url };

    let out;
    try {
      out = await remote(job, { source, prompt, wantInput: !job.beforeBlob });
    } catch (e) {
      if (e.code !== 'fetch-source' || !job.source.url) throw e;
      // The extension has no access to this image host; try as the page.
      let blob;
      try {
        const res = await fetch(job.source.url);
        if (!res.ok) throw 0;
        blob = await res.blob();
      } catch {
        let host = '';
        try {
          host = new URL(job.source.url).host;
        } catch {}
        throw new Error(`StagedAF can't download photos from ${host || 'this image host'}. Open StagedAF settings → "Image host access" and grant it.`);
      }
      const norm = await SAF.normalizeImage(blob, Number(s.maxInputEdge) || 2048);
      job.beforeBlob = norm.blob;
      out = await remote(job, { source: { dataUrl: await SAF.blobToDataUrl(norm.blob) }, prompt });
    }
    if (out.inputDataUrl && !job.beforeBlob) job.beforeBlob = SAF.dataUrlToBlob(out.inputDataUrl);
    let result = SAF.dataUrlToBlob(out.dataUrl);
    if (s.disclosureLabel && s.disclosureText) result = await SAF.addLabel(result, s.disclosureText);
    job.resultBlob = result;
  }

  // "0:42" since the job started running.
  SAF.elapsed = (job) => {
    const sec = Math.max(0, Math.floor((Date.now() - (job.startedAt || Date.now())) / 1000));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  };

  SAF.jobFile = (job) => new File([job.resultBlob], SAF.stagedName(job.name), { type: 'image/jpeg' });
})();
