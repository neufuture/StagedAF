// Everything that touches AppFolio's own page lives here. AppFolio has no
// public API for photos, so this drives the page the way a person would:
// finding photos, handing files to the uploader, clicking delete.
//
// AppFolio's "Photos" card on unit and property pages (the AF selectors
// below) is recognised directly. On any page without that card, detection
// falls back to heuristics. The three selectors in settings override both,
// and "Copy page diagnostics" in the dock reports what was found.
(() => {
  const SAF = globalThis.SAF;
  const A = (SAF.appfolio = {});

  A.passing = false; // true while we dispatch our own events at the page
  A.lastSink = null; // the upload control the user last used on this page

  A.isTargetPage = () => {
    try {
      return new RegExp(SAF.settings.pagePattern || '.', 'i').test(location.pathname);
    } catch {
      return true;
    }
  };

  // AppFolio's Photos card, as rendered on unit / property pages.
  const AF = {
    section: '.js-attached-photos',
    photo: '.js-attached-photo',
    img: '.js-attached-photos .js-attached-photo img',
    input: '.js-attached-photos-form input[type="file"]',
    del: 'a[data-method="delete"][href*="/photos/"]',
    defaultFlag: '.js-attached-photo-actions-default-flag',
    makeDefault: '.js-attached-photo-actions-make-default',
    otherUploads: '.js-attached-files, .js-attached-files-form', // documents, not photos
  };
  const hasPhotosCard = () => !!document.querySelector(AF.section);

  // Is this element part of the photo uploader (as opposed to, say, the
  // document attachments uploader on the same page)?
  A.isPhotoUpload = (el) => {
    if (!el || !el.closest) return false;
    if (el.closest(AF.otherUploads)) return false;
    return hasPhotosCard() ? !!el.closest(AF.section) : true;
  };

  const q = (sel, root = document) => {
    try {
      return [...root.querySelectorAll(sel)];
    } catch {
      return [];
    }
  };

  // ---- Photos -------------------------------------------------------------

  const NOT_PHOTO = /logo|avatar|icon|sprite|signature|captcha|badge|spinner|placeholder|staticmap|maps\.g/i;

  function looksLikePhoto(img) {
    if (SAF.ui.isOurs(img)) return false;
    const src = img.currentSrc || img.src || '';
    if (!src || /^data:image\/svg|\.svg(\?|$)|\.gif(\?|$)/i.test(src)) return false;
    if (NOT_PHOTO.test(src + ' ' + img.className + ' ' + img.alt + ' ' + img.id)) return false;
    if (img.closest('header, nav, footer, [role="navigation"], [role="banner"]')) return false;
    const min = Number(SAF.settings.minPhotoSize) || 100;
    const r = img.getBoundingClientRect();
    if (r.width < min || r.height < min * 0.6) return false;
    if (img.complete && img.naturalWidth && img.naturalWidth < 150) return false;
    return true;
  }

  A.findPhotos = () => {
    const sel = (SAF.settings.photoSelector || '').trim();
    if (sel) {
      return q(sel)
        .map((el) => (el.matches('img') ? el : el.querySelector('img')))
        .filter((img) => img && !SAF.ui.isOurs(img));
    }
    if (hasPhotosCard()) return q(AF.img);
    return [...document.images].filter(looksLikePhoto);
  };

  // AppFolio keeps the uploaded file name in the image's alt text.
  A.photoName = (img) => (/\.[a-z0-9]{2,5}$/i.test(img.alt || '') ? img.alt : A.bestUrl(img));

  A.isDefault = (img) => {
    const card = img.closest(AF.photo);
    const flag = card && card.querySelector(AF.defaultFlag);
    return !!flag && !flag.classList.contains('d-none') && getComputedStyle(flag).display !== 'none';
  };

  A.makeDefault = async (img) => {
    const card = img.closest(AF.photo);
    const link = card && card.querySelector(AF.makeDefault);
    if (!link) return false;
    link.click();
    for (let i = 0; i < 20; i++) {
      await SAF.sleep(250);
      if (!img.isConnected || A.isDefault(img)) return true;
    }
    return false;
  };

  A.photoKey = (img) => img.currentSrc || img.src || '';

  const IMG_URL = /\.(jpe?g|png|webp)(\?|#|$)/i;

  // The best (largest) URL we can find for a photo: a link to the full image,
  // a data attribute, the biggest srcset candidate, else what is displayed.
  A.bestUrl = (img) => {
    const abs = (u) => {
      try {
        return new URL(u, location.href).href;
      } catch {
        return '';
      }
    };
    const link = img.closest('a[href]');
    if (link && IMG_URL.test(link.getAttribute('href'))) return abs(link.getAttribute('href'));
    for (const el of [img, img.parentElement]) {
      if (!el) continue;
      for (const name of ['data-full', 'data-original', 'data-large', 'data-zoom', 'data-full-src', 'data-original-url', 'data-large-url', 'data-url']) {
        const v = el.getAttribute(name);
        if (v && /^(https?:)?\/|^\w/.test(v) && (IMG_URL.test(v) || name !== 'data-url')) return abs(v);
      }
    }
    if (img.srcset) {
      const best = img.srcset
        .split(',')
        .map((s) => s.trim().split(/\s+/))
        .map(([u, d]) => [u, parseFloat(d) || 1])
        .sort((a, b) => b[1] - a[1])[0];
      if (best && best[0]) return abs(best[0]);
    }
    return abs(A.photoKey(img));
  };

  // ---- Controls near a photo ----------------------------------------------

  const CLICKABLE = 'button, a, [role="button"], input[type="button"], input[type="submit"], [data-method]';

  // Everything about a control that could say what it does.
  function signature(el) {
    const parts = [el.textContent, el.value, el.className, el.id, el.title, el.name];
    for (const a of ['aria-label', 'data-testid', 'data-test', 'data-method', 'data-action', 'data-confirm', 'data-original-title', 'href'])
      parts.push(el.getAttribute(a));
    for (const child of q('svg, i, span, use, img', el)) parts.push(child.getAttribute('class'), child.getAttribute('aria-label'), child.getAttribute('title'), child.getAttribute('href'), child.getAttribute('alt'));
    return parts.filter((p) => typeof p === 'string' && p).join(' ').replace(/\s+/g, ' ').trim();
  }

  const DELETE = /(^|[^a-z])(delete|remove|trash|destroy|discard)([^a-z]|$)/i;
  const OTHER_THING = /\b(property|properties|unit|listing|tenant|lease|owner|account|document|note)\b/i;

  // Walk up from the photo to the smallest container that holds this one
  // photo and a delete control: that is the photo's "card".
  A.findDelete = (img) => {
    const custom = (SAF.settings.deleteSelector || '').trim();
    const afCard = img.closest(AF.photo);
    if (!custom && afCard) return afCard.querySelector(AF.del);
    const photos = A.findPhotos();
    const ir = img.getBoundingClientRect();
    let node = img.parentElement;
    for (let depth = 0; node && depth < 6 && node !== document.body; depth++, node = node.parentElement) {
      if (photos.filter((p) => node.contains(p)).length > 1) break;
      // Never wander far from the photo: a page-level "Delete unit" button
      // must not be mistaken for the photo's own delete control.
      const nr = node.getBoundingClientRect();
      if (nr.width > ir.width * 2.5 + 80 || nr.height > ir.height * 2.5 + 160) break;
      const hit = custom
        ? q(custom, node)[0]
        : q(CLICKABLE, node).find((el) => {
            if (el.disabled) return false;
            const sig = signature(el);
            return DELETE.test(sig) && !(OTHER_THING.test(sig) && !/photo|image|picture/i.test(sig));
          });
      if (hit) return hit;
    }
    return null;
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };

  const CONFIRM_BOX = '[role="dialog"], [role="alertdialog"], dialog[open], .modal, .ReactModal__Content, [class*="modal" i], [class*="dialog" i], [class*="popover" i], [class*="confirm" i]';
  const CONFIRM_YES = /^\s*(yes\b.*|ok|okay|confirm|continue|delete\b.*|remove\b.*)\s*$/i;

  // Click AppFolio's delete control for this photo and wait for it to go away.
  A.deletePhoto = async (key) => {
    const find = () => A.findPhotos().find((p) => A.photoKey(p) === key);
    const img = find();
    if (!img) return { ok: false, reason: "Couldn't find the original photo on the page any more." };
    const del = A.findDelete(img);
    if (!del) return { ok: false, reason: "Couldn't find AppFolio's delete button for the original photo." };

    document.dispatchEvent(new CustomEvent('saf:auto-confirm'));
    const boxesBefore = new Set(q(CONFIRM_BOX).filter(visible));
    // AppFolio names its confirm button on the link itself ("Delete").
    const yesText = (del.getAttribute('data-confirm-continue') || '').trim().toLowerCase();
    const isYes = (b) => {
      const text = (b.textContent || b.value || '').trim();
      return yesText ? text.toLowerCase() === yesText : CONFIRM_YES.test(text);
    };
    del.click();
    let confirmed = false;
    try {
      for (let i = 0; i < 40; i++) {
        await SAF.sleep(250);
        if (!find()) return { ok: true };
        if (confirmed) continue;
        // An in-page "Are you sure?" dialog that appeared after our click.
        for (const box of q(CONFIRM_BOX).filter((b) => visible(b) && !boxesBefore.has(b) && !SAF.ui.isOurs(b))) {
          const yes = q(CLICKABLE, box).find((b) => visible(b) && isYes(b));
          if (yes) {
            yes.click();
            confirmed = true;
            break;
          }
        }
      }
    } finally {
      document.dispatchEvent(new CustomEvent('saf:auto-confirm-off'));
    }
    return { ok: false, reason: confirmed ? 'Clicked delete, but the original photo is still showing.' : "AppFolio's delete confirmation may still be open — confirm it to finish." };
  };

  // ---- Uploading ----------------------------------------------------------

  const acceptsImages = (input) => !input.disabled && (!input.accept || /image|jpe?g|png|\*/i.test(input.accept));

  function fileInputs() {
    return q('input[type="file"]').filter((i) => !SAF.ui.isOurs(i) && acceptsImages(i));
  }

  function pickInput(near) {
    const custom = (SAF.settings.uploadInputSelector || '').trim();
    if (custom) return q(custom).find((el) => el.matches('input[type="file"]')) || null;
    if (hasPhotosCard()) return q(AF.input)[0] || q('input[type="file"]', document.querySelector(AF.section))[0] || null;
    const inputs = fileInputs().filter((i) => !i.closest(AF.otherUploads));
    if (!inputs.length) return null;
    // Closest to the photo in the DOM tree wins.
    for (let node = near && near.parentElement; node; node = node.parentElement) {
      const hit = inputs.find((i) => node.contains(i));
      if (hit) return hit;
    }
    const photoish = /photo|image|picture|gallery|marketing|media/i;
    return inputs.find((i) => photoish.test(signature(i) + ' ' + signature(i.parentElement || i))) || inputs[0];
  }

  const UPLOAD_TRIGGER = /\b(add|upload|new|manage|edit)\s+(more\s+)?(marketing\s+)?(photos?|images?|pictures?)\b/i;

  // Where staged files should be handed to AppFolio. Returns
  // {type:'input'|'drop', el} or null.
  A.findSink = async (near) => {
    let input = pickInput(near);
    if (!input && A.lastSink && A.lastSink.el.isConnected) return A.lastSink;
    if (!input) {
      // Some uploaders only create their file input once "Upload photo" is
      // clicked. Click it for the user, with the file chooser suppressed.
      const trigger = q(CLICKABLE).find((el) => !SAF.ui.isOurs(el) && visible(el) && UPLOAD_TRIGGER.test(signature(el)));
      if (trigger) {
        A.suppressChooser = Date.now() + 3000;
        trigger.click();
        for (let i = 0; i < 12 && !input; i++) {
          await SAF.sleep(250);
          input = pickInput(near);
        }
      }
    }
    return input ? { type: 'input', el: input } : null;
  };

  function dispatch(fn) {
    A.passing = true;
    try {
      fn();
    } finally {
      A.passing = false;
    }
  }

  function toTransfer(files) {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    return dt;
  }

  function giveToInput(input, files) {
    input.files = toTransfer(files).files;
    dispatch(() => {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  // Hand files to AppFolio's uploader exactly as if the user had picked them.
  A.deliver = async (sink, files) => {
    if (!files.length) return;
    if (sink.type === 'drop') {
      dispatch(() => {
        for (const type of ['dragenter', 'dragover', 'drop'])
          sink.el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: toTransfer(files) }));
      });
      return;
    }
    if (sink.el.multiple || files.length === 1) return giveToInput(sink.el, files);
    // A single-file input: feed it one photo at a time.
    for (const file of files) {
      const before = A.snapshot();
      if (!sink.el.isConnected) sink = (await A.findSink()) || sink;
      giveToInput(sink.el, [file]);
      await A.waitForNewPhoto(before, 20000);
    }
  };

  // Resolves with the new <img> once a photo that wasn't there before shows up
  // with a real (uploaded) URL; null on timeout. blob:/data: previews don't count.
  //
  // In AppFolio's Photos card the test is the list entry instead: a new
  // entry with its own photo id (or simply one more entry than before),
  // whatever its thumbnail looks like.
  A.snapshot = () => ({
    keys: new Set(A.findPhotos().map(A.photoKey)),
    cards: new Set(q(AF.section + ' ' + AF.photo)),
    ids: new Set(q(AF.section + ' ' + AF.photo).map((c) => c.getAttribute('data-photo-id')).filter(Boolean)),
  });

  A.waitForNewPhoto = async (before, timeout = 90000) => {
    const end = Date.now() + timeout;
    let extraSince = 0;
    while (Date.now() < end) {
      await SAF.sleep(400);
      if (hasPhotosCard()) {
        const cards = q(AF.section + ' ' + AF.photo);
        const byId = cards.find((c) => c.getAttribute('data-photo-id') && !before.ids.has(c.getAttribute('data-photo-id')));
        if (byId) return byId.querySelector('img') || byId;
        // No id on the new entry: accept one that has stayed put for 2 seconds.
        const extra = cards.filter((c) => !before.cards.has(c));
        if (extra.length && cards.length > before.cards.size) {
          extraSince = extraSince || Date.now();
          if (Date.now() - extraSince > 2000) return extra[extra.length - 1].querySelector('img') || extra[extra.length - 1];
        } else extraSince = 0;
        continue;
      }
      const added = A.findPhotos().find((p) => !before.keys.has(A.photoKey(p)) && /^https?:/i.test(A.photoKey(p)) && p.complete && p.naturalWidth > 0);
      if (added) return added;
    }
    return null;
  };

  // ---- Diagnostics --------------------------------------------------------

  const shape = (el) => {
    if (!el || !el.tagName) return '';
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 4).join('.') : '';
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id.replace(/\d+/g, 'N') : '') + cls;
  };
  const chain = (el, n = 6) => {
    const out = [];
    for (let node = el; node && node !== document.body && out.length < n; node = node.parentElement) out.push(shape(node));
    return out;
  };
  const redact = (u) => {
    try {
      const url = new URL(u, location.href);
      return url.host + url.pathname.replace(/[0-9a-f]{6,}|\d+/gi, 'N');
    } catch {
      return String(u).slice(0, 30);
    }
  };

  // A structural summary of the page (no names, addresses or image contents)
  // that can be pasted into a bug report to tune the selectors.
  A.diagnostics = () => {
    const photos = A.findPhotos();
    return {
      stagedaf: chrome.runtime.getManifest().version,
      page: location.pathname.replace(/\d+/g, 'N'),
      matchesPagePattern: A.isTargetPage(),
      appfolioPhotosCard: hasPhotosCard(),
      photoCount: photos.length,
      photos: photos.slice(0, 4).map((img) => {
        const r = img.getBoundingClientRect();
        const del = A.findDelete(img);
        const card = img.parentElement && img.parentElement.parentElement;
        return {
          size: `${Math.round(r.width)}x${Math.round(r.height)} (natural ${img.naturalWidth}x${img.naturalHeight})`,
          src: redact(A.photoKey(img)),
          best: redact(A.bestUrl(img)),
          chain: chain(img),
          deleteFound: del ? signature(del).slice(0, 100) : null,
          nearbyControls: card ? q(CLICKABLE, card.parentElement || card).slice(0, 8).map((el) => shape(el) + ' :: ' + signature(el).replace(/https?:\S+/g, (u) => redact(u)).slice(0, 80)) : [],
        };
      }),
      fileInputs: q('input[type="file"]').filter((i) => !SAF.ui.isOurs(i)).map((i) => ({ accept: i.accept, multiple: i.multiple, name: i.name, visible: visible(i), chain: chain(i) })),
      uploadTriggers: q(CLICKABLE).filter((el) => !SAF.ui.isOurs(el) && /photo|image|upload|picture/i.test(signature(el))).slice(0, 10).map((el) => shape(el) + ' :: ' + signature(el).replace(/https?:\S+/g, (u) => redact(u)).slice(0, 80)),
    };
  };
})();
