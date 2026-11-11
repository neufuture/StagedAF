// Runs in the page's own JavaScript world. Its only job: when StagedAF is
// about to click AppFolio's delete button on the user's behalf (after the user
// chose "Replace original"), auto-accept the native confirm() box for a few
// seconds so the replacement can finish unattended.
(() => {
  let until = 0;
  const nativeConfirm = window.confirm;
  document.addEventListener('saf:auto-confirm', () => {
    until = Date.now() + 8000;
  });
  document.addEventListener('saf:auto-confirm-off', () => {
    until = 0;
  });
  window.confirm = function (...args) {
    if (Date.now() < until) return true;
    return nativeConfirm.apply(this, args);
  };
})();
