// Content-script basics: settings, a tiny event bus, DOM helper, messaging.
(() => {
  const SAF = globalThis.SAF;

  const listeners = {};
  SAF.on = (name, fn) => (listeners[name] = listeners[name] || []).push(fn);
  SAF.emit = (name, data) => (listeners[name] || []).forEach((fn) => {
    try {
      fn(data);
    } catch (e) {
      console.error('[StagedAF]', e);
    }
  });

  SAF.settings = { ...SAF.DEFAULTS };
  SAF.loadSettings = async () => {
    Object.assign(SAF.settings, SAF.DEFAULTS, await chrome.storage.local.get(null));
    SAF.emit('settings');
    return SAF.settings;
  };
  SAF.saveSetting = (key, value) => {
    SAF.settings[key] = value;
    SAF.emit('settings');
    return chrome.storage.local.set({ [key]: value });
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [k, c] of Object.entries(changes)) SAF.settings[k] = c.newValue === undefined ? SAF.DEFAULTS[k] : c.newValue;
    SAF.emit('settings');
  });

  SAF.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Message the service worker. Rejects with a readable error if the
  // extension was reloaded while this page stayed open.
  SAF.send = async (msg) => {
    let res;
    try {
      res = await chrome.runtime.sendMessage(msg);
    } catch {
      throw new Error('StagedAF was updated or reloaded. Refresh this page to keep using it.');
    }
    if (!res || !res.ok) throw new Error((res && res.error) || 'StagedAF background error');
    return res.value;
  };

  SAF.download = async (blobOrUrl, filename) => {
    const url = typeof blobOrUrl === 'string' ? blobOrUrl : await SAF.blobToDataUrl(blobOrUrl);
    return SAF.send({ type: 'saf:download', url, filename });
  };

  // h('div', {class:'x', onclick: fn}, child, 'text', ...)
  SAF.h = (tag, attrs, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k in el && k !== 'list') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c);
    return el;
  };

  SAF.select = (options, value, attrs) =>
    SAF.h('select', attrs, options.map(([v, label]) => SAF.h('option', { value: v, selected: v === value }, label)));

  SAF.stagedName = (name) => {
    const base = String(name || 'photo').split(/[?#]/)[0].split('/').pop().replace(/\.[a-z0-9]{2,5}$/i, '') || 'photo';
    return base.replace(/[^\w.-]+/g, '_').slice(0, 80) + '-staged.jpg';
  };
})();
