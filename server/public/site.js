// Set this to the Chrome Web Store listing once the extension is published.
const INSTALL_URL = '';

for (const a of document.querySelectorAll('[data-install]')) {
  if (INSTALL_URL) a.href = INSTALL_URL;
  else {
    a.classList.add('off');
    a.removeAttribute('href');
    a.textContent = 'Chrome Web Store listing coming soon';
  }
}

// Pricing comes from the server, so the site and the extension always agree.
const money = (cents) => '$' + (cents % 100 ? (cents / 100).toFixed(2) : cents / 100);
const pricing = document.getElementById('packs');
if (pricing) {
  fetch('/api/packs')
    .then((r) => r.json())
    .then(({ packs, free_credits }) => {
      const cards = [];
      if (free_credits > 0) cards.push(['Try it', 'Free', `${free_credits} staged photos when you sign up. No card needed.`]);
      for (const p of packs) cards.push([`${p.credits} photos`, money(p.amount), `${money(Math.round(p.amount / p.credits))} per staged photo. Credits don't expire.`]);
      pricing.replaceChildren(
        ...cards.map(([title, price, text]) => {
          const el = document.createElement('div');
          el.className = 'card';
          const h = document.createElement('h3');
          h.textContent = title;
          const pr = document.createElement('div');
          pr.className = 'price';
          pr.textContent = price;
          const p = document.createElement('p');
          p.textContent = text;
          el.append(h, pr, p);
          return el;
        })
      );
    })
    .catch(() => {});
}
