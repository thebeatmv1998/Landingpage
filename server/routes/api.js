import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { stmts, db, getSetting, setSetting } from '../core/db.js';
import { config, encryptSecret, decryptSecret, maskSecret } from '../core/config.js';
import { deepMerge, safeJsonParse, clampPollMs } from '../core/util.js';
import { audit, listAudit } from '../core/audit.js';
import { postWebhook } from '../core/notify.js';
import { encryptBackup, decryptBackup } from '../core/backup.js';
import { requireAuth, requireAdmin } from '../auth/sessions.js';
import { runner, testService, runServiceAction } from '../services/runner.js';
import { serviceMeta, registry } from '../services/registry.js';
import { fetchImage } from '../services/http.js';

export const apiRouter = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// bootstrap + live data
// ---------------------------------------------------------------------------
apiRouter.get('/bootstrap', requireAuth, (req, res) => {
  const user = req.user;
  const appearance = getSetting('appearance', {});
  const widgets = getSetting('widgets', {});
  const general = getSetting('general', {});
  res.json({
    user: {
      id: user.id, username: user.username, role: user.role,
      displayName: user.display_name || user.username,
      groupName: user.group_name || '',
      totpEnabled: !!user.totp_enabled,
      hasPassword: !!user.pass_hash,
      prefs: safeJsonParse(user.prefs, {}) || {},
    },
    settings: { appearance, widgets, general, ...(user.role === 'admin' ? { alerts: getSetting('alerts', {}) } : {}) },
  });
});

apiRouter.get('/summary', requireAuth, (req, res) => {
  res.json(runner.snapshotFor(req.user));
});

// service type registry (drives the admin "add service" gallery + forms)
apiRouter.get('/registry', requireAuth, (req, res) => {
  res.json(registry.map(({ type, label, blurb, category, color, glyph, icon, fields, pollMs }) => ({
    type, label, blurb, category, color, glyph, icon, fields, pollMs,
  })));
});

apiRouter.get('/stream', requireAuth, (req, res) => {
  const remove = runner.addClient(res);
  req.on('close', remove);
});

// ---------------------------------------------------------------------------
// image proxy (artwork etc.) — restricted to configured services
// ---------------------------------------------------------------------------

