import crypto from 'node:crypto';
import { stmts, db } from '../core/db.js';
import { config } from '../core/config.js';
import { genToken, nowMs } from '../core/util.js';

export const COOKIE_NAME = 'hd_session';

// Session tokens are stored as a SHA-256 hash at rest, so a database leak can't be
// turned into live sessions. The raw token only ever lives in the browser cookie.
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Exported for the pairing/device-token flows (same hashing scheme everywhere).
export function hashAuthToken(token) {
  return hashToken(token);
}

// Long-lived bearer tokens for native apps. The raw token is only returned once
// (to the device) — the database stores just its SHA-256 hash.
export function createDeviceToken(userId, { name = 'Android app', ip = '', userAgent = '' } = {}) {
  const token = `hd_${genToken(32)}`;
  const now = nowMs();
  stmts.deviceInsert.run({
    user_id: userId,
    name: String(name || 'Android app').slice(0, 60),
    token_hash: hashToken(token),
    created_at: now,
    last_used_at: now,
    last_ip: String(ip || '').slice(0, 60),
    user_agent: String(userAgent || '').slice(0, 250),
  });
  return token;
}

export function getDeviceAuth(token) {
  if (typeof token !== 'string' || !token.startsWith('hd_')) return null;
  const row = stmts.deviceByHash.get(hashToken(token));
  if (!row) return null;
  const user = stmts.userById.get(row.user_id);
  if (!user) return null;
  return { device: row, user };
}

export function touchDevice(device, ip) {
  if (!device) return;
  const now = nowMs();
  if (now - (device.last_used_at || 0) < 5 * 60 * 1000) return;
  stmts.deviceTouch.run({ id: device.id, last_used_at: now, last_ip: String(ip || '').slice(0, 60) });
}

export function listUserDevices(userId) {
  return stmts.devicesByUser.all(userId).map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    lastIp: r.last_ip || '',
    userAgent: r.user_agent || '',
  }));
}

export function revokeUserDevice(userId, id) {
  const deviceId = Number(id);
  if (!Number.isInteger(deviceId) || deviceId <= 0) return false;
  return stmts.deviceDelete.run({ id: deviceId, user_id: userId }).changes > 0;
}

export function destroyUserDevices(userId) {
  if (userId) stmts.deviceDeleteUser.run(userId);
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    let v = part.slice(idx + 1).trim();
    try { v = decodeURIComponent(v); } catch { /* keep raw */ }
    if (k) out[k] = v;
  }
  return out;
}

export function setSessionCookie(res, token, maxAgeSeconds) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (config.secureCookies) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  const arr = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  arr.push(parts.join('; '));
  res.setHeader('Set-Cookie', arr);
}

export function clearSessionCookie(res) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (config.secureCookies) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  const arr = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  arr.push(parts.join('; '));
  res.setHeader('Set-Cookie', arr);
}

export function createSession(userId, userAgent, remember = false) {
  const token = genToken(32);
  const ttlHours = remember ? config.sessionTtlRememberHours : config.sessionTtlHours;
  const now = nowMs();
  stmts.sessionInsert.run({
    token: hashToken(token),
    user_id: userId,
    created_at: now,
    expires_at: now + ttlHours * 3600 * 1000,
    user_agent: String(userAgent || '').slice(0, 250),
  });
  return token;
}

export function getSessionWithUser(token) {
  if (!token) return null;
  const sess = stmts.sessionGet.get(hashToken(token));
  if (!sess) return null;
  if (sess.expires_at < nowMs()) {
    stmts.sessionDelete.run({ token: hashToken(token) });
    return null;
  }
  const user = stmts.userById.get(sess.user_id);
  if (!user) return null;
  return { session: sess, user };
}

export function destroySession(token) {
  if (token) stmts.sessionDelete.run({ token: hashToken(token) });
}

export function destroyUserSessions(userId, exceptToken = null) {
  const except = exceptToken ? hashToken(exceptToken) : null;
  const rows = db.prepare('SELECT token FROM sessions WHERE user_id = ?').all(userId);
  for (const r of rows) {
    if (except && r.token === except) continue;
    stmts.sessionDelete.run({ token: r.token });
  }
}

