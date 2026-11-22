// Runs in the page's own JavaScript world. Its only job: when UnitStager is
// about to click AppFolio's delete button on the user's behalf (after the user
// chose "Replace original"), accept that one delete confirmation so the
// replacement can finish unattended. Only a single confirm() whose message is
// about deleting is accepted, within a few seconds; anything else is shown to
// the user as normal.
(() => {
  let until = 0;
  const nativeConfirm = window.confirm;
  document.addEventListener('saf:auto-confirm', () => {
    until = Date.now() + 8000;
  });
  document.addEventListener('saf:auto-confirm-off', () => {
    until = 0;
  });
  window.confirm = function (message, ...rest) {
    if (Date.now() < until && /delete|remove/i.test(String(message))) {
      until = 0;
      return true;
    }
    return nativeConfirm.call(this, message, ...rest);
  };
})();