// Reject path traversal / protocol-relative escapes before forwarding upstream,
// so a user who can see a service can't reach unrelated paths on its host.
function safeProxyTail(tail) {
  let decoded = tail;
  try { decoded = decodeURIComponent(tail); } catch { return null; }
  const pathPart = decoded.split(/[?#]/)[0];
  if (pathPart.split(/[\\/]+/).includes('..')) return null;
  if (/^[\\/]{2}/.test(pathPart)) return null;
  return tail;
}

apiRouter.get('/proxy/:serviceId/*', requireAuth, wrap(async (req, res) => {
  const serviceId = Number(req.params.serviceId);
  const svc = stmts.serviceById.get(serviceId);
  if (!svc) return res.status(404).json({ error: 'Service not found' });
  const visible = runner.visibleServicesFor(req.user).some((s) => s.id === serviceId);
  if (!visible) return res.status(403).json({ error: 'Not allowed' });
  // reconstruct original path + query string after ".../proxy/<id>/"
  const marker = `/api/proxy/${serviceId}/`;
  const idx = req.originalUrl.indexOf(marker);
  const tail = idx >= 0 ? req.originalUrl.slice(idx + marker.length) : '';
  if (!tail) return res.status(400).json({ error: 'Missing path' });
  if (!safeProxyTail(tail)) return res.status(400).json({ error: 'Invalid path' });
  try {
    const { buf, type } = await fetchImage(svc, '/' + tail);
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(buf);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// ---------------------------------------------------------------------------
// services CRUD (admin)
// ---------------------------------------------------------------------------
function serviceRowFromInput(row, input, { partial = false } = {}) {
  const meta = serviceMeta(input.type || row?.type);
  const merged = {
    type: input.type ?? row?.type ?? '',
    name: (input.name ?? row?.name ?? 'Service').slice(0, 80),
    url: (input.url ?? row?.url ?? '').slice(0, 500).trim(),
    fallback_url: (input.fallback_url ?? row?.fallback_url ?? '').slice(0, 500).trim(),
    auto_switch: input.auto_switch !== undefined ? (input.auto_switch ? 1 : 0) : (row?.auto_switch ?? 1),
    category: (input.category ?? row?.category ?? meta.category).slice(0, 40),
    icon_url: (input.icon_url ?? row?.icon_url ?? '').slice(0, 500).trim(),
    enabled: input.enabled !== undefined ? (input.enabled ? 1 : 0) : (row?.enabled ?? 1),
    sort_order: input.sort_order ?? row?.sort_order ?? 0,
    allowed_groups: JSON.stringify(Array.isArray(input.allowed_groups) ? input.allowed_groups : safeJsonParse(row?.allowed_groups, []) || []),
    extra: JSON.stringify(typeof input.extra === 'object' && input.extra ? { ...(safeJsonParse(row?.extra, {}) || {}), ...input.extra } : (safeJsonParse(row?.extra, {}) || {})),
    poll_interval: clampPollMs(input.poll_interval ?? row?.poll_interval ?? null),
  };
  // Secrets: a blank field means "keep the stored value" — the admin form shows an
  // empty input for an existing secret (placeholder "unchanged"). A non-empty value
  // replaces it, and the masked "••••1234" is treated as untouched too.
  const applySecret = (field, currentEnc) => {
    const v = input[field];
    if (v === undefined || v === null) return currentEnc ?? '';
    const s = String(v);
    if (s === '' || s.startsWith('••••')) return currentEnc ?? '';
    return encryptSecret(s);
  };
  return { merged, applySecret };
}

apiRouter.get('/services', requireAdmin, (req, res) => {
  const rows = stmts.servicesAll.all();
  res.json({
    services: rows.map((r) => ({
      id: r.id, type: r.type, name: r.name, url: r.url, fallback_url: r.fallback_url || '',
      auto_switch: r.auto_switch !== 0, category: r.category,
      icon_url: r.icon_url, enabled: !!r.enabled, sort_order: r.sort_order,
      allowed_groups: safeJsonParse(r.allowed_groups, []) || [],
      extra: safeJsonParse(r.extra, {}) || {},
      api_key_mask: maskSecret(decryptSecret(r.api_key)),
      has_api_key: !!r.api_key,
      username: r.username,
      has_password: !!r.password,
      password_mask: maskSecret(decryptSecret(r.password)),
    })),
  });
});

apiRouter.post('/services', requireAdmin, (req, res) => {
  const input = req.body || {};
  if (!input.type || !input.name) return res.status(400).json({ error: 'type and name are required' });
  const { merged, applySecret } = serviceRowFromInput(null, input);
  const maxOrder = stmts.serviceMaxOrder.get().m;
  const info = stmts.serviceInsert.run({
    ...merged,
    sort_order: maxOrder + 1,
    api_key: applySecret('api_key', ''),
    username: (input.username ?? '').slice(0, 120),
    password: applySecret('password', ''),
    created_at: Date.now(),
  });
  runner.reload();
  audit(req, 'service_created', `${input.type} · ${input.name}`);
  res.json({ id: Number(info.lastInsertRowid) });
});

apiRouter.put('/services/:id', requireAdmin, (req, res) => {
  const row = stmts.serviceById.get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Service not found' });
  const { merged, applySecret } = serviceRowFromInput(row, req.body || {}, { partial: true });
  stmts.serviceUpdate.run({
    ...merged,
    api_key: applySecret('api_key', row.api_key),
    username: (req.body?.username ?? row.username).slice(0, 120),
    password: applySecret('password', row.password),
    id: row.id,
  });
  runner.reload();
  audit(req, 'service_updated', `${row.type} · ${row.name}`);
  res.json({ ok: true });
});

apiRouter.delete('/services/:id', requireAdmin, (req, res) => {
  const row = stmts.serviceById.get(Number(req.params.id));
  stmts.serviceDelete.run({ id: Number(req.params.id) });
  runner.reload();
  audit(req, 'service_deleted', row ? `${row.type} · ${row.name}` : String(req.params.id));
  res.json({ ok: true });
});

apiRouter.post('/services/reorder', requireAdmin, (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || !ids.every((n) => Number.isInteger(n))) {
    return res.status(400).json({ error: 'ids must be an array of integers' });
  }
  const setOrder = db.prepare('UPDATE services SET sort_order = :o WHERE id = :id');
  ids.forEach((id, i) => setOrder.run({ o: i, id }));
  runner.reload();
  audit(req, 'services_reordered', `${ids.length} services`);
  res.json({ ok: true });
});

apiRouter.post('/services/:id/test', requireAdmin, wrap(async (req, res) => {
  const input = req.body || {};
  let row = stmts.serviceById.get(Number(req.params.id));
  if (!row) {
    // The admin "Test connection" button also tests services that aren't saved yet.
    if (!input.type || !input.url) return res.status(404).json({ error: 'Service not found' });
    row = {
      id: 0, type: input.type, name: input.name || input.type, url: '', api_key: '',
      username: '', password: '', category: '', icon_url: '', enabled: 1, sort_order: 0,
      fallback_url: '', auto_switch: 1,
      poll_interval: null, allowed_groups: '[]', extra: '{}',
    };
  }
  // Apply unsaved edits, but keep stored secrets when the field was left blank.
  const { merged, applySecret } = serviceRowFromInput(row, input, { partial: true });
  const testRow = {
    ...row,
    ...merged,
    api_key: applySecret('api_key', row.api_key),
    username: (input.username !== undefined ? String(input.username || '') : row.username).slice(0, 120),
    password: applySecret('password', row.password),
  };
  const result = await testService(testRow);
  res.json(result);
}));

// Run a service action (e.g. SABnzbd pause/resume). Available to all logged-in
// users for services they can see; connectors decide which actions exist.
apiRouter.post('/services/:id/action', requireAuth, wrap(async (req, res) => {
  const row = stmts.serviceById.get(Number(req.params.id));
  if (!row || !row.enabled) return res.status(404).json({ error: 'Service not found' });
  const visible = runner.visibleServicesFor(req.user).some((s) => s.id === row.id);
  if (!visible) return res.status(403).json({ error: 'Not allowed' });
  const { action, value } = req.body || {};
  if (!action || typeof action !== 'string') return res.status(400).json({ error: 'Missing action' });
  // Container lifecycle actions are privileged; media-player controls (e.g.
  // Jellyfin pause/stop) remain available to users who can see the service.
  const containerAction = ['update', 'update-all', 'start', 'stop', 'restart'].includes(action)
    && ['docker', 'unraid'].includes(row.type);
  if (containerAction && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access required' });
  }
  let result;
  try {
    result = await runServiceAction(row, { action, value });
  } catch (err) {
    audit(req, 'service_action_failed', `${row.type} · ${row.name} · ${action}: ${err.message}`);
    return res.status(502).json({ error: err.message || 'Action failed' });
  }
  if (result?.ok) audit(req, 'service_action', `${row.type} · ${row.name} · ${action}`);
  res.json(result);
}));

// ---------------------------------------------------------------------------
// groups (admin) — rename/delete updates users and service access in one go
// ---------------------------------------------------------------------------
apiRouter.get('/groups', requireAdmin, (req, res) => {
  const stored = getSetting('groups', {}).names || [];
  const names = new Set(stored);
  const users = stmts.usersAll.all();
  const services = stmts.servicesAll.all();
  for (const u of users) if (u.group_name) names.add(u.group_name);
  for (const s of services) for (const g of safeJsonParse(s.allowed_groups, []) || []) if (g) names.add(g);
  const groups = [...names].sort().map((name) => ({
    name,
    users: users.filter((u) => u.group_name === name).length,
    services: services.filter((s) => (safeJsonParse(s.allowed_groups, []) || []).includes(name)).length,
  }));
  res.json({ groups });
});

apiRouter.post('/groups', requireAdmin, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Group name is required' });
  const stored = getSetting('groups', {}).names || [];
  if (!stored.includes(name)) setSetting('groups', { names: [...stored, name].sort() });
  audit(req, 'group_created', name);
  res.json({ ok: true, name });
});

apiRouter.post('/groups/rename', requireAdmin, (req, res) => {
  const from = String(req.body?.from || '').trim();
  const to = String(req.body?.to || '').trim().slice(0, 40);
  if (!from || !to) return res.status(400).json({ error: 'Both names are required' });
  if (from === to) return res.json({ ok: true });
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE users SET group_name = ? WHERE group_name = ?').run(to, from);
    for (const s of stmts.servicesAll.all()) {
      const groups = safeJsonParse(s.allowed_groups, []) || [];
      if (!groups.includes(from)) continue;
      const next = [...new Set(groups.map((g) => (g === from ? to : g)))];
      db.prepare('UPDATE services SET allowed_groups = ? WHERE id = ?').run(JSON.stringify(next), s.id);
    }
    const stored = (getSetting('groups', {}).names || []).filter((n) => n !== from);
    if (!stored.includes(to)) stored.push(to);
    setSetting('groups', { names: [...new Set(stored)].sort() });
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
  runner.reload();
  audit(req, 'group_renamed', `${from} → ${to}`);
  res.json({ ok: true });
});

apiRouter.delete('/groups/:name', requireAdmin, (req, res) => {
  const name = String(req.params.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Group name is required' });
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE users SET group_name = '' WHERE group_name = ?").run(name);
    for (const s of stmts.servicesAll.all()) {
      const groups = safeJsonParse(s.allowed_groups, []) || [];
      if (!groups.includes(name)) continue;
      db.prepare('UPDATE services SET allowed_groups = ? WHERE id = ?').run(JSON.stringify(groups.filter((g) => g !== name)), s.id);
    }
    setSetting('groups', { names: (getSetting('groups', {}).names || []).filter((n) => n !== name) });
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
  runner.reload();
  audit(req, 'group_deleted', name);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------
const SETTING_KEYS = ['appearance', 'widgets', 'general', 'sso', 'alerts'];

apiRouter.get('/settings', requireAuth, (req, res) => {
  const out = {
    appearance: getSetting('appearance', {}),
    widgets: getSetting('widgets', {}),
    general: { ...getSetting('general', {}), sso: undefined },
  };
  if (req.user.role === 'admin') {
    out.sso = getSetting('sso', {});
    out.alerts = getSetting('alerts', {});
  }
  res.json(out);
});

apiRouter.put('/settings/:key', requireAdmin, (req, res) => {
  if (!SETTING_KEYS.includes(req.params.key)) return res.status(400).json({ error: 'Unknown settings key' });
  const patch = req.body;
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return res.status(400).json({ error: 'Body must be an object' });
  }
  const merged = deepMerge(getSetting(req.params.key, {}), patch);
  setSetting(req.params.key, merged);
  audit(req, 'settings_updated', req.params.key);
  res.json({ [req.params.key]: merged });
});

apiRouter.get('/settings/export', requireAdmin, (req, res) => {
  audit(req, 'config_exported');
  const rows = stmts.servicesAll.all();
  res.json({
    version: config.version,
    exportedAt: new Date().toISOString(),
    settings: {
      appearance: getSetting('appearance', {}),
      widgets: getSetting('widgets', {}),
      general: getSetting('general', {}),
      sso: (() => { const { clientSecret, ...rest } = getSetting('sso', {}); return rest; })(), // never export secrets
    },
    services: rows.map((r) => ({
      type: r.type, name: r.name, url: r.url, fallback_url: r.fallback_url || '', auto_switch: r.auto_switch !== 0,
      category: r.category, icon_url: r.icon_url,
      enabled: !!r.enabled, sort_order: r.sort_order, allowed_groups: safeJsonParse(r.allowed_groups, []),
      extra: safeJsonParse(r.extra, {}), username: r.username,
      has_api_key: !!r.api_key, has_password: !!r.password,
    })),
  });
});

apiRouter.post('/settings/import', requireAdmin, (req, res) => {
  const data = req.body || {};
  if (!Array.isArray(data.services)) return res.status(400).json({ error: 'Invalid import file' });
  if (data.services.length > 500) return res.status(413).json({ error: 'Too many services in import file' });
  let created = 0;
  const existing = stmts.servicesAll.all();
  const maxOrder = stmts.serviceMaxOrder.get().m;
  for (const [i, s] of data.services.entries()) {
    if (!s || !s.type || !s.name) continue;
    if (!serviceMeta(s.type)) continue;
    const dup = existing.find((e) => e.type === s.type && e.url === s.url && e.name === s.name);
    if (dup) continue;
    const extra = typeof s.extra === 'object' && s.extra && !Array.isArray(s.extra) ? s.extra : {};
    stmts.serviceInsert.run({
      type: s.type, name: String(s.name).slice(0, 80),
      url: String(s.url || '').slice(0, 500).trim(),
      fallback_url: String(s.fallback_url || '').slice(0, 500).trim(),
      auto_switch: s.auto_switch === false ? 0 : 1,
      api_key: '',
      username: String(s.username || '').slice(0, 120), password: '',
      category: String(s.category || serviceMeta(s.type).category).slice(0, 40),
      icon_url: String(s.icon_url || '').slice(0, 500).trim(),
      enabled: s.enabled === false ? 0 : 1,
      sort_order: (maxOrder + 1 + i),
      allowed_groups: JSON.stringify(Array.isArray(s.allowed_groups) ? s.allowed_groups : []),
      extra: JSON.stringify(extra), created_at: Date.now(),
    });
    created++;
  }
  if (data.settings) {
    for (const key of ['appearance', 'widgets', 'general']) {
      if (data.settings[key] && typeof data.settings[key] === 'object') {
        setSetting(key, deepMerge(getSetting(key, {}), data.settings[key]));
      }
    }
  }
  runner.reload();
  audit(req, 'config_imported', `${created} services`);
  res.json({ created });
});

// ---------------------------------------------------------------------------
// encrypted full backup (services incl. secrets + settings)
// ---------------------------------------------------------------------------
apiRouter.post('/settings/backup', requireAdmin, (req, res) => {
  const passphrase = String(req.body?.passphrase || '');
  if (passphrase.length < 8) return res.status(400).json({ error: 'Passphrase must be at least 8 characters' });
  const services = stmts.servicesAll.all().map((r) => ({
    type: r.type, name: r.name, url: r.url, fallback_url: r.fallback_url || '', auto_switch: !!r.auto_switch,
    category: r.category, icon_url: r.icon_url,
    enabled: !!r.enabled, sort_order: r.sort_order, poll_interval: r.poll_interval,
    allowed_groups: safeJsonParse(r.allowed_groups, []) || [],
    extra: safeJsonParse(r.extra, {}) || {},
    username: r.username,
    api_key: decryptSecret(r.api_key),
    password: decryptSecret(r.password),
  }));
  const payload = {
    app: 'HomeDeck',
    exportedAt: new Date().toISOString(),
    settings: {
      appearance: getSetting('appearance', {}),
      widgets: getSetting('widgets', {}),
      general: getSetting('general', {}),
      sso: getSetting('sso', {}),
      alerts: getSetting('alerts', {}),
    },
    services,
  };
  audit(req, 'backup_exported', `${services.length} services (encrypted)`);
  res.json(encryptBackup(payload, passphrase));
});

apiRouter.post('/settings/restore', requireAdmin, (req, res) => {
  const passphrase = String(req.body?.passphrase || '');
  if (passphrase.length < 8) return res.status(400).json({ error: 'Passphrase is required' });
  let payload;
  try { payload = decryptBackup(req.body?.backup, passphrase); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  if (!payload || !Array.isArray(payload.services)) return res.status(400).json({ error: 'Backup has no services' });

  db.exec('DELETE FROM services');
  let restored = 0;
  for (const s of payload.services) {
    if (!s?.type || !s?.name) continue;
    const meta = serviceMeta(s.type);
    stmts.serviceInsert.run({
      type: s.type,
      name: String(s.name).slice(0, 80),
      url: String(s.url || '').slice(0, 500),
      fallback_url: String(s.fallback_url || '').slice(0, 500),
      auto_switch: s.auto_switch === false ? 0 : 1,
      api_key: encryptSecret(s.api_key || ''),
      username: String(s.username || '').slice(0, 120),
      password: encryptSecret(s.password || ''),
      category: String(s.category || meta.category).slice(0, 40),
      icon_url: String(s.icon_url || '').slice(0, 500),
      enabled: s.enabled === false ? 0 : 1,
      sort_order: Number.isFinite(Number(s.sort_order)) ? Number(s.sort_order) : 0,
      poll_interval: clampPollMs(s.poll_interval),
      allowed_groups: JSON.stringify(Array.isArray(s.allowed_groups) ? s.allowed_groups : []),
      extra: JSON.stringify(s.extra && typeof s.extra === 'object' ? s.extra : {}),
      created_at: Date.now(),
    });
    restored++;
  }
  for (const key of ['appearance', 'widgets', 'general', 'sso', 'alerts']) {
    if (payload.settings?.[key] && typeof payload.settings[key] === 'object') setSetting(key, payload.settings[key]);
  }
  runner.reload();
  audit(req, 'backup_restored', `${restored} services`);
  res.json({ ok: true, services: restored });
});

// ---------------------------------------------------------------------------
// background upload (raw body, magic-byte sniffed)
// ---------------------------------------------------------------------------
const MAGIC = [
  { ext: 'jpg', type: 'image/jpeg', check: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', type: 'image/png', check: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: 'gif', type: 'image/gif', check: (b) => b.slice(0, 4).toString('ascii') === 'GIF8' },
  { ext: 'webp', type: 'image/webp', check: (b) => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
];

apiRouter.post('/upload/background', requireAdmin, express.raw({ type: () => true, limit: '12mb' }), (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 12) return res.status(400).json({ error: 'Empty upload' });
  const hit = MAGIC.find((m) => m.check(buf));
  if (!hit) return res.status(400).json({ error: 'Only JPEG, PNG, GIF or WebP images are supported' });
  const name = `bg-${Date.now()}.${hit.ext}`;
  fs.writeFileSync(path.join(config.uploadsDir, name), buf);
  // keep uploads dir small: remove older backgrounds
  for (const f of fs.readdirSync(config.uploadsDir)) {
    if (f.startsWith('bg-') && f !== name) {
      try { fs.unlinkSync(path.join(config.uploadsDir, f)); } catch { /* ignore */ }
    }
  }
  audit(req, 'background_uploaded', name);
  res.json({ url: `/uploads/${name}` });
});

apiRouter.get('/audit', requireAdmin, (req, res) => {
  res.json({ entries: listAudit({ limit: req.query.limit, q: req.query.q }) });
});

apiRouter.post('/alerts/test', requireAdmin, wrap(async (req, res) => {
  const cfg = getSetting('alerts', {});
  if (!cfg.url) return res.status(400).json({ error: 'No webhook URL configured' });
  const ok = await postWebhook(cfg.url, { app: 'HomeDeck', event: 'test', ts: Date.now(), message: 'HomeDeck test alert' });
  if (!ok) return res.status(502).json({ error: 'Webhook request failed' });
  res.json({ ok: true });
}));

// Liveness/readiness for containers and uptime monitors (no auth: counts only).
apiRouter.get('/health', (req, res) => {
  let dbOk = true;
  try { db.prepare('SELECT 1 AS ok').get(); } catch { dbOk = false; }
  res.status(dbOk ? 200 : 503).json({
    ok: dbOk,
    version: config.version,
    uptime: Math.round(process.uptime()),
    services: runner.services.size,
    sseClients: runner.clients.size,
    db: dbOk ? 'ok' : 'error',
  });
});

// Force a weather refresh (the widget's refresh button).
apiRouter.post('/weather/refresh', requireAuth, wrap(async (req, res) => {
  try {
    const weather = await runner.refreshWeather();
    res.json({ weather });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// City / postal-code lookup for the weather settings (admin only).
apiRouter.get('/weather/search', requireAdmin, wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const country = String(req.query.country || '').trim().toUpperCase().slice(0, 2);
  if (q.length < 2) return res.status(400).json({ error: 'Enter at least 2 characters' });
  const postalQuery = /^\d{3,6}$/.test(q);
  if (postalQuery && !/^[A-Z]{2}$/.test(country)) {
    return res.status(400).json({ error: 'Add a country code (e.g. DE) for postal code search' });
  }

  let results = [];
  if (postalQuery) {
    try {
      const r = await fetch(`https://api.zippopotam.us/${country}/${encodeURIComponent(q)}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        const j = await r.json();
        results = (j.places || []).map((p) => ({
          id: `zip-${country}-${q}-${p['place name']}`,
          name: p['place name'],
          lat: Number(p.latitude),
          lon: Number(p.longitude),
          country,
          admin1: p.state || '',
          postcode: j['post code'] || q,
        })).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon));
      }
    } catch { /* no results */ }
    return res.json({ results: results.slice(0, 10) });
  }

  if (!results.length) {
    try {
      const url = 'https://geocoding-api.open-meteo.com/v1/search'
        + `?name=${encodeURIComponent(q)}&count=8&language=en&format=json`;
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      results = (j.results || []).map((x) => ({
        id: `geo-${x.id || `${x.latitude},${x.longitude}`}`,
        name: x.name,
        lat: Number(x.latitude),
        lon: Number(x.longitude),
        country: x.country_code || '',
        admin1: x.admin1 || '',
        postcode: Array.isArray(x.postcodes) && x.postcodes.length ? x.postcodes[0] : '',
      })).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon));
    } catch (err) {
      return res.status(502).json({ error: `Location search failed: ${err.message}` });
    }
  }

  const seen = new Set();
  const out = results.filter((x) => {
    const key = `${x.name}|${x.lat}|${x.lon}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
  res.json({ results: out });
}));

// ---------------------------------------------------------------------------
// misc: ping
// ---------------------------------------------------------------------------
apiRouter.get('/ping', (req, res) => res.json({ ok: true, version: config.version }));

apiRouter.use((req, res) => res.status(404).json({ error: 'Not found' }));
