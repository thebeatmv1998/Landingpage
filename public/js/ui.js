import { icon } from './icons.js';
import { esc } from './charts.js';

export { esc };
export { icon };

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function toast(message, type = 'info', ms = 3200) {
  let host = document.querySelector('.toasts');
  if (!host) { host = h('<div class="toasts"></div>'); document.body.appendChild(host); }
  const el = h(`<div class="toast toast-${type}">${icon(type === 'error' ? 'x' : type === 'success' ? 'check' : 'zap')}<span>${esc(message)}</span></div>`);
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
}

export function modal({ title, body, footer, wide = false, onClose }) {
  const overlay = h(`<div class="modal-overlay"><div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true">
    <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn modal-x" title="Close" aria-label="Close">${icon('x')}</button></div>
    <div class="modal-body"></div>
    <div class="modal-foot"></div>
  </div></div>`);
  const bodyEl = overlay.querySelector('.modal-body');
  const footEl = overlay.querySelector('.modal-foot');
  if (body instanceof HTMLElement) bodyEl.appendChild(body);
  else bodyEl.innerHTML = body || '';
  (footer || []).forEach((btn) => footEl.appendChild(btn));
  const previouslyFocused = document.activeElement;
  const focusables = () => [...overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.getClientRects().length > 0);
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const items = focusables();
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    try { previouslyFocused?.focus?.(); } catch { /* ignore */ }
    onClose?.();
  };
  overlay.querySelector('.modal-x').addEventListener('click', close);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => { (focusables()[0] || overlay.querySelector('.modal-x'))?.focus(); });
  return { el: overlay, body: bodyEl, foot: footEl, close };
}

export function confirmModal(message, { danger = false, okLabel = 'Confirm' } = {}) {
  return new Promise((resolve) => {
    const ok = h(`<button class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${okLabel}</button>`);
    const cancel = h('<button class="btn btn-ghost">Cancel</button>');
    const m = modal({
      title: 'Please confirm',
      body: `<p class="confirm-text">${esc(message)}</p>`,
      footer: [cancel, ok],
      onClose: () => resolve(false),
    });
    ok.addEventListener('click', () => { m.close(); resolve(true); });
    cancel.addEventListener('click', () => { m.close(); });
  });
}

export function timeAgo(ts) {
  if (!ts) return 'never';
  const diff = Date.now() - Number(ts);
  if (diff < 15000) return 'just now';
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  return `${Math.round(diff / 3600000)}h ago`;
}

// Service icon tile: brand color + glyph, optional custom image layered on top.
// The image is removed on load error (via wireIcons) so the glyph shows instead.
export function serviceIcon(svc, cls = '') {
  const glyph = icon(svc.glyph || 'globe', 'svc-glyph');
  const style = `--tile:${svc.color || 'var(--accent)'}`;
  if (svc.iconUrl) {
    return `<span class="svc-ic ${cls} has-img" style="${style}" title="">
      <span class="svc-glyph-wrap">${glyph}</span>
      <img class="svc-img" src="${esc(svc.iconUrl)}" alt="" loading="lazy">
    </span>`;
  }
  return `<span class="svc-ic ${cls}" style="${style}"><span class="svc-glyph-wrap">${glyph}</span></span>`;
}

export function wireIcons(root) {
  root.querySelectorAll('img.svc-img, img.ci-img').forEach((img) => {
    const onError = () => {
      // A dead/blocked remote icon URL retries with the bundled icon before
      // we fall back to the inline glyph.
      const fallback = img.dataset.fallback;
      if (fallback) {
        delete img.dataset.fallback;
        img.src = fallback;
        img.addEventListener('error', onError, { once: true });
      // A cached failure may have fired before the listener was attached.
      if (img.complete && img.naturalWidth === 0) onError();
        return;
      }
      const tile = img.closest('.ci-icon');
      img.remove();
      if (tile) tile.classList.remove('has-img');
    };
    img.addEventListener('error', onError, { once: true });
  });
}

export function statusDot(online, cls = '') {
  return `<span class="dot ${online ? 'dot-ok' : 'dot-bad'} ${cls}" title="${online ? 'Online' : 'Offline'}"></span>`;
}

