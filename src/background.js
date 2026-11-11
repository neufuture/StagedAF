// Service worker. Deliberately tiny: staging calls can take a minute or more,
// which is longer than a service worker is guaranteed to live, so the actual
// work runs in an offscreen document (src/offscreen.js). This worker only
// creates that document, hands out settings, and saves downloads.
importScripts('shared/defaults.js');

const SAF = globalThis.SAF;
let creating = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: 'src/offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Resize photos and wait for long-running image staging requests.',
      })
      .catch((e) => {
        if (!/single offscreen/i.test(String(e && e.message))) throw e;
      })
      .finally(() => (creating = null));
  }
  await creating;
}

async function getSettings() {
  return { ...SAF.DEFAULTS, ...(await chrome.storage.local.get(null)) };
}

function safeName(name) {
  return String(name || 'photo.jpg').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const reply = (p) =>
    p.then((v) => sendResponse({ ok: true, value: v })).catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  switch (msg && msg.type) {
    case 'saf:ensure-offscreen':
      reply(ensureOffscreen());
      return true;
    case 'saf:get-settings':
      reply(getSettings());
      return true;
    case 'saf:download':
      reply(chrome.downloads.download({ url: msg.url, filename: 'StagedAF/' + safeName(msg.filename), saveAs: false }));
      return true;
    case 'saf:open-options':
      reply(chrome.runtime.openOptionsPage());
      return true;
  }
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
