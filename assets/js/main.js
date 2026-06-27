/* Lily Cummings — progressive enhancement only */
(() => {
  'use strict';

  // Year stamp
  const yr = document.getElementById('year');
  if (yr) yr.textContent = new Date().getFullYear();

  // Sticky-nav state
  const nav = document.querySelector('.nav');
  const onScroll = () => nav.classList.toggle('is-scrolled', window.scrollY > 12);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // Mobile nav toggle
  const toggle = document.querySelector('.nav__toggle');
  const links  = document.getElementById('primary-nav');
  if (toggle && links) {
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      links.classList.toggle('is-open', !open);
    });
    links.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') {
        toggle.setAttribute('aria-expanded', 'false');
        links.classList.remove('is-open');
      }
    });
  }

  // IntersectionObserver reveals (added class via JS so no-JS users see content)
  const targets = document.querySelectorAll('.section, .reel, .timeline__item, .awards li');
  targets.forEach(el => el.classList.add('reveal'));
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    targets.forEach(el => io.observe(el));
  } else {
    targets.forEach(el => el.classList.add('is-in'));
  }

  // Contact form — client-side validation + AJAX submit to Formspree
  const form = document.querySelector('.contact-form');
  if (form) {
    const note = form.querySelector('.contact-form__note');
    const btn = form.querySelector('button[type="submit"]');
    const fallbackEmail = 'lcummings@wwltv.com';

    const showNote = (msg) => {
      if (note) { note.hidden = false; note.textContent = msg; }
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!form.checkValidity()) { form.reportValidity(); return; }

      const label = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

      try {
        const res = await fetch(form.action, {
          method: 'POST',
          body: new FormData(form),
          headers: { 'Accept': 'application/json' }
        });

        if (res.ok) {
          showNote('Thanks — your message has been sent. Lily will be in touch soon.');
          form.reset();
        } else {
          const data = await res.json().catch(() => ({}));
          const msg = (data && data.errors)
            ? data.errors.map((x) => x.message).join(', ')
            : 'Sorry, something went wrong. Please email ' + fallbackEmail + ' directly.';
          showNote(msg);
        }
      } catch (err) {
        showNote('Network error — please email ' + fallbackEmail + ' directly.');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = label; }
      }
    });
  }
})();
