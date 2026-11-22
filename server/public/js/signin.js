// The two-step email sign-in form (email, then the emailed code). Used on the
// studio and account pages: mountSignIn(container, onSignedIn).
(() => {
  window.mountSignIn = (box, onDone) => {
    box.innerHTML = `
      <div class="signin card">
        <h1>Sign up or sign in</h1>
        <p class="muted">Enter your email and we'll send you a code. New accounts start with free staged photos — no card needed.</p>
        <form id="emailForm" class="row-form">
          <label class="sr" for="siEmail">Email</label>
          <input id="siEmail" type="email" autocomplete="email" placeholder="you@company.com" required>
          <button class="btn primary" type="submit">Email me a code</button>
        </form>
        <form id="codeForm" class="row-form" hidden>
          <label class="sr" for="siCode">Code from the email</label>
          <input id="siCode" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="Code from the email" required>
          <button class="btn primary" type="submit">Continue</button>
        </form>
        <p id="siMsg" class="msg" role="status"></p>
        <p class="muted legal">By continuing you agree to the <a href="/terms.html" target="_blank" rel="noopener">Terms of Service</a> and <a href="/privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</p>
      </div>`;
    const $ = (id) => box.querySelector('#' + id);
    const promo = US.pendingPromo();
    if (promo) {
      const note = document.createElement('p');
      note.className = 'promo-note';
      note.textContent = `Promo code ${promo.toUpperCase()} will be applied once you're signed in.`;
      box.querySelector('.signin p').after(note);
    }
    const say = (t, cls = '') => {
      $('siMsg').className = 'msg ' + cls;
      $('siMsg').textContent = t;
    };
    const busy = (form, on) => form.querySelectorAll('button,input').forEach((el) => (el.disabled = on));
    $('emailForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      busy($('emailForm'), true);
      say('Sending…');
      try {
        await US.start($('siEmail').value.trim());
        $('codeForm').hidden = false;
        $('siCode').focus();
        say(`We emailed a code to ${$('siEmail').value.trim()}. It can take a minute; check spam too.`);
      } catch (err) {
        say(err.message, 'bad');
      } finally {
        busy($('emailForm'), false);
      }
    });
    $('codeForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      busy($('codeForm'), true);
      say('Checking…');
      try {
        await US.verify($('siEmail').value.trim(), $('siCode').value.trim());
        onDone();
      } catch (err) {
        say(err.message, 'bad');
        busy($('codeForm'), false);
      }
    });
    $('siEmail').focus();
  };
})();
