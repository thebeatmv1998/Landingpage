import { stmts, db, getSetting } from '../core/db.js';
import { getSessionWithUser } from '../auth/sessions.js';
import { serviceCtx } from './http.js';
import { serviceMeta } from './registry.js';
import { safeJsonParse, nowMs, clampPollMs } from '../core/util.js';
import { notify } from '../core/notify.js';

// Accept both the legacy single-location config and the multi-city form.
function weatherConfig(general) {
  const w = general?.weather;
  if (!w) return null;
  const unit = w.unit === 'f' ? 'f' : 'c';
  const raw = Array.isArray(w.locations)
    ? w.locations
    : (w.lat != null && w.lon != null ? [{ id: 'default', label: w.label || '', lat: w.lat, lon: w.lon }] : []);
  const locations = raw.map((loc, i) => ({
    id: String(loc.id || `loc-${i}`).slice(0, 80),
    label: String(loc.label || '').slice(0, 80),
    lat: Number(loc.lat),
    lon: Number(loc.lon),
    country: String(loc.country || '').slice(0, 2),
    postcode: String(loc.postcode || '').slice(0, 16),
  })).filter((loc) => Number.isFinite(loc.lat) && Number.isFinite(loc.lon)
    && Math.abs(loc.lat) <= 90 && Math.abs(loc.lon) <= 180);
  return locations.length ? { unit, locations } : null;
}

// Loads all connectors by type.
import sonarr from './connectors/sonarr.js';
import radarr from './connectors/radarr.js';
import lidarr from './connectors/lidarr.js';
import prowlarr from './connectors/prowlarr.js';
import nzbhydra from './connectors/nzbhydra.js';
import sabnzbd from './connectors/sabnzbd.js';
import jellyfin from './connectors/jellyfin.js';
import audiobookshelf from './connectors/audiobookshelf.js';
import overseerr from './connectors/overseerr.js';
import navidrome from './connectors/navidrome.js';
import nextcloud from './connectors/nextcloud.js';
import pihole from './connectors/pihole.js';
import immich from './connectors/immich.js';
import komga from './connectors/komga.js';
import pingvin from './connectors/pingvin.js';
import stash from './connectors/stash.js';
import tachidesk from './connectors/tachidesk.js';
import vaultwarden from './connectors/vaultwarden.js';
import docker from './connectors/docker.js';
import unraid from './connectors/unraid.js';
import generic from './connectors/generic.js';

const connectors = {
  sonarr, radarr, lidarr, prowlarr, nzbhydra, sabnzbd, jellyfin, audiobookshelf,
  seerr: overseerr, overseerr, jellyseerr: overseerr,
  navidrome, nextcloud, pihole, immich, komga, pingvin, stash, tachidesk, vaultwarden,
  docker, unraid, generic,
};

export function getConnector(type) {
  return connectors[type] || null;
}

class Runner {
  constructor() {
    this.services = new Map();   // id -> service row
    this.snapshots = new Map();  // id -> snapshot
    this.timers = new Map();     // id -> nextRunAt
    this.running = new Set();
    this.failCounts = new Map(); // id -> consecutive poll failures
    this.clients = new Set();    // SSE responses
    this.prevOnline = new Map(); // id -> last online state (alert transitions)
    this.diskHigh = new Map();   // `id:label` -> above-threshold flag
    this.weather = null;
    this.weatherAt = 0;
    this.tick = null;
  }

