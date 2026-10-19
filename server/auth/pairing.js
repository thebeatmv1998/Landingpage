// QR pairing + device tokens for the native Android app.
//
// Flow:
//   1. A signed-in user asks the web UI for a pairing code. We store only its
//      SHA-256 hash, bound to the user and valid for five minutes.
//   2. The web UI renders the one-time code as a QR (data URL, generated here).
//   3. The app scans the QR, POSTs the code to /api/pair/claim and receives a
//      long-lived bearer token (also stored hashed at rest).
//   4. The app sends `Authorization: Bearer hd_…` on every request.
import express from 'express';
import QRCode from 'qrcode';
import { stmts, getUserById, getSetting } from '../core/db.js';
import { config } from '../core/config.js';
import { genToken, nowMs } from '../core/util.js';
import { hashAuthToken, requireAuth, rateLimit, createDeviceToken, listUserDevices, revokeUserDevice } from './sessions.js';
import { audit } from '../core/audit.js';

export const pairingRouter = express.Router();

const PAIRING_TTL_MS = 5 * 60 * 1000;

function normalizeServerUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname) return '';
    u.hash = '';
    u.search = '';
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return '';
  }
}

function defaultServerUrl(req) {
  if (config.publicUrl) return config.publicUrl;
  return `${req.protocol || 'http'}://${req.get('host')}`;
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name || u.username,
    role: u.role,
    groupName: u.group_name || '',
  };
}

// Start pairing: returns a one-time code + QR image. Any previously generated
// code for this user is invalidated, so only the newest QR can be used.
pairingRouter.post('/start', requireAuth, (req, res) => {
  const provided = String(req.body?.serverUrl || '').trim();
  const serverUrl = provided ? normalizeServerUrl(provided) : normalizeServerUrl(defaultServerUrl(req));
  if (!serverUrl) return res.status(400).json({ error: 'serverUrl must be an http(s) URL' });

  const code = genToken(32);
  const now = nowMs();
  const expiresAt = now + PAIRING_TTL_MS;
  stmts.pairingDeleteUser.run(req.user.id);
  stmts.pairingInsert.run({
    user_id: req.user.id,
    code_hash: hashAuthToken(code),
    server_url: serverUrl,
    created_at: now,
    expires_at: expiresAt,
  });

  const payload = `homedeck://pair?url=${encodeURIComponent(serverUrl)}&code=${encodeURIComponent(code)}`;
  QRCode.toDataURL(payload, { margin: 1, width: 280, errorCorrectionLevel: 'M' })
    .then((qr) => {
      audit(req, 'pairing_started', serverUrl);
      res.json({ code, payload, qr, serverUrl, expiresAt });
    })
    .catch(() => res.status(500).json({ error: 'Could not create the pairing QR code' }));
});

// Claim a pairing code (unauthenticated; the high-entropy one-time code is the
// credential). The response contains the raw device token exactly once.
pairingRouter.post('/claim', rateLimit('pair-claim', 20, 10 * 60 * 1000), (req, res) => {
  const code = String(req.body?.code || '').trim();
  if (!/^[A-Za-z0-9_-]{20,120}$/.test(code)) {
    return res.status(401).json({ error: 'Pairing code is invalid or has expired' });
  }
  const row = stmts.pairingByHash.get(hashAuthToken(code));
  const now = nowMs();
  if (!row || row.used_at || row.expires_at < now) {
    return res.status(401).json({ error: 'Pairing code is invalid or has expired' });
  }
  const consumed = stmts.pairingConsume.run({ id: row.id, used_at: now });
  if (consumed.changes !== 1) {
    return res.status(401).json({ error: 'Pairing code was already used' });
  }
  const user = getUserById(row.user_id);
  if (!user) return res.status(401).json({ error: 'Account no longer exists' });

  const deviceName = String(req.body?.deviceName || 'Android app').trim().slice(0, 60) || 'Android app';
  const token = createDeviceToken(user.id, {
    name: deviceName,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });
  audit(req, 'device_paired', `${user.username} · ${deviceName}`, user);
  res.json({
    token,
    serverUrl: row.server_url,
    user: publicUser(user),
    server: { title: getSetting('general', {}).title || 'HomeDeck' },
  });
});

// Paired devices for the current user (settings → Mobile app).
pairingRouter.get('/devices', requireAuth, (req, res) => {
  res.json({ devices: listUserDevices(req.user.id), current: req.device?.id || null });
});

pairingRouter.delete('/devices/:id', requireAuth, (req, res) => {
  if (!revokeUserDevice(req.user.id, req.params.id)) {
    return res.status(404).json({ error: 'Device not found' });
  }
  audit(req, 'device_revoked', `device ${req.params.id}`);
  res.json({ ok: true });
});

// The app calls this on "forget server" so the token is revoked server-side,
// not just deleted locally.
pairingRouter.delete('/current', requireAuth, (req, res) => {
  if (req.authType !== 'device' || !req.device) {
    return res.status(400).json({ error: 'Not a device token' });
  }
  const ok = revokeUserDevice(req.user.id, req.device.id);
  audit(req, 'device_revoked', req.device.name || 'app');
  res.json({ ok });
});

// Expired / already used pairing codes are useless — prune them regularly.
setInterval(() => {
  try { stmts.pairingDeleteExpired.run(nowMs()); } catch { /* ignore */ }
}, 10 * 60 * 1000).unref();
