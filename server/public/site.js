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

// "Select your style": swap the After photo between staged versions of the same room.
const afterImg = document.getElementById('afterImg');
const stylePick = document.getElementById('stylePick');
if (afterImg && stylePick) {
  stylePick.addEventListener('change', () => {
    const opt = stylePick.selectedOptions[0];
    const base = '/' + opt.value;
    const next = new Image();
    next.srcset = `${base}-800.webp 800w, ${base}.webp 1536w`;
    next.sizes = afterImg.sizes;
    afterImg.classList.add('swapping');
    const show = () => {
      afterImg.srcset = next.srcset;
      afterImg.src = base + '.webp';
      afterImg.alt = 'The same living room virtually staged in ' + opt.dataset.alt + '.';
      afterImg.classList.remove('swapping');
    };
    next.onload = show;
    next.onerror = show;
    next.src = base + '.webp';
  });
  // Warm the cache for the small versions once the page has settled.
  addEventListener('load', () => setTimeout(() => {
    for (const o of stylePick.options) if (!o.selected) new Image().src = `/${o.value}-800.webp`;
  }, 1500));
}

// Mobile menu.
const menuBtn = document.querySelector('.menu-btn');
const siteNav = document.getElementById('site-nav');
if (menuBtn && siteNav) {
  const setOpen = (open) => {
    siteNav.classList.toggle('open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
  };
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!siteNav.classList.contains('open'));
  });
  siteNav.addEventListener('click', (e) => e.target.closest('a') && setOpen(false));
  document.addEventListener('click', (e) => !siteNav.contains(e.target) && setOpen(false));
  document.addEventListener('keydown', (e) => e.key === 'Escape' && (setOpen(false), menuBtn.focus()));
}