  reload() {
    const rows = stmts.servicesAll.all();
    const seen = new Set();
    for (const row of rows) {
      seen.add(row.id);
      const prev = this.services.get(row.id);
      if (prev && (prev.password !== row.password || prev.api_key !== row.api_key || prev.username !== row.username || prev.url !== row.url)) {
        // Credentials/URL changed — let connectors drop cached sessions/tokens.
        try { getConnector(row.type)?.reset?.(row.id); } catch { /* ignore */ }
      }
      this.services.set(row.id, row);
      if (!this.timers.has(row.id)) {
        // stagger the first run to spread load
        this.timers.set(row.id, nowMs() + (row.id % 10) * 600);
      }
      if (!row.enabled && this.snapshots.has(row.id)) {
        this.snapshots.delete(row.id);
      }
    }
    for (const id of [...this.services.keys()]) {
      if (!seen.has(id)) {
        this.services.delete(id);
        this.timers.delete(id);
        this.snapshots.delete(id);
      }
    }
    if (!this.tick) {
      this.tick = setInterval(() => this.pump(), 1000);
      this.tick.unref();
    }
  }

  baseSnapshot(row) {
    const meta = serviceMeta(row.type);
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      url: row.url,
      fallbackUrl: row.fallback_url || '',
      autoSwitch: row.auto_switch !== 0,
      category: row.category || meta.category,
      color: meta.color,
      glyph: meta.glyph,
      iconUrl: row.icon_url || meta.icon || '',
      enabled: !!row.enabled,
      online: false,
      error: '',
      stats: [],
      activity: [],
      history: [],
      nowPlaying: [],
      containers: [],
      requests: [],
      requestCounts: { open: 0, approved: 0, available: 0 },
      calendar: [],
      charts: {},
      version: '',
      fetchedAt: null,
    };
  }

  async pollService(row) {
    const snap = this.baseSnapshot(row);
    if (!row.enabled) {
      snap.online = false;
      snap.error = 'disabled';
      return snap;
    }
    const connector = getConnector(row.type);
    if (!connector) {
      snap.error = `No connector for type "${row.type}"`;
      return snap;
    }
    const started = Date.now();
    try {
      const ctx = serviceCtx(row);
      const data = await connector.poll(ctx);
      this.failCounts.delete(row.id);
      Object.assign(snap, data, {
        online: true,
        stale: false,
        error: '',
        fetchedAt: nowMs(),
        responseMs: Date.now() - started,
      });
    } catch (err) {
      const prev = this.snapshots.get(row.id);
      const fails = (this.failCounts.get(row.id) || 0) + 1;
      this.failCounts.set(row.id, fails);
      snap.responseMs = Date.now() - started;
      snap.error = String(err?.message || err).slice(0, 300);
      snap.fetchedAt = nowMs();
      // transient failures (rate limits, network resets): keep the last good data
      // visible with a stale flag for up to 3 consecutive failures before going offline
      if (prev && prev.online && fails < 4) {
        return { ...prev, online: true, stale: true, error: snap.error, fetchedAt: snap.fetchedAt };
      }
      snap.online = false;
    }
    return snap;
  }

  // Base poll interval with exponential backoff (capped) + jitter for failing services.
  nextInterval(row) {
    const meta = serviceMeta(row.type);
    const base = clampPollMs(row.poll_interval) || meta.pollMs || 30000;
    const fails = this.failCounts.get(row.id) || 0;
    const backoff = fails > 0 ? Math.min(base * 2 ** Math.min(fails - 1, 4), 30 * 60_000) : base;
    return Math.round(backoff + Math.random() * Math.min(1500, backoff * 0.08));
  }

  // Fire webhook alerts on online/offline transitions and disk-threshold crossings.
  handleAlerts(snap) {
    const prev = this.prevOnline.get(snap.id);
    if (prev !== undefined && prev !== snap.online) {
      notify(snap.online ? 'service_up' : 'service_down', {
        service: snap.name,
        type: snap.type,
        ...(snap.online ? {} : { error: snap.error || '' }),
      });
    }
    this.prevOnline.set(snap.id, snap.online);

    const cfg = getSetting('alerts', {});
    const threshold = Number(cfg.diskPct) || 90;
    for (const d of snap.charts?.disks || []) {
      if (!(d.totalGB > 0)) continue;
      const pct = Math.round((d.usedGB / d.totalGB) * 100);
      const key = `${snap.id}:${d.label}`;
      const was = this.diskHigh.get(key) || false;
      const high = pct >= threshold;
      if (high && !was) notify('disk_high', { service: snap.name, disk: d.label, percent: pct, threshold });
      this.diskHigh.set(key, high);
    }
  }

  async pump() {
    const now = nowMs();
    for (const [id, row] of this.services) {
      if (!row.enabled) continue;
      const nextAt = this.timers.get(id) ?? 0;
      if (nextAt > now || this.running.has(id)) continue;
      this.running.add(id);
      this.timers.set(id, now + 3600_000); // placeholder until poll finishes
      this.pollService(row)
        .then((snap) => {
          this.snapshots.set(id, snap);
          this.timers.set(id, nowMs() + this.nextInterval(row));
          this.handleAlerts(snap);
          this.broadcast('service', snap);
        })
        .catch((err) => {
          // should not happen (pollService catches), but keep the loop alive
          this.timers.set(id, nowMs() + 30000);
          console.error(`[runner] service ${row.name} poll crashed:`, err);
        })
        .finally(() => this.running.delete(id));
    }
    this.maybeFetchWeather();
  }

  // Force a weather fetch (used by the poller and the widget's refresh button).
  async refreshWeather() {
    const general = safeJsonParse(stmts.settingGet.get('general')?.value, {}) || {};
    const cfg = weatherConfig(general);
    if (!cfg) throw new Error('Weather location is not configured (Settings → Administration → General)');
    const now = nowMs();
    const locations = await Promise.all(cfg.locations.map(async (loc) => {
      try {
        const url = 'https://api.open-meteo.com/v1/forecast'
          + `?latitude=${encodeURIComponent(loc.lat)}&longitude=${encodeURIComponent(loc.lon)}`
          + '&current=temperature_2m,weather_code,wind_speed_10m,is_day'
          + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
          + '&timezone=auto&forecast_days=5';
        const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(`Weather service returned HTTP ${r.status}`);
        const j = await r.json();
        const daily = (j?.daily?.time || []).map((date, i) => ({
          date,
          code: j.daily.weather_code?.[i] ?? null,
          max: j.daily.temperature_2m_max?.[i] ?? null,
          min: j.daily.temperature_2m_min?.[i] ?? null,
          precip: j.daily.precipitation_probability_max?.[i] ?? null,
        })).slice(0, 5);
        return {
          ...loc,
          unit: cfg.unit,
          temp: j?.current?.temperature_2m,
          code: j?.current?.weather_code,
          wind: j?.current?.wind_speed_10m,
          isDay: j?.current?.is_day,
          max: j?.daily?.temperature_2m_max?.[0],
          min: j?.daily?.temperature_2m_min?.[0],
          daily,
          updatedAt: now,
          error: '',
        };
      } catch (err) {
        return {
          ...loc,
          unit: cfg.unit,
          temp: null,
          code: null,
          wind: null,
          isDay: 1,
          max: null,
          min: null,
          daily: [],
          updatedAt: now,
          error: String(err?.message || err).slice(0, 160),
        };
      }
    }));
    const primary = locations.find((loc) => loc.temp != null) || locations[0];
    this.weather = {
      ...primary,
      unit: cfg.unit,
      updatedAt: now,
      locations,
    };
    this.weatherAt = now;
    this.broadcast('weather', this.weather);
    return this.weather;
  }

  maybeFetchWeather() {
    const general = safeJsonParse(stmts.settingGet.get('general')?.value, {}) || {};
    if (!weatherConfig(general)) return;
    if (nowMs() - this.weatherAt < 10 * 60_000) return;
    this.weatherAt = nowMs(); // throttle immediately so concurrent ticks don't stampede
    this.refreshWeather().catch(() => { /* keep the last good weather */ });
  }

  // ------------------------------------------------------------------ SSE
  // Resolve the current identity behind an SSE connection. Sessions and device
  // tokens are re-checked so a logout/revocation also closes existing streams.
  streamUser(res) {
    try {
      if (res.hdSessionToken) {
        const found = getSessionWithUser(res.hdSessionToken);
        return found?.user || null;
      }
      if (res.hdDeviceHash) {
        const row = stmts.deviceByHash.get(res.hdDeviceHash);
        if (!row) return null;
        return stmts.userById.get(row.user_id) || null;
      }
    } catch { /* treat as revoked */ }
    return null;
  }

  addClient(res, { user, sessionToken = null, device = null } = {}) {
    if (!user) {
      try { res.status(401).end(); } catch { /* ignore */ }
      return () => {};
    }
    // Guard against connection exhaustion / accidental reconnect storms.
    if (this.clients.size >= 200) {
      try { res.status(503).end(); } catch { /* ignore */ }
      return () => {};
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.hdSessionToken = sessionToken;
    res.hdDeviceHash = device?.token_hash || null;
    this.clients.add(res);
    // Initial burst: only services this user is allowed to see.
    const visible = new Set(this.visibleServicesFor(user).map((s) => s.id));
    for (const [id, snap] of this.snapshots) {
      if (visible.has(id)) this.writeEvent(res, 'service', snap);
    }
    if (this.weather) this.writeEvent(res, 'weather', this.weather);
    return () => this.clients.delete(res);
  }

  writeEvent(res, event, data) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { this.clients.delete(res); }
  }

  broadcast(event, data) {
    for (const res of this.clients) {
      const user = this.streamUser(res);
      if (!user) {
        try { res.end(); } catch { /* ignore */ }
        this.clients.delete(res);
        continue;
      }
      if (event === 'service' && data?.id != null
        && !this.visibleServicesFor(user).some((s) => s.id === Number(data.id))) {
        continue;
      }
      this.writeEvent(res, event, data);
    }
  }

  heartbeat() {
    for (const res of this.clients) {
      if (!this.streamUser(res)) {
        try { res.end(); } catch { /* ignore */ }
        this.clients.delete(res);
        continue;
      }
      try { res.write(': hb\n\n'); } catch { this.clients.delete(res); }
    }
  }

  // ------------------------------------------------------------- snapshot
  visibleServicesFor(user) {
    const group = user?.group_name || '';
    return [...this.services.values()].filter((row) => {
      if (!row.enabled) return false;
      const groups = safeJsonParse(row.allowed_groups, []) || [];
      if (!groups.length) return true;
      return user?.role === 'admin' || groups.includes(group);
    });
  }

  snapshotFor(user) {
    const services = this.visibleServicesFor(user)
      .map((row) => this.snapshots.get(row.id) || this.baseSnapshot(row));
    services.sort((a, b) => {
      const ra = this.services.get(a.id), rb = this.services.get(b.id);
      return (ra?.sort_order ?? 0) - (rb?.sort_order ?? 0) || a.id - b.id;
    });
    return { services, weather: this.weather, generatedAt: nowMs() };
  }

  startHeartbeat() {
    setInterval(() => this.heartbeat(), 25_000).unref();
  }
}

export const runner = new Runner();

export function testService(row) {
  const connector = getConnector(row.type);
  if (!connector) return Promise.resolve({ ok: false, message: `Unknown service type "${row.type}"` });
  return connector.test(serviceCtx(row));
}

// Run a connector action (e.g. SABnzbd pause/resume) and refresh the service right away.
export async function runServiceAction(row, payload) {
  const connector = getConnector(row.type);
  if (!connector || typeof connector.action !== 'function') {
    return { ok: false, message: `Service type "${row.type}" has no actions` };
  }
  const result = await connector.action(serviceCtx(row), payload || {});
  if (result?.ok) {
    // refresh immediately so the UI reflects the change
    runner.timers.set(row.id, nowMs());
    const snap = await runner.pollService(row);
    runner.snapshots.set(row.id, snap);
    runner.broadcast('service', snap);
    runner.timers.set(row.id, nowMs() + runner.nextInterval(row));
  }
  return result;
}
