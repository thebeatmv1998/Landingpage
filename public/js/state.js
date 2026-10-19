// App-wide state + tiny event bus.
export const state = {
  meta: null,
  user: null,
  settings: { appearance: {}, widgets: {}, general: {}, sso: {} },
  services: new Map(),   // id -> live snapshot
  weather: null,
  sseConnected: false,
};

export const bus = new EventTarget();
export function emit(type, detail) { bus.dispatchEvent(new CustomEvent(type, { detail })); }
export function on(type, fn) {
  const handler = (e) => fn(e.detail);
  bus.addEventListener(type, handler);
  return () => bus.removeEventListener(type, handler);
}

// effective appearance = global settings merged with per-user override
export function effectiveAppearance() {
  const global = state.settings.appearance || {};
  const override = state.user?.prefs?.appearance || {};
  if (state.user?.prefs?.appearanceMode === 'custom') return { ...defaults(), ...global, ...override };
  return { ...defaults(), ...global };
}

export function defaults() {
  return {
    theme: 'dark', accent: '#c9963f', accent2: '#e4b45f',
    bgMode: 'preset', bgPreset: 0, bgSolid: '#0e1113', bgImage: '', bgBlur: 0, bgDim: 45,
    cardOpacity: 96, cardBlur: 0, radius: 12, font: 'system', cols: 4,
    iconShape: 'squircle', animations: true, groupByCategory: true, compact: false,
  };
}

export function savePrefs(patch) {
  const prefs = { ...(state.user.prefs || {}), ...patch };
  state.user.prefs = prefs;
  return fetch('/api/me/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-HD-CSRF': '1' },
    body: JSON.stringify(patch),
  }).then((r) => {
    if (!r.ok) throw new Error('Could not save preferences');
    return prefs;
  });
}

export function serviceById(id) { return state.services.get(id); }

export function visibleServices() {
  return [...state.services.values()].filter((s) => s.enabled !== false);
}
