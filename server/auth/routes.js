import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import QRCode from 'qrcode';
import { stmts, db, getUserByName, getUserById } from '../core/db.js';
import { config, secretKey, rootDir } from '../core/config.js';
import { nowMs } from '../core/util.js';
import { hashPassword, verifyPassword, passwordIssues } from './passwords.js';
import { generateTotpSecret, verifyTotp, otpauthUri } from './totp.js';
import {
  createSession, setSessionCookie, clearSessionCookie, destroySession,
  destroyUserSessions, destroyUserDevices, listUserSessions, revokeUserSession, requireAuth, requireAdmin, rateLimit,
} from './sessions.js';
import { audit } from '../core/audit.js';
import { generateRecoveryCodes, consumeRecoveryCode, remainingRecoveryCodes, clearRecoveryCodes } from './recovery.js';
import { ssoConfig, createOAuthState, clearOAuthState, consumeOAuthState, buildAuthorizeUrl, exchangeCode, fetchProfile, resolveSsoUser, oauthRedirectUri } from './oauth.js';

export const authRouter = express.Router();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name || u.username,
    role: u.role,
    groupName: u.group_name || '',
    totpEnabled: !!u.totp_enabled,
    hasPassword: !!u.pass_hash,
    prefs: safePrefs(u),
    createdAt: u.created_at,
  };
}
function safePrefs(u) {
  try { return JSON.parse(u.prefs || '{}'); } catch { return {}; }
}
function usernameIssues(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_.\-@]{2,40}$/.test(name)) {
    return 'Username must be 2–40 chars: letters, digits, . _ - @';
  }
  return null;
}

// Short-lived signed ticket for the "password OK, now give me TOTP" step
function signTicket(userId, ttlMs = 5 * 60 * 1000) {
  const exp = nowMs() + ttlMs;
  const payload = `${userId}.${exp}`;
  const sig = crypto.createHmac('sha256', secretKey).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifyTicket(ticket) {
  const parts = String(ticket || '').split('.');
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  const expected = crypto.createHmac('sha256', secretKey).update(`${uid}.${exp}`).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(exp) < nowMs()) return null;
  return Number(uid);
}

// ---------------------------------------------------------------------------
// meta (public)
// ---------------------------------------------------------------------------
authRouter.get('/meta', (req, res) => {
  const usersCount = stmts.usersCount.get().c;
  const sso = ssoConfig();
  const apkPath = path.join(rootDir, 'public', 'download', 'homedeck.apk');
  let apkAvailable = false;
  try { apkAvailable = fs.existsSync(apkPath); } catch { /* ignore */ }
  res.json({
    needsSetup: usersCount === 0,
    version: config.version,
    publicUrl: config.publicUrl || '',
    androidApk: { available: apkAvailable, url: '/download/homedeck.apk', version: '1.1.2' },
    sso: sso.enabled ? { enabled: true, label: sso.label } : { enabled: false, label: '' },
  });
});

// ---------------------------------------------------------------------------
// setup (first run): create the first admin
// ---------------------------------------------------------------------------
authRouter.post('/setup', rateLimit('setup', 10, 10 * 60 * 1000), async (req, res) => {
  if (stmts.usersCount.get().c > 0) return res.status(403).json({ error: 'Setup already completed' });
  const { username, password, displayName } = req.body || {};
  const uErr = usernameIssues(username);
  if (uErr) return res.status(400).json({ error: uErr });
  const pErr = passwordIssues(password);
  if (pErr) return res.status(400).json({ error: pErr });
  if (getUserByName(username)) return res.status(400).json({ error: 'Username already taken' });
  const info = stmts.userInsert.run({
    username: String(username).trim(),
    pass_hash: await hashPassword(password),
    role: 'admin',
    group_name: '',
    display_name: String(displayName || username).slice(0, 60),
    created_at: nowMs(),
  });
  const user = getUserById(Number(info.lastInsertRowid));
  const token = createSession(user.id, req.headers['user-agent'], true);
  setSessionCookie(res, token, config.sessionTtlRememberHours * 3600);
  audit(req, 'setup', `initial admin ${user.username}`, user);
  res.json({ user: publicUser(user) });
});

