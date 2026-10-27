// Long-term metric history + uptime buckets.
//
// Metrics are written into 5-minute buckets. A periodic rollup derives hourly
// and daily buckets, and retention deletes old data. Queries aggregate on read
// so the API can serve 24h/7d/30d without storing per-second samples.
import { db, getSetting } from '../core/db.js';
import { nowMs } from '../core/util.js';

const BUCKET_MS = 5 * 60_000;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export const RANGES = { '24h': DAY_MS, '7d': 7 * DAY_MS, '30d': 30 * DAY_MS };

const upsertMetric = db.prepare(`
  INSERT INTO metric_buckets (service_id, metric, resolution, bucket, sum, count, min_v, max_v, last)
  VALUES (:service_id, :metric, :resolution, :bucket, :sum, :count, :min_v, :max_v, :last)
  ON CONFLICT(service_id, metric, resolution, bucket) DO UPDATE SET
    sum = excluded.sum, count = excluded.count, min_v = excluded.min_v,
    max_v = excluded.max_v, last = excluded.last
`);

const upsertUptime = db.prepare(`
  INSERT INTO uptime_buckets (service_id, bucket, total, online, sum_ms)
  VALUES (:service_id, :bucket, 1, :online, :sum_ms)
  ON CONFLICT(service_id, bucket) DO UPDATE SET
    total = total + 1, online = online + excluded.online, sum_ms = sum_ms + excluded.sum_ms
`);

function bucketStart(ts, size = BUCKET_MS) {
  return Math.floor(ts / size) * size;
}