// Session management (settings → Sessions). The public id is a short prefix of the
// stored token hash, so the raw token never leaves the browser.
export function listUserSessions(userId, currentToken) {
  const current = currentToken ? hashToken(currentToken) : '';
  return db.prepare('SELECT token, created_at, expires_at, user_agent FROM sessions WHERE user_id = ? ORDER BY created_at DESC').all(userId)
    .map((r) => ({
      id: r.token.slice(0, 16),
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      userAgent: r.user_agent || '',
      current: r.token === current,
    }));
}

export function revokeUserSession(userId, id) {
  if (!/^[a-f0-9]{16}$/i.test(String(id || ''))) return false;
  const row = db.prepare('SELECT token FROM sessions WHERE user_id = ? AND token LIKE ?').get(userId, `${id}%`);
  if (!row) return false;
  stmts.sessionDelete.run({ token: row.token });
  return true;
}

// Periodically purge expired sessions
setInterval(() => {
  try { stmts.sessionDeleteExpired.run({ now: nowMs() }); } catch { /* ignore */ }
}, 60 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------
export function attachUser(req, res, next) {
  req.user = null;
  req.session = null;
  req.sessionToken = null;
  req.device = null;
  req.authType = null;
  // Native apps authenticate with a bearer device token. The web UI never sends
  // one, so cookies remain the browser path.
  const auth = String(req.headers.authorization || '');
  if (/^Bearer\s+/i.test(auth)) {
    const found = getDeviceAuth(auth.replace(/^Bearer\s+/i, '').trim());
    if (found) {
      req.user = found.user;
      req.device = found.device;
      req.authType = 'device';
      touchDevice(found.device, req.ip);
    }
    return next();
  }
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  req.sessionToken = token || null;
  if (token) {
    const found = getSessionWithUser(token);
    if (found) {
      req.user = found.user;
      req.session = found.session;
      req.authType = 'session';
    }
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required' });
  next();
}

// CSRF defense: mutating API calls must carry our custom header and JSON content
// (cookie is SameSite=Lax which already blocks cross-site POSTs from forms, this is belt & braces)
export function csrfGuard(req, res, next) {
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (!mutating) return next();
  if (req.authType === 'device') return next(); // bearer token, no cookie → not CSRF-able
  if (req.path === '/pair/claim') return next(); // one-time pairing code, unauthenticated
  if (req.path.startsWith('/oauth/')) return next(); // OAuth callbacks are GET-only anyway
  if (req.headers['x-hd-csrf'] !== '1') {
    return res.status(403).json({ error: 'Missing CSRF header' });
  }
  // Browsers label cross-site requests; block those outright (defense in depth on
  // top of SameSite=Lax cookies + the custom header).
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    return res.status(403).json({ error: 'Cross-site request blocked' });
  }
  next();
}

// Login rate limiting (in-memory, per IP and per username)
const attempts = new Map(); // key -> {count, resetAt}
const ATTEMPTS_MAX = 10_000;

function pruneAttempts(now = Date.now()) {
  for (const [key, entry] of attempts) {
    if (entry.resetAt < now) attempts.delete(key);
  }
  // Hard cap for distributed/spoofed source addresses.
  while (attempts.size >= ATTEMPTS_MAX) {
    const oldest = attempts.keys().next().value;
    if (!oldest) break;
    attempts.delete(oldest);
  }
}
setInterval(() => pruneAttempts(), 5 * 60 * 1000).unref();

export function rateLimit(kind, max, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const ident = kind === 'login-user' ? String(req.body?.username || '').slice(0, 120).toLowerCase() : '';
    const key = `${kind}:${ip}${ident ? ':' + ident : ''}`;
    const now = Date.now();
    let entry = attempts.get(key);
    if (!entry || entry.resetAt < now) {
      pruneAttempts(now);
      entry = { count: 0, resetAt: now + windowMs };
      attempts.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const secs = Math.ceil((entry.resetAt - now) / 1000);
      return res.status(429).json({ error: `Too many attempts — try again in ${secs}s` });
    }
    next();
  };
}
