// All StagedAF UI lives in one shadow root so AppFolio's CSS and ours never
// collide. Styles use a constructable stylesheet, which a page CSP can't block.
(() => {
  const SAF = globalThis.SAF;
  const { h } = SAF;

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.root { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f2937; }
button, select, textarea, input { font: inherit; color: inherit; }
button { cursor: pointer; }
.btn { border: 1px solid #d1d5db; background: #fff; border-radius: 8px; padding: 7px 12px; font-weight: 600; font-size: 13px; }
.btn:hover { background: #f3f4f6; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn.primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }
.btn.primary:hover { background: #4338ca; }
.btn.danger { color: #b91c1c; }
.btn.small { padding: 4px 8px; font-size: 12px; border-radius: 6px; }
.link { background: none; border: 0; padding: 0; color: #4f46e5; font-weight: 600; font-size: 12px; }
.link:hover { text-decoration: underline; }
select, textarea { border: 1px solid #d1d5db; border-radius: 8px; padding: 6px 8px; background: #fff; width: 100%; }
textarea { resize: vertical; min-height: 56px; }
label.field { display: block; font-size: 12px; font-weight: 600; color: #4b5563; margin: 0 0 10px; }
label.field > * { margin-top: 4px; font-weight: 400; color: #1f2937; }
.muted { color: #6b7280; font-size: 12px; }
.err { color: #b91c1c; font-size: 12px; }
canvas.thumb { display: block; max-width: 100%; height: auto; border-radius: 6px; background: #e5e7eb; }

/* Stage chips over existing photos */
.chips { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; }
.chip { position: fixed; pointer-events: auto; border: 0; border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 700;
  background: rgba(17,24,39,.82); color: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.35); white-space: nowrap; }
.chip:hover { background: #4f46e5; }
.chip.busy { background: #4f46e5; cursor: progress; }
.chip.ready { background: #059669; }
.chip.failed { background: #b91c1c; }
.spin { display: inline-block; width: 10px; height: 10px; margin-right: 6px; border: 2px solid rgba(255,255,255,.4); border-top-color: #fff; border-radius: 50%;
  animation: saf-spin .8s linear infinite; vertical-align: -1px; }
.spin.dark { border-color: #c7d2fe; border-top-color: #4f46e5; }
@keyframes saf-spin { to { transform: rotate(360deg); } }

/* Popover */
.pop { position: fixed; z-index: 2147483200; width: 300px; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 14px;
  box-shadow: 0 12px 32px rgba(0,0,0,.22); }
.pop h3 { margin: 0 0 10px; font-size: 14px; }
.row { display: flex; gap: 8px; align-items: center; }
.row.end { justify-content: flex-end; }
.row.wrap { flex-wrap: wrap; }
.grow { flex: 1; min-width: 0; }

/* Modal */
.overlay { position: fixed; inset: 0; z-index: 2147483300; background: rgba(17,24,39,.55); display: flex; align-items: center; justify-content: center; padding: 16px; }
.modal { background: #fff; border-radius: 14px; width: min(980px, 100%); max-height: calc(100vh - 32px); display: flex; flex-direction: column;
  box-shadow: 0 24px 64px rgba(0,0,0,.35); }
.modal header { padding: 16px 20px 12px; border-bottom: 1px solid #e5e7eb; }
.modal header h2 { margin: 0; font-size: 17px; }
.modal header p { margin: 4px 0 0; }
.modal .body { padding: 16px 20px; overflow: auto; }
.modal footer { padding: 12px 20px; border-top: 1px solid #e5e7eb; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.spacer { flex: 1; }

/* Upload picker */
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
.tile { border: 2px solid #e5e7eb; border-radius: 10px; padding: 8px; background: #fff; }
.tile.on { border-color: #4f46e5; background: #eef2ff; }
.tile .name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 6px 0; }
.tile label.check { display: flex; gap: 6px; align-items: center; font-weight: 600; font-size: 13px; cursor: pointer; margin-bottom: 6px; }
.tile canvas.thumb { width: 100%; cursor: pointer; }
.tile select { font-size: 12px; padding: 4px 6px; }
.opts { display: grid; grid-template-columns: 220px 1fr; gap: 12px; margin-top: 16px; }
@media (max-width: 640px) { .opts { grid-template-columns: 1fr; } }

/* Review */
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.pair figure { margin: 0; }
.pair figcaption { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; margin-bottom: 4px; }
.pair canvas.thumb { width: 100%; }
.item { border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px; margin-bottom: 12px; }
.item .bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
.seg { display: inline-flex; border: 1px solid #d1d5db; border-radius: 8px; overflow: hidden; }
.seg button { border: 0; background: #fff; padding: 5px 10px; font-size: 12px; font-weight: 600; }
.seg button + button { border-left: 1px solid #d1d5db; }
.seg button.on { background: #4f46e5; color: #fff; }

/* Dock */
.dock { position: fixed; right: 16px; bottom: 16px; z-index: 2147483100; width: 300px; background: #fff; border: 1px solid #e5e7eb; border-radius: 14px;
  box-shadow: 0 8px 28px rgba(0,0,0,.2); overflow: hidden; }
.dock.min { width: auto; }
.dock .head { display: flex; align-items: center; gap: 8px; padding: 9px 12px; background: #111827; color: #fff; cursor: pointer; user-select: none; }
.dock .head b { font-size: 13px; }
.dock .head .count { background: #4f46e5; border-radius: 999px; padding: 0 7px; font-size: 11px; font-weight: 700; }
.dock .head .caret { margin-left: auto; opacity: .7; font-size: 11px; }
.dock .sect { padding: 10px 12px; border-top: 1px solid #f3f4f6; }
.dock .warn { background: #fef3c7; color: #92400e; font-size: 12px; padding: 8px 12px; }
.switch { display: flex; align-items: center; gap: 10px; cursor: pointer; font-weight: 600; font-size: 13px; }
.switch input { appearance: none; width: 34px; height: 20px; border-radius: 999px; background: #d1d5db; position: relative; margin: 0; cursor: pointer; flex: none; transition: background .15s; }
.switch input::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left .15s; }
.switch input:checked { background: #4f46e5; }
.switch input:checked::after { left: 16px; }
.jobs { max-height: 240px; overflow: auto; }
.job { display: flex; gap: 8px; align-items: center; padding: 6px 0; font-size: 12px; }
.job .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: #9ca3af; }
.dot.running { background: #4f46e5; animation: saf-pulse 1s ease-in-out infinite; }
.dot.done { background: #059669; }
.dot.error { background: #b91c1c; }
@keyframes saf-pulse { 50% { opacity: .35; } }

/* Toasts */
.toasts { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 2147483400; display: flex; flex-direction: column; gap: 8px; align-items: center; pointer-events: none; }
.toast { pointer-events: auto; background: #111827; color: #fff; border-radius: 10px; padding: 10px 14px; font-size: 13px; max-width: 520px; box-shadow: 0 8px 24px rgba(0,0,0,.3); display: flex; gap: 12px; align-items: center; }
.toast.error { background: #991b1b; }
.toast.ok { background: #065f46; }
.toast button { background: none; border: 0; color: #c7d2fe; font-weight: 700; padding: 0; white-space: nowrap; }
`;

  const ui = (SAF.ui = {});
  let root = null;

  ui.root = () => {
    if (root && root.isConnected) return root;
    const host = (ui.host = document.createElement('staged-af'));
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
    root = h('div', { class: 'root' });
    ui.toasts = h('div', { class: 'toasts' });
    root.append(ui.toasts);
    shadow.append(root);
    // Keep our typing away from AppFolio's keyboard shortcuts.
    for (const type of ['keydown', 'keyup', 'keypress']) host.addEventListener(type, (e) => e.stopPropagation());
    document.documentElement.append(host);
    return root;
  };

  ui.isOurs = (node) => !!(ui.host && node && (node === ui.host || ui.host.contains(node)));

  ui.toast = (text, { kind = '', action, onAction, ms = 6000 } = {}) => {
    ui.root();
    const t = h('div', { class: 'toast ' + kind, role: 'status' }, h('span', null, text));
    const close = () => t.remove();
    if (action) t.append(h('button', { onclick: () => (close(), onAction && onAction()) }, action));
    t.append(h('button', { 'aria-label': 'Dismiss', onclick: close }, '✕'));
    ui.toasts.append(t);
    if (ms) setTimeout(close, ms);
    return close;
  };

  // modal({title, subtitle, body, footer}) -> {close, el}
  ui.modal = ({ title, subtitle, body, footer, onClose, wide }) => {
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      if (onClose) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && overlay.isConnected) {
        e.stopPropagation();
        close();
      }
    };
    const overlay = h(
      'div',
      { class: 'overlay' },
      h(
        'div',
        { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: wide ? '' : 'width:min(760px,100%)' },
        h('header', null, h('h2', null, title), subtitle && h('p', { class: 'muted' }, subtitle)),
        h('div', { class: 'body' }, body),
        footer && h('footer', null, footer)
      )
    );
    document.addEventListener('keydown', onKey, true);
    ui.root().append(overlay);
    return { close: () => overlay.isConnected && close(), el: overlay };
  };

  // The room / style / instructions controls shared by the popover and picker.
  ui.stagingFields = (initial = {}) => {
    const style = SAF.select(SAF.STYLES, initial.style || SAF.settings.style);
    const custom = h('textarea', {
      placeholder: 'Optional — e.g. "sectional facing the fireplace, warm neutral palette, keep the floor mostly clear"',
      value: initial.custom || '',
    });
    return {
      style,
      custom,
      styleField: h('label', { class: 'field' }, 'Style', style),
      customField: h('label', { class: 'field' }, 'Specific instructions', custom),
      values: () => ({ style: style.value, custom: custom.value.trim() }),
    };
  };
})();
