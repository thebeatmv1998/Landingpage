// TLS certificate monitoring for HTTPS services. Checks are cached on disk and
// in memory for six hours; expiry alerts fire once per threshold and day and go
// through the existing webhook notifier.
import tls from 'node:tls';
import { db } from '../core/db.js';
import { notify } from '../core/notify.js';

const TTL = 6 * 60 * 60_000;
const DAY = 24 * 60 * 60_000;
const THRESHOLDS = [30, 14, 7];
const cache = new Map(); // service id -> { info, at }
const inflight = new Set();

function targetFor(row) {
  for (const raw of [row.url, row.fallback_url]) {
    try {
      const url = new URL(String(raw || ''));
      if (url.protocol !== 'https:') continue;
      return { host: url.hostname, port: Number(url.port) || 443 };
    } catch {
      // try the next URL
    }
  }
  return null;
}

function dbInfo(serviceId) {
  try {
    const row = db.prepare('SELECT * FROM service_ssl WHERE service_id = ?').get(serviceId);
    if (!row) return null;
    const daysLeft = row.expires_at ? Math.ceil((row.expires_at - Date.now()) / DAY) : null;
    return {
      host: row.host,
      expiresAt: row.expires_at,
      daysLeft,
      error: row.error || '',
      checkedAt: row.checked_at || 0,
    };
  } catch {
    return null;
  }
}

function persist(serviceId, info) {
  try {
    const current = db.prepare('SELECT last_alert, expires_at FROM service_ssl WHERE service_id = ?').get(serviceId);
    db.prepare(`
      INSERT INTO service_ssl (service_id, host, expires_at, checked_at, error, last_alert)
      VALUES (:service_id, :host, :expires_at, :checked_at, :error, :last_alert)
      ON CONFLICT(service_id) DO UPDATE SET
        host = excluded.host, expires_at = excluded.expires_at,
        checked_at = excluded.checked_at, error = excluded.error,
        last_alert = excluded.last_alert
    `).run({
      service_id: serviceId,
      host: info.host || '',
      expires_at: info.expiresAt || current?.expires_at || null,
      checked_at: Date.now(),
      error: info.error || '',
      last_alert: current?.last_alert || '',
    });
  } catch {
    // certificate info must never break polling
  }
}

function check(target) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: target.host,
      port: target.port,
      servername: target.host,
      rejectUnauthorized: false,
      timeout: 8000,
    }, () => {
      try {
        const cert = socket.getPeerCertificate(true);
        socket.end();
        if (!cert || !cert.valid_to) {
          reject(new Error('The server returned no certificate'));
          return;
        }
        const expiresAt = Date.parse(cert.valid_to);
        if (!Number.isFinite(expiresAt)) {
          reject(new Error('Invalid certificate expiry'));
          return;
        }
        resolve({
          host: target.host,
          expiresAt,
          daysLeft: Math.ceil((expiresAt - Date.now()) / DAY),
          subject: cert.subject?.CN || '',
          issuer: cert.issuer?.O || cert.issuer?.CN || '',
          error: '',
        });
      } catch (err) {
        reject(err);
      }
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('TLS check timed out'));
    });
    socket.once('error', reject);
  });
}

function maybeAlert(row, info) {
  if (!Number.isFinite(info.daysLeft)) return;
  const threshold = THRESHOLDS.find((value) => info.daysLeft <= value);
  if (threshold == null) return;
  const day = new Date().toISOString().slice(0, 10);
  const key = `${day}:${threshold}`;
  try {
    const current = db.prepare('SELECT last_alert FROM service_ssl WHERE service_id = ?').get(row.id);
    if (current?.last_alert === key) return;
    db.prepare('UPDATE service_ssl SET last_alert = ? WHERE service_id = ?').run(key, row.id);
  } catch {
    return;
  }
  notify('ssl_expiring', {
    service: row.name,
    host: info.host,
    daysLeft: info.daysLeft,
    expiresAt: new Date(info.expiresAt).toISOString(),
    threshold,
  });
}

/** Attach cached certificate information to a snapshot (no network I/O). */
export function attach(row, snap) {
  if (!snap) return;
  if (!targetFor(row)) {
    snap.ssl = null;
    return;
  }
  let cached = cache.get(row.id);
  if (!cached) {
    const info = dbInfo(row.id);
    if (info) {
      cached = { info, at: info.checkedAt || 0 };
      cache.set(row.id, cached);
    }
  }
  snap.ssl = cached?.info || null;
}

/** Refresh the certificate in the background when the cache is stale. */
export function ensure(row) {
  const target = targetFor(row);
  if (!target) return;
  const cached = cache.get(row.id);
  if (cached && Date.now() - cached.at < TTL) return;
  if (inflight.has(row.id)) return;
  inflight.add(row.id);
  check(target)
    .then((info) => {
      cache.set(row.id, { info, at: Date.now() });
      persist(row.id, info);
      maybeAlert(row, info);
    })
    .catch((err) => {
      const previous = dbInfo(row.id);
      const info = {
        host: target.host,
        expiresAt: previous?.expiresAt || null,
        daysLeft: previous?.daysLeft ?? null,
        error: String(err?.message || err).slice(0, 200),
      };
      cache.set(row.id, { info, at: Date.now() });
      persist(row.id, info);
    })
    .finally(() => inflight.delete(row.id));
}
