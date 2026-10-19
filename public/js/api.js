// Fetch helpers + SSE connection. All mutating calls carry the CSRF header.

async function request(path, { method = 'GET', body } = {}) {
  const headers = { 'X-HD-CSRF': '1' };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
  if (res.status === 401 && !path.startsWith('/api/login') && !path.startsWith('/api/me') && !path.startsWith('/api/meta')) {
    handleUnauthorized();
    throw new ApiError('Session expired', 401);
  }
  if (!res.ok) throw new ApiError(data?.error || `HTTP ${res.status}`, res.status);
  return data;
}

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

let unauthorizedHandler = null;
export function onUnauthorized(fn) { if (typeof fn === 'function') unauthorizedHandler = fn; }
function handleUnauthorized() { if (unauthorizedHandler) unauthorizedHandler(); }

export const API = {
  meta: () => request('/api/meta'),
  setup: (body) => request('/api/setup', { method: 'POST', body }),
  login: (body) => request('/api/login', { method: 'POST', body }),
  loginTotp: (body) => request('/api/login/totp', { method: 'POST', body }),
  logout: () => request('/api/logout', { method: 'POST' }),

  bootstrap: () => request('/api/bootstrap'),
  summary: () => request('/api/summary'),
  refreshWeather: () => request('/api/weather/refresh', { method: 'POST' }),
  weatherSearch: (q, country = '') => request(`/api/weather/search?q=${encodeURIComponent(q)}&country=${encodeURIComponent(country)}`),
  saveProfile: (body) => request('/api/me/profile', { method: 'PUT', body }),
  savePrefs: (body) => request('/api/me/prefs', { method: 'PUT', body }),
  changePassword: (body) => request('/api/me/password', { method: 'POST', body }),
  totpSetup: (body) => request('/api/me/totp/setup', { method: 'POST', body }),
  totpEnable: (body) => request('/api/me/totp/enable', { method: 'POST', body }),
  totpDisable: (body) => request('/api/me/totp/disable', { method: 'POST', body }),
  sessions: () => request('/api/me/sessions'),
  revokeSession: (id) => request(`/api/me/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  revokeOtherSessions: () => request('/api/me/sessions/revoke-others', { method: 'POST' }),
  pairingStart: (body) => request('/api/pair/start', { method: 'POST', body }),
  pairingDevices: () => request('/api/pair/devices'),
  revokeDevice: (id) => request(`/api/pair/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  recoveryStatus: () => request('/api/me/recovery-codes'),
  regenerateRecovery: (body) => request('/api/me/recovery-codes', { method: 'POST', body }),
  loginRecovery: (body) => request('/api/login/recovery', { method: 'POST', body }),
  audit: (q = '') => request(`/api/audit${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  testAlert: () => request('/api/alerts/test', { method: 'POST' }),

  // admin
  services: () => request('/api/services'),
  createService: (body) => request('/api/services', { method: 'POST', body }),
  updateService: (id, body) => request(`/api/services/${id}`, { method: 'PUT', body }),
  deleteService: (id) => request(`/api/services/${id}`, { method: 'DELETE' }),
  reorderServices: (ids) => request('/api/services/reorder', { method: 'POST', body: { ids } }),
  testService: (id, body) => request(`/api/services/${id}/test`, { method: 'POST', body: body || {} }),
  serviceAction: (id, body) => request(`/api/services/${id}/action`, { method: 'POST', body }),
  users: () => request('/api/users'),
  createUser: (body) => request('/api/users', { method: 'POST', body }),
  updateUser: (id, body) => request(`/api/users/${id}`, { method: 'PUT', body }),
  deleteUser: (id) => request(`/api/users/${id}`, { method: 'DELETE' }),
  resetUserPassword: (id, body) => request(`/api/users/${id}/password`, { method: 'POST', body }),
  resetUserTotp: (id) => request(`/api/users/${id}/totp-reset`, { method: 'POST' }),
  groups: () => request('/api/groups'),
  createGroup: (body) => request('/api/groups', { method: 'POST', body }),
  renameGroup: (body) => request('/api/groups/rename', { method: 'POST', body }),
  deleteGroup: (name) => request(`/api/groups/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  settings: () => request('/api/settings'),
  saveSettings: (key, body) => request(`/api/settings/${key}`, { method: 'PUT', body }),
  exportConfig: () => request('/api/settings/export'),
  importConfig: (body) => request('/api/settings/import', { method: 'POST', body }),
  backup: (body) => request('/api/settings/backup', { method: 'POST', body }),
  restore: (body) => request('/api/settings/restore', { method: 'POST', body }),

  uploadBackground(file) {
    const fd = new FormData();
    fd.append('file', file, file.name || 'background');
    return fetch('/api/upload/background', {
      method: 'POST',
      headers: { 'X-HD-CSRF': '1' },
      body: file,
      credentials: 'same-origin',
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(data?.error || `HTTP ${res.status}`, res.status);
      return data;
    });
  },
};

// SSE: live updates. event 'service' -> snapshot for one service; 'weather' -> weather.
export function connectStream(handlers) {
  const es = new EventSource('/api/stream');
  es.addEventListener('service', (e) => {
    try { handlers.service?.(JSON.parse(e.data)); } catch { /* ignore bad frame */ }
  });
  es.addEventListener('weather', (e) => {
    try { handlers.weather?.(JSON.parse(e.data)); } catch { /* ignore */ }
  });
  es.onopen = () => handlers.open?.();
  es.onerror = () => handlers.error?.(); // EventSource auto-reconnects
  return es;
}