export function statChip(s) {
  const tone = s.tone === 'bad' ? 'chip-bad' : s.tone === 'good' ? 'chip-ok' : '';
  const em = s.emphasis ? 'chip-em' : '';
  return `<span class="chip ${tone} ${em}" title="${esc(s.label)}"><span class="chip-l">${esc(s.label)}</span><span class="chip-v">${esc(s.value)}</span></span>`;
}

export function applyTheme(app) {
  const html = document.documentElement;
  const auto = app.theme === 'auto';
  const light = auto
    ? (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches)
    : app.theme === 'light';
  html.dataset.theme = light ? 'light' : 'dark';
  html.dataset.themeMode = auto ? 'auto' : (light ? 'light' : 'dark');
  const set = (k, v) => html.style.setProperty(k, v);
  set('--accent', app.accent || '#c9963f');
  set('--accent2', app.accent2 || '#e4b45f');
  set('--radius', (Number(app.radius) || 12) + 'px');
  set('--card-blur', (Number(app.cardBlur) || 0) + 'px');
  set('--card-alpha', Math.min(100, Math.max(8, Number(app.cardOpacity) || 96)) / 100);
  set('--cols', Number(app.cols) || 4);
  set('--gap', app.compact ? '10px' : '16px');
  html.dataset.font = app.font || 'system';
  html.dataset.icons = app.iconShape || 'squircle';
  html.classList.toggle('no-anim', app.animations === false);

  // background
  let bg = '';
  if (app.bgMode === 'image' && app.bgImage) {
    bg = `url("${app.bgImage.replace(/"/g, '%22')}")`;
  } else if (app.bgMode === 'solid') {
    bg = app.bgSolid || '#0e1113';
  } else {
    const presets = light ? BG_PRESETS_LIGHT : BG_PRESETS;
    bg = presets[Number(app.bgPreset) || 0] || presets[0];
  }
  set('--app-bg', bg);
  set('--bg-blur', (Number(app.bgBlur) || 0) + 'px');
  set('--bg-dim', Math.min(90, Math.max(0, Number(app.bgDim) || 0)) / 100);
}

// Background presets — matte, low-contrast washes that stay out of the content's
// way. Kept here so the appearance editor and the theme agree on the same list.
export const BG_PRESETS = [
  'radial-gradient(1100px 720px at 15% -12%, rgba(201,150,63,.12), transparent 58%), linear-gradient(160deg, #0e1113 0%, #0b0e10 55%, #090b0c 100%)',
  'radial-gradient(900px 640px at 100% -10%, rgba(96,132,160,.16), transparent 55%), linear-gradient(160deg, #0d1013 0%, #0a0d0f 100%)',
  'radial-gradient(1000px 700px at 50% 120%, rgba(70,96,140,.18), transparent 60%), linear-gradient(160deg, #0c0f14 0%, #090b10 100%)',
  'radial-gradient(900px 600px at 82% 0%, rgba(190,96,60,.15), transparent 55%), linear-gradient(160deg, #120f0e 0%, #0b0a09 100%)',
  'radial-gradient(900px 620px at 20% 110%, rgba(84,140,110,.15), transparent 58%), linear-gradient(160deg, #0c1310 0%, #090d0b 100%)',
];
export const BG_PRESETS_LIGHT = [
  'radial-gradient(1100px 720px at 15% -12%, rgba(201,150,63,.12), transparent 58%), linear-gradient(160deg, #eef0f0 0%, #e6e9e9 100%)',
  'radial-gradient(900px 640px at 100% -10%, rgba(96,132,160,.16), transparent 55%), linear-gradient(160deg, #edf1f3 0%, #e5eaed 100%)',
  'radial-gradient(1000px 700px at 50% 120%, rgba(70,96,140,.16), transparent 60%), linear-gradient(160deg, #eceff4 0%, #e6e9f0 100%)',
  'radial-gradient(900px 600px at 82% 0%, rgba(190,96,60,.14), transparent 55%), linear-gradient(160deg, #f1eeec 0%, #eae6e3 100%)',
  'radial-gradient(900px 620px at 20% 110%, rgba(84,140,110,.14), transparent 58%), linear-gradient(160deg, #ecf1ee 0%, #e6ece9 100%)',
];

export function greeting() {
  const hNow = new Date().getHours();
  if (hNow < 5) return 'Up late?';
  if (hNow < 12) return 'Good morning';
  if (hNow < 18) return 'Good afternoon';
  return 'Good evening';
}