function number(value) {
  const parsed = Number.parseFloat(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function rate(value) {
  const match = /([\d.]+)\s*(B|kB|KB|MB|GB)\/s/i.exec(String(value || ''));
  if (!match) return null;
  const unit = match[2].toLowerCase();
  const factor = unit === 'kb' ? 1024 : unit === 'mb' ? 1024 ** 2 : unit === 'gb' ? 1024 ** 3 : 1;
  return Number.parseFloat(match[1]) * factor;
}

export function recordMetric(serviceId, metric, value, ts = Date.now()) {
  if (!Number.isFinite(Number(value))) return;
  const bucket = bucketStart(ts);
  const numeric = Number(value);
  upsertMetric.run({
    service_id: Number(serviceId),
    metric: String(metric).slice(0, 40),
    resolution: 0,
    bucket,
    sum: numeric,
    count: 1,
    min_v: numeric,
    max_v: numeric,
    last: numeric,
  });
}

export function recordUptime(serviceId, online, responseMs = 0, ts = Date.now()) {
  upsertUptime.run({
    service_id: Number(serviceId),
    bucket: bucketStart(ts),
    online: online ? 1 : 0,
    sum_ms: Math.max(0, Math.round(Number(responseMs) || 0)),
  });
}

/** Persist the metrics we care about from a service snapshot. */
export function recordSnapshot(snap, ts = Date.now()) {
  try {
    if (!snap?.id) return;
    const stat = (label) => (snap.stats || [])
      .find((entry) => String(entry.label).toLowerCase() === label.toLowerCase())?.value;
    const metrics = {};
    if (Number.isFinite(snap.responseMs)) metrics.response_ms = snap.responseMs;
    if (snap.type === 'host') {
      metrics.cpu = number(stat('CPU'));
      metrics.ram = number(stat('RAM'));
      metrics.swap = number(stat('Swap'));
      metrics.temp = number(stat('Temp'));
      metrics.net_rx = rate(stat('Net down'));
      metrics.net_tx = rate(stat('Net up'));
    } else if (snap.type === 'pihole') {
      metrics.pihole_rate = number(stat('Blocked %'));
      metrics.pihole_queries = number(stat('Queries today'));
    } else if (snap.type === 'sabnzbd') {
      metrics.download_speed = number(snap.charts?.downloads?.speedBps);
      metrics.download_progress = number(snap.charts?.downloads?.overall);
    }
    for (const [metric, value] of Object.entries(metrics)) {
      if (value != null && Number.isFinite(value)) recordMetric(snap.id, metric, value, ts);
    }
    recordUptime(snap.id, !!snap.online, snap.responseMs, ts);
  } catch {
    // History must never break the poller.
  }
}

export function retention() {
  const cfg = getSetting('history', {}) || {};
  const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
  };
  return {
    rawHours: clamp(cfg.rawHours, 1, 24 * 30, 48),
    hourlyDays: clamp(cfg.hourlyDays, 1, 3650, 90),
    dailyDays: clamp(cfg.dailyDays, 1, 3650, 730),
    uptimeDays: clamp(cfg.uptimeDays, 1, 365, 30),
  };
}

function aggregate(rows, size, resolution) {
  const groups = new Map();
  for (const row of rows) {
    const bucket = bucketStart(row.bucket, size);
    const key = `${row.service_id}|${row.metric}|${bucket}`;
    const agg = groups.get(key) || {
      service_id: row.service_id,
      metric: row.metric,
      resolution,
      bucket,
      sum: 0,
      count: 0,
      min_v: row.min_v,
      max_v: row.max_v,
      last: row.last,
    };
    agg.sum += Number(row.sum) || 0;
    agg.count += Number(row.count) || 0;
    agg.min_v = Math.min(agg.min_v, row.min_v);
    agg.max_v = Math.max(agg.max_v, row.max_v);
    agg.last = row.last;
    groups.set(key, agg);
  }
  return [...groups.values()];
}

/**
 * Rebuild hourly buckets from 5-minute data and daily buckets from hourly data.
 * `full` rebuilds everything (startup); the periodic run only touches recent
 * windows so it stays cheap.
 */
export function rollup(now = nowMs(), full = false) {
  const hourlyFrom = full ? 0 : now - 3 * HOUR_MS;
  const dailyFrom = full ? 0 : now - 3 * DAY_MS;

  const rawRows = db.prepare(
    'SELECT service_id, metric, bucket, sum, count, min_v, max_v, last FROM metric_buckets WHERE resolution = 0 AND bucket >= ?',
  ).all(hourlyFrom);
  const hourly = aggregate(rawRows, HOUR_MS, 1);

  const hourRows = db.prepare(
    'SELECT service_id, metric, bucket, sum, count, min_v, max_v, last FROM metric_buckets WHERE resolution = 1 AND bucket >= ?',
  ).all(dailyFrom);
  const daily = aggregate(hourRows, DAY_MS, 2);

  const rows = [...hourly, ...daily];
  if (!rows.length) return;
  db.exec('BEGIN');
  try {
    for (const row of rows) upsertMetric.run(row);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function cleanup(now = nowMs()) {
  const cfg = retention();
  db.prepare('DELETE FROM metric_buckets WHERE resolution = 0 AND bucket < ?')
    .run(now - cfg.rawHours * HOUR_MS);
  db.prepare('DELETE FROM metric_buckets WHERE resolution = 1 AND bucket < ?')
    .run(now - cfg.hourlyDays * DAY_MS);
  db.prepare('DELETE FROM metric_buckets WHERE resolution = 2 AND bucket < ?')
    .run(now - cfg.dailyDays * DAY_MS);
  db.prepare('DELETE FROM uptime_buckets WHERE bucket < ?')
    .run(now - cfg.uptimeDays * DAY_MS);
}

export function queryHistory(serviceId, metric, range = '24h', now = nowMs()) {
  const span = RANGES[range] || RANGES['24h'];
  const resolution = range === '24h' ? 0 : 1;
  const since = bucketStart(now - span, resolution === 1 ? HOUR_MS : BUCKET_MS);
  const rows = db.prepare(`
    SELECT bucket, sum, count, min_v, max_v
    FROM metric_buckets
    WHERE service_id = ? AND metric = ? AND resolution = ? AND bucket >= ?
    ORDER BY bucket ASC
  `).all(Number(serviceId), String(metric), resolution, since);
  if (!rows.length && resolution === 1) {
    // Until the first hourly rollup runs, serve the raw 5-minute buckets.
    const rawSince = bucketStart(now - span, BUCKET_MS);
    const raw = db.prepare(`
      SELECT bucket, sum, count, min_v, max_v
      FROM metric_buckets
      WHERE service_id = ? AND metric = ? AND resolution = 0 AND bucket >= ?
      ORDER BY bucket ASC
    `).all(Number(serviceId), String(metric), rawSince);
    return raw.map((row) => ({
      t: row.bucket,
      v: row.count > 0 ? +(row.sum / row.count).toFixed(3) : 0,
      min: row.min_v,
      max: row.max_v,
    }));
  }
  return rows.map((row) => ({
    t: row.bucket,
    v: row.count > 0 ? +(row.sum / row.count).toFixed(3) : 0,
    min: row.min_v,
    max: row.max_v,
  }));
}

export function uptimeSummary(range = '24h', services = [], now = nowMs()) {
  const span = RANGES[range] || RANGES['24h'];
  const since = now - span;
  const groupSize = range === '24h' ? HOUR_MS : range === '7d' ? 6 * HOUR_MS : DAY_MS;
  const stmt = db.prepare(
    'SELECT bucket, total, online, sum_ms FROM uptime_buckets WHERE service_id = ? AND bucket >= ? ORDER BY bucket ASC',
  );
  return services.map((service) => {
    const rows = stmt.all(service.id, since);
    let total = 0;
    let online = 0;
    let sumMs = 0;
    const buckets = new Map();
    for (const row of rows) {
      total += row.total;
      online += row.online;
      sumMs += row.sum_ms;
      const bucket = bucketStart(row.bucket, groupSize);
      const agg = buckets.get(bucket) || { total: 0, online: 0 };
      agg.total += row.total;
      agg.online += row.online;
      buckets.set(bucket, agg);
    }
    return {
      id: service.id,
      name: service.name,
      type: service.type,
      pct: total > 0 ? +(online * 100 / total).toFixed(2) : null,
      total,
      online,
      avgMs: total > 0 ? Math.round(sumMs / total) : null,
      timeline: [...buckets.entries()].map(([t, agg]) => ({
        t,
        pct: agg.total > 0 ? +(agg.online * 100 / agg.total).toFixed(1) : null,
      })),
    };
  });
}

let historyTimer = null;

export function startHistoryJobs() {
  if (historyTimer) return;
  try {
    rollup(nowMs(), true);
    cleanup(nowMs());
  } catch (err) {
    console.error('[history] initial rollup failed:', err.message);
  }
  historyTimer = setInterval(() => {
    try {
      rollup();
      cleanup();
    } catch (err) {
      console.error('[history] rollup failed:', err.message);
    }
  }, BUCKET_MS);
  historyTimer.unref?.();
}
