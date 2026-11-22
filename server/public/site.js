// Store links. Paste each listing's URL in once it is published; until then
// the button shows as "coming soon".
const STORE_URLS = {
  chrome: 'https://chromewebstore.google.com/detail/ijcjfigoikihikjnaeenjefjoeemhmhm',
  edge: '',
};

for (const a of document.querySelectorAll('[data-install]')) {
  const url = STORE_URLS[a.dataset.install];
  if (url) {
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
  } else {
    a.classList.add('off');
    a.removeAttribute('href');
    a.setAttribute('aria-disabled', 'true');
    const soon = document.createElement('small');
    soon.textContent = 'Coming soon';
    a.append(soon);
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
        const card = el('div', 'card price-card');
        card.append(el('h3', '', 'Try it'), el('div', 'price', 'Free'), el('p', 'each', `${free_credits} photos to start`), el('p', '', 'No card needed.'));
        cards.push(card);
      }
      for (const p of packs) {
        const card = el('div', 'card price-card');
        if (p.save > 0) card.append(el('div', 'save', `Save ${p.save}%`));
        card.append(el('h3', '', `${p.credits} photos`), el('div', 'price', money(p.amount)), el('p', 'each', `${money(p.each)} per photo`), el('p', '', "Credits don't expire."));
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

// Header: show a hairline under it once the page has scrolled.
const topBar = document.querySelector('header.top');
if (topBar) {
  const mark = () => topBar.classList.toggle('scrolled', scrollY > 4);
  addEventListener('scroll', mark, { passive: true });
  mark();
}