// ---------------------------------------------------------------------------
// login / logout
// ---------------------------------------------------------------------------
authRouter.post('/login', rateLimit('login-ip', 30, 10 * 60 * 1000), rateLimit('login-user', 10, 10 * 60 * 1000), async (req, res) => {
  const { username, password, remember } = req.body || {};
  const user = getUserByName(username);
  const ok = user ? await verifyPassword(password || '', user.pass_hash) : false;
  if (!user || !ok) {
    // burn a little time so timing doesn't reveal which factor failed
    await verifyPassword(password || '', 'scrypt:16384:8:1:AAAAAAAAAAAAAAAAAAAAAA==:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==');
    audit(req, 'login_failed', String(username || '').slice(0, 60));
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  if (user.totp_enabled) {
    return res.json({ totpRequired: true, ticket: signTicket(user.id) });
  }
  const token = createSession(user.id, req.headers['user-agent'], !!remember);
  setSessionCookie(res, token, (remember ? config.sessionTtlRememberHours : config.sessionTtlHours) * 3600);
  audit(req, 'login', remember ? 'remember me' : '', user);
  res.json({ user: publicUser(user) });
});

authRouter.post('/login/totp', rateLimit('totp', 15, 10 * 60 * 1000), (req, res) => {
  const { ticket, code } = req.body || {};
  const userId = verifyTicket(ticket);
  if (!userId) return res.status(401).json({ error: 'Login session expired — start again' });
  const user = getUserById(userId);
  if (!user || !user.totp_enabled) return res.status(401).json({ error: 'Invalid login state' });
  if (!verifyTotp(user.totp_secret, code)) return res.status(401).json({ error: 'Invalid verification code' });
  const token = createSession(user.id, req.headers['user-agent'], true);
  setSessionCookie(res, token, config.sessionTtlRememberHours * 3600);
  audit(req, 'login_totp', '', user);
  res.json({ user: publicUser(user), recoveryRemaining: remainingRecoveryCodes(user.id) });
});

// Fallback when the authenticator is unavailable: single-use recovery code.
authRouter.post('/login/recovery', rateLimit('recovery', 15, 10 * 60 * 1000), (req, res) => {
  const { ticket, code } = req.body || {};
  const userId = verifyTicket(ticket);
  if (!userId) return res.status(401).json({ error: 'Login session expired — start again' });
  const user = getUserById(userId);
  if (!user || !user.totp_enabled) return res.status(401).json({ error: 'Invalid login state' });
  if (!consumeRecoveryCode(user.id, code)) {
    audit(req, 'login_recovery_failed', '', user);
    return res.status(401).json({ error: 'Invalid or already used recovery code' });
  }
  const token = createSession(user.id, req.headers['user-agent'], true);
  setSessionCookie(res, token, config.sessionTtlRememberHours * 3600);
  audit(req, 'login_recovery', '', user);
  res.json({ user: publicUser(user), recoveryRemaining: remainingRecoveryCodes(user.id) });
});

authRouter.post('/logout', (req, res) => {
  destroySession(req.sessionToken);
  clearSessionCookie(res);
  audit(req, 'logout');
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// self-service
// ---------------------------------------------------------------------------
authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user), sso: ssoConfig().enabled });
});

authRouter.put('/me/prefs', requireAuth, (req, res) => {
  const patch = req.body || {};
  if (typeof patch !== 'object' || Array.isArray(patch)) return res.status(400).json({ error: 'Invalid prefs' });
  const merged = { ...safePrefs(req.user), ...patch };
  const json = JSON.stringify(merged);
  if (json.length > 200_000) return res.status(413).json({ error: 'Preferences too large' });
  stmts.userSetPrefs.run({ prefs: json, id: req.user.id });
  res.json({ prefs: merged });
});

authRouter.put('/me/profile', requireAuth, (req, res) => {
  const displayName = String(req.body?.displayName || '').trim().slice(0, 60);
  db.prepare('UPDATE users SET display_name = :dn WHERE id = :id').run({ dn: displayName, id: req.user.id });
  audit(req, 'profile_updated', displayName);
  res.json({ user: publicUser(getUserById(req.user.id)) });
});

authRouter.post('/me/password', requireAuth, rateLimit('pwchange', 10, 10 * 60 * 1000), async (req, res) => {
  const { current, next } = req.body || {};
  const pErr = passwordIssues(next);
  if (pErr) return res.status(400).json({ error: pErr });
  if (req.user.pass_hash && !(await verifyPassword(current || '', req.user.pass_hash))) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  stmts.userSetPass.run({ pass_hash: await hashPassword(next), id: req.user.id });
  destroyUserSessions(req.user.id, req.sessionToken);
  destroyUserDevices(req.user.id); // app tokens are long-lived; force re-pairing too
  audit(req, 'password_changed');
  res.json({ ok: true });
});

// --- TOTP self-service ---
authRouter.post('/me/totp/setup', requireAuth, async (req, res) => {
  if (req.user.pass_hash) {
    const ok = await verifyPassword(req.body?.password || '', req.user.pass_hash);
    if (!ok) return res.status(401).json({ error: 'Password is incorrect' });
  }
  const secret = generateTotpSecret();
  stmts.userSetTotp.run({ secret, enabled: 0, id: req.user.id });
  const uri = otpauthUri(secret, req.user.username);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240 });
  audit(req, 'totp_setup');
  res.json({ secret, otpauth: uri, qr });
});

