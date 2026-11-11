// Entry point. uploads.js has already attached its capture listeners at
// document_start; everything visual waits for the DOM.
(() => {
  const SAF = globalThis.SAF;
  if (window.top !== window) return; // main frame only

  const start = async () => {
    await SAF.loadSettings().catch(() => {});
    SAF.ui.root();
    SAF.startExisting();
    SAF.startDock();

    // AppFolio navigates without full page loads in places; watch the URL.
    let href = location.href;
    setInterval(() => {
      if (href === location.href) return;
      href = location.href;
      SAF.appfolio.lastSink = null;
      SAF.emit('navigate');
    }, 800);

    window.addEventListener('beforeunload', (e) => {
      if (SAF.activeJobs().length || SAF.batches.length) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
