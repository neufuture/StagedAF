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
      const el = (tag, cls, text) => {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
      };
      const cards = [];
      if (free_credits > 0) {
        const card = el('div', 'card');
        card.append(el('h3', '', 'Try it'), el('div', 'price', 'Free'), el('p', '', `${free_credits} staged photos when you sign up. No card needed.`));
        cards.push(card);
      }
      for (const p of packs) {
        const card = el('div', 'card');
        if (p.save > 0) card.append(el('div', 'save', `Save ${p.save}%`));
        card.append(el('h3', '', `${p.credits} photos`), el('div', 'price', money(p.amount)), el('p', '', `${money(p.each)} per staged photo.`), el('p', '', "Credits don't expire."));
        cards.push(card);
      }
      pricing.replaceChildren(...cards);
      pricing.style.gridTemplateColumns = `repeat(auto-fit, minmax(${cards.length > 3 ? 200 : 240}px, 1fr))`;
    })
    .catch(() => {});
}