authRouter.post('/me/totp/enable', requireAuth, (req, res) => {
  const code = req.body?.code;
  if (!req.user.totp_secret) return res.status(400).json({ error: 'Run setup first' });
  if (!verifyTotp(req.user.totp_secret, code)) return res.status(401).json({ error: 'Invalid code — check your authenticator' });
  stmts.userSetTotp.run({ secret: req.user.totp_secret, enabled: 1, id: req.user.id });
  const recoveryCodes = generateRecoveryCodes(req.user.id);
  audit(req, 'totp_enabled', `${recoveryCodes.length} recovery codes`);
  res.json({ ok: true, recoveryCodes });
});

authRouter.post('/me/totp/disable', requireAuth, async (req, res) => {
  if (req.user.pass_hash) {
    const ok = await verifyPassword(req.body?.password || '', req.user.pass_hash);
    if (!ok) return res.status(401).json({ error: 'Password is incorrect' });
  }
  if (req.user.totp_enabled && !verifyTotp(req.user.totp_secret, req.body?.code)) {
    return res.status(401).json({ error: 'Invalid verification code' });
  }
  stmts.userSetTotp.run({ secret: '', enabled: 0, id: req.user.id });
  clearRecoveryCodes(req.user.id);
  audit(req, 'totp_disabled');
  res.json({ ok: true });
});

// --- recovery codes ---
authRouter.get('/me/recovery-codes', requireAuth, (req, res) => {
  res.json({ remaining: remainingRecoveryCodes(req.user.id) });
});

authRouter.post('/me/recovery-codes', requireAuth, rateLimit('recovery-gen', 10, 10 * 60 * 1000), async (req, res) => {
  if (req.user.pass_hash) {
    const ok = await verifyPassword(req.body?.password || '', req.user.pass_hash);
    if (!ok) return res.status(401).json({ error: 'Password is incorrect' });
  }
  if (!req.user.totp_enabled) return res.status(400).json({ error: 'Enable two-factor authentication first' });
  const codes = generateRecoveryCodes(req.user.id);
  audit(req, 'recovery_codes_generated', `${codes.length} codes`);
  res.json({ codes, remaining: codes.length });
});

// --- session management ---
authRouter.get('/me/sessions', requireAuth, (req, res) => {
  res.json({ sessions: listUserSessions(req.user.id, req.sessionToken) });
});

authRouter.delete('/me/sessions/:id', requireAuth, (req, res) => {
  if (!revokeUserSession(req.user.id, req.params.id)) {
    return res.status(404).json({ error: 'Session not found' });
  }
  audit(req, 'session_revoked', req.params.id);
  res.json({ ok: true });
});

authRouter.post('/me/sessions/revoke-others', requireAuth, (req, res) => {
  destroyUserSessions(req.user.id, req.sessionToken);
  audit(req, 'sessions_revoked', 'all other sessions');
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// admin: user management
// ---------------------------------------------------------------------------
authRouter.get('/users', requireAdmin, (req, res) => {
  const rows = stmts.usersAll.all();
  res.json({ users: rows.map(publicUser) });
});

authRouter.post('/users', requireAdmin, async (req, res) => {
  const { username, password, role, displayName, groupName } = req.body || {};
  const uErr = usernameIssues(username);
  if (uErr) return res.status(400).json({ error: uErr });
  const pErr = passwordIssues(password);
  if (pErr) return res.status(400).json({ error: pErr });
  if (getUserByName(username)) return res.status(400).json({ error: 'Username already taken' });
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Role must be admin or user' });
  const info = stmts.userInsert.run({
    username: String(username).trim(),
    pass_hash: await hashPassword(password),
    role: role === 'admin' ? 'admin' : 'user',
    group_name: String(groupName || '').slice(0, 40),
    display_name: String(displayName || username).slice(0, 60),
    created_at: nowMs(),
  });
  audit(req, 'user_created', `${username} (${role})`);
  res.json({ user: publicUser(getUserById(Number(info.lastInsertRowid))) });
});

authRouter.put('/users/:id', requireAdmin, (req, res) => {
  const target = getUserById(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'User not found' });
  const { role, displayName, groupName, username } = req.body || {};
  if (target.role === 'admin' && role === 'user' && stmts.usersCount.get().c > 0) {
    // ensure at least one admin remains
    const admins = stmts.usersAll.all().filter((u) => u.role === 'admin');
    if (admins.length === 1 && admins[0].id === target.id) {
      return res.status(400).json({ error: 'Cannot demote the last administrator' });
    }
  }
  if (username !== undefined) {
    const uErr = usernameIssues(username);
    if (uErr) return res.status(400).json({ error: uErr });
    const existing = getUserByName(username);
    if (existing && existing.id !== target.id) return res.status(400).json({ error: 'Username already taken' });
  }
  const newUsername = username !== undefined ? String(username).trim() : target.username;
  const newRole = role !== undefined ? (role === 'admin' ? 'admin' : 'user') : target.role;
  if (newUsername.toLowerCase() !== target.username.toLowerCase()) {
    // username changes are rare; invalidate their sessions
    destroyUserSessions(target.id);
    destroyUserDevices(target.id);
  }
  stmts.userUpdate.run({
    username: newUsername,
    role: newRole,
    group_name: groupName !== undefined ? String(groupName || '').slice(0, 40) : target.group_name,
    display_name: displayName !== undefined ? String(displayName || '').slice(0, 60) : target.display_name,
    id: target.id,
  });
  audit(req, 'user_updated', `${target.username} → ${newUsername} (${newRole})`);
  res.json({ user: publicUser(getUserById(target.id)) });
});

authRouter.post('/users/:id/password', requireAdmin, async (req, res) => {
  const target = getUserById(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'User not found' });
  const pErr = passwordIssues(req.body?.password);
  if (pErr) return res.status(400).json({ error: pErr });
  stmts.userSetPass.run({ pass_hash: await hashPassword(req.body.password), id: target.id });
  destroyUserSessions(target.id);
  destroyUserDevices(target.id);
  audit(req, 'user_password_reset', target.username);
  res.json({ ok: true });
});

