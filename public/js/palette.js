// ⌘K / Ctrl-K command palette: jump to pages and open services.
import { icon } from './icons.js';
import { esc } from './ui.js';
import { state } from './state.js';
import { API } from './api.js';

let installed = false;

export function installPalette({ navigate } = {}) {
  if (installed) return;
  installed = true;

  const overlay = document.createElement('div');
  overlay.className = 'palette-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `<div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
    <div class="palette-search">${icon('search')}<input id="pal-input" placeholder="Jump to a service or page…" autocomplete="off" spellcheck="false"></div>
    <div class="palette-list" id="pal-list"></div>
    <div class="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div>
  </div>`;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#pal-input');
  const list = overlay.querySelector('#pal-list');
  let items = [];
  let filtered = [];
  let active = 0;

  const build = () => {
    const out = [
      { label: 'Dashboard', hint: 'Page', icon: 'menu', run: () => navigate('#/') },
      { label: 'Settings', hint: 'Page', icon: 'settings', run: () => navigate('#/settings') },
      { label: 'My sessions', hint: 'Page', icon: 'globe', run: () => navigate('#/settings?tab=sessions') },
    ];
    if (state.user?.role === 'admin') out.push({ label: 'Services', hint: 'Administration', icon: 'plug', run: () => navigate('#/settings?tab=services') });
    for (const s of state.services.values()) {
      if (s.enabled === false) continue;
      out.push({
        label: s.name,
        hint: s.online === false ? 'Service · offline' : 'Service',
        icon: s.glyph || 'globe',
        run: () => { if (s.url) window.open(s.url, '_blank', 'noopener'); },
      });
    }
    out.push({
      label: 'Sign out',
      hint: 'Account',
      icon: 'logout',
      run: async () => {
        try { await API.logout(); } catch { /* ignore */ }
        state.user = null;
        location.hash = '#/login';
        location.reload();
      },
    });
    return out;
  };

  const render = () => {
    const q = input.value.trim().toLowerCase();
    filtered = q
      ? items.filter((it) => it.label.toLowerCase().includes(q) || it.hint.toLowerCase().includes(q))
      : items.slice();
    active = Math.min(active, Math.max(0, filtered.length - 1));
    list.innerHTML = filtered.length
      ? filtered.map((it, i) => `<button class="palette-item${i === active ? ' active' : ''}" data-i="${i}">
          <span class="palette-ic">${icon(it.icon)}</span>
          <span class="palette-label">${esc(it.label)}</span>
          <span class="palette-hint">${esc(it.hint)}</span>
        </button>`).join('')
      : '<div class="empty">No matches</div>';
    list.querySelectorAll('[data-i]').forEach((el) => {
      el.addEventListener('mousemove', () => { if (active !== Number(el.dataset.i)) { active = Number(el.dataset.i); render(); } });
      el.addEventListener('click', () => run(Number(el.dataset.i)));
    });
  };

  const run = (i) => {
    const it = filtered[i];
    if (!it) return;
    close();
    it.run();
  };

  const open = () => {
    if (!state.user) return;
    items = build();
    active = 0;
    input.value = '';
    overlay.hidden = false;
    render();
    input.focus();
  };

  const close = () => { overlay.hidden = true; };
  const isOpen = () => !overlay.hidden;

  input.addEventListener('input', () => { active = 0; render(); });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'k') {
      e.preventDefault();
      isOpen() ? close() : open();
      return;
    }
    if (!isOpen()) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, Math.max(0, filtered.length - 1)); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(active); }
  });
}
