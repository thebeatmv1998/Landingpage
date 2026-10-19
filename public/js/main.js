import { state, on, effectiveAppearance } from './state.js';
import { API, onUnauthorized, connectStream } from './api.js';
import { applyTheme, toast } from './ui.js';
import { renderLogin, renderSetup } from './views/login.js';
import { renderDashboard } from './views/dashboard.js';
import { renderSettings } from './views/settings.js';
import { installPalette } from './palette.js';

const app = document.getElementById('app');
let currentEs = null;

function closeStream() { if (currentEs) { currentEs.close(); currentEs = null; } }

export function navigate(hash) { location.hash = hash; }

function showLogin() {
  state.user = null;
  closeStream();
  navigate('#/login');
  renderLogin(app, {
    sso: state.meta?.sso,
    onDone: (user) => { state.user = user; afterAuth(); route(); },
  });
}

function startStream() {
  closeStream();
  currentEs = connectStream({
    service(snap) {
      state.services.set(snap.id, snap);
      window.dispatchEvent(new CustomEvent('service-update', { detail: snap }));
    },
    weather(w) {
      state.weather = w;
      window.dispatchEvent(new CustomEvent('weather-update', { detail: w }));
    },
  });
}

export async function boot() {
  onUnauthorized(showLogin);

  try {
    state.meta = await API.meta();
  } catch { /* server unreachable; the login fetch below will surface it */ }

  const hash = location.hash || '#/';
  if (state.meta?.needsSetup) {
    renderSetup(app, { onDone: (user) => { state.user = user; afterAuth(); route(); } });
    return;
  }
  try {
    const bootData = await API.bootstrap();
    state.user = bootData.user;
    state.settings = bootData.settings;
    if (hash.startsWith('#/login')) { navigate('#/'); }
    afterAuth();
    route();
  } catch (err) {
    renderLogin(app, {
      sso: state.meta?.sso,
      ssoError: new URLSearchParams(location.search).get('ssoError'),
      onDone: (user) => { state.user = user; afterAuth(); route(); },
    });
  }
}

function afterAuth() {
  applyTheme(effectiveAppearance());
  installPalette({ navigate });
  startStream();
  // initial summary load
  API.summary().then((snap) => {
    for (const s of snap.services) state.services.set(s.id, s);
    state.weather = snap.weather;
    window.dispatchEvent(new CustomEvent('summary-loaded'));
  }).catch(() => {});
}

async function route() {
  if (!state.user) { return; }
  applyTheme(effectiveAppearance());
  const hash = location.hash || '#/';
  document.title = state.settings?.general?.title || 'HomeDeck';
  if (hash.startsWith('#/settings')) {
    await renderSettings(app, { navigate, route });
  } else if (hash.startsWith('#/admin')) {
    if (state.user.role !== 'admin') { navigate('#/'); return; }
    navigate('#/settings?tab=services');
    return;
  } else if (hash.startsWith('#/login')) {
    navigate('#/');
    return;
  } else {
    await renderDashboard(app, { navigate });
  }
}

window.addEventListener('hashchange', () => { if (state.user) route(); });
on('theme-changed', () => applyTheme(effectiveAppearance()));
// Keep "auto" theme in sync with the OS setting.
if (typeof matchMedia === 'function') {
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => {
    if (effectiveAppearance().theme === 'auto') applyTheme(effectiveAppearance());
  });
}

boot();