authRouter.post('/users/:id/totp-reset', requireAdmin, (req, res) => {
  const target = getUserById(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'User not found' });
  stmts.userSetTotp.run({ secret: '', enabled: 0, id: target.id });
  clearRecoveryCodes(target.id);
  audit(req, 'user_totp_reset', target.username);
  res.json({ ok: true });
});

authRouter.delete('/users/:id', requireAdmin, (req, res) => {
  const target = getUserById(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot delete yourself' });
  const admins = stmts.usersAll.all().filter((u) => u.role === 'admin');
  if (target.role === 'admin' && admins.length === 1) {
    return res.status(400).json({ error: 'Cannot delete the last administrator' });
  }
  stmts.userDelete.run({ id: target.id });
  audit(req, 'user_deleted', target.username);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// OAuth2 / OIDC
// ---------------------------------------------------------------------------
authRouter.get('/oauth/start', (req, res) => {
  const cfg = ssoConfig();
  if (!cfg.enabled) return res.status(404).send('SSO is not enabled');
  const { state, codeChallenge } = createOAuthState(res, req.query.redirect || '/');
  const url = buildAuthorizeUrl(cfg, state, oauthRedirectUri(req), codeChallenge);
  res.redirect(url);
});

authRouter.get('/oauth/callback', async (req, res) => {
  const cfg = ssoConfig();
  const fail = (msg) => res.redirect(`/login?ssoError=${encodeURIComponent(msg)}`);
  if (!cfg.enabled) return res.status(404).send('SSO is not enabled');
  try {
    const { code } = req.query;
    const entry = consumeOAuthState(req);
    clearOAuthState(res);
    if (!code || !entry) return fail('Invalid or expired SSO state');
    const tokens = await exchangeCode(cfg, String(code), oauthRedirectUri(req), entry.verifier);
    const profile = await fetchProfile(cfg, tokens);
    const user = await resolveSsoUser(tokens, profile, {
      createUser: ({ username, displayName, oauthProvider, oauthSub }) => {
        const info = stmts.userInsert.run({
          username,
          pass_hash: '',
          role: 'user',
          group_name: '',
          display_name: displayName,
          created_at: nowMs(),
        });
        const u = getUserById(Number(info.lastInsertRowid));
        stmts.userSetOauth.run({ provider: oauthProvider, sub: oauthSub, id: u.id });
        return u;
      },
      findUserByName: getUserByName,
      findUserByOauth: (provider, sub) => stmts.userByOauth.get(provider, sub) || null,
      linkOauth: (id, provider, sub) => stmts.userSetOauth.run({ provider, sub, id }),
    });
    // persist optional admin promotion from claim
    const dbUser = getUserById(user.id);
    if (user.role === 'admin' && dbUser.role !== 'admin') {
      db.prepare("UPDATE users SET role='admin' WHERE id=?").run(user.id);
    }
    const token = createSession(user.id, req.headers['user-agent'] + ' (SSO)', true);
    setSessionCookie(res, token, config.sessionTtlRememberHours * 3600);
    audit(req, 'login_oauth', ssoConfig().label || 'SSO', dbUser);
    res.redirect('/');
  } catch (err) {
    clearOAuthState(res);
    fail(err?.message || 'SSO login failed');
  }
});
