import crypto from 'node:crypto';
import { getSetting } from '../core/db.js';
import { config } from '../core/config.js';
import { joinUrl, fetchJson, genToken, timingSafeEqualStr } from '../core/util.js';

// Generic OAuth2 / OIDC authorization-code flow, configured by the admin.

export function ssoConfig() {
  const sso = getSetting('sso', {});
  const enabled = !!sso.enabled && !!sso.clientId && !!sso.authUrl && !!sso.tokenUrl;
  return {
    enabled,
    label: sso.label || 'Single Sign-On',
    clientId: sso.clientId || '',
    clientSecret: sso.clientSecret || '',
    authUrl: sso.authUrl || '',
    tokenUrl: sso.tokenUrl || '',
    userInfoUrl: sso.userInfoUrl || '',
    scopes: sso.scopes || 'openid profile email',
    usernameField: sso.usernameField || 'preferred_username',
    autoCreate: sso.autoCreate !== false,
    adminGroupClaim: sso.adminGroupClaim || '',
    adminGroupValue: sso.adminGroupValue || '',
  };
}

const pendingStates = new Map(); // state -> {redirect, verifier, expiresAt}
const STATE_TTL = 10 * 60 * 1000;
const STATE_COOKIE = 'hd_oauth_state';

function readStateCookie(req) {
  const header = req.headers?.cookie;
  if (!header) return '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== STATE_COOKIE) continue;
    const raw = part.slice(idx + 1).trim();
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  return '';
}

function appendSetCookie(res, value) {
  const prev = res.getHeader('Set-Cookie');
  const arr = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  arr.push(value);
  res.setHeader('Set-Cookie', arr);
}

// The state is bound to the initiating browser via an HttpOnly cookie and carries
// a PKCE verifier, so a forged or replayed callback can't complete a login.
export function createOAuthState(res, redirect) {
  for (const [k, v] of pendingStates) if (v.expiresAt < Date.now()) pendingStates.delete(k);
  const state = genToken(24);
  const verifier = genToken(32);
  const codeChallenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  pendingStates.set(state, { redirect, verifier, expiresAt: Date.now() + STATE_TTL });
  const cookie = [`${STATE_COOKIE}=${state}`, 'Path=/api/oauth', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(STATE_TTL / 1000)}`];
  if (config.secureCookies) cookie.push('Secure');
  appendSetCookie(res, cookie.join('; '));
  return { state, codeChallenge };
}

export function clearOAuthState(res) {
  const cookie = [`${STATE_COOKIE}=`, 'Path=/api/oauth', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (config.secureCookies) cookie.push('Secure');
  appendSetCookie(res, cookie.join('; '));
}

export function consumeOAuthState(req) {
  const state = String(req.query?.state || '');
  const cookie = readStateCookie(req);
  if (!state || !cookie || !timingSafeEqualStr(state, cookie)) return null;
  const entry = pendingStates.get(state);
  if (!entry) return null;
  pendingStates.delete(state);
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

export function buildAuthorizeUrl(cfg, state, redirectUri, codeChallenge) {
  const u = new URL(cfg.authUrl);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', cfg.scopes);
  u.searchParams.set('state', state);
  if (codeChallenge) {
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
  }
  return u.toString();
}

function pickUsername(profile, cfg) {
  const candidates = [cfg.usernameField, 'preferred_username', 'username', 'email', 'sub', 'name'];
  for (const key of candidates) {
    const v = profile?.[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function parseIdTokenPayload(idToken) {
  try {
    const payloadB64 = idToken.split('.')[1];
    const json = Buffer.from(payloadB64, 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function exchangeCode(cfg, code, redirectUri, codeVerifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  if (codeVerifier) body.set('code_verifier', codeVerifier);
  const res = await fetchJson(cfg.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: body.toString(),
    timeoutMs: 15000,
  });
  const tokens = res.json;
  if (!tokens || (!tokens.access_token && !tokens.id_token)) {
    throw new Error('SSO token endpoint returned no access token');
  }
  return tokens;
}

export async function fetchProfile(cfg, tokens) {
  if (cfg.userInfoUrl) {
    const res = await fetchJson(cfg.userInfoUrl, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      timeoutMs: 15000,
    });
    if (res.json) return res.json;
  }
  if (tokens.id_token) {
    const payload = parseIdTokenPayload(tokens.id_token);
    if (payload) return payload;
  }
  throw new Error('Could not read user profile from SSO provider');
}

export async function resolveSsoUser(tokens, profile, { createUser, findUserByName, findUserByOauth, linkOauth }) {
  const cfg = ssoConfig();
  const username = pickUsername(profile, cfg);
  if (!username) throw new Error('SSO provider profile contained no usable username field');

  const provider = 'sso';
  const sub = String(profile.sub ?? profile.id ?? username);

  // Match on the stable (provider, sub) identity first — never on a bare username.
  let user = findUserByOauth ? await findUserByOauth(provider, sub) : null;

  // A username match is only safe for an account that is not protected by a local
  // password and has no conflicting SSO identity; otherwise a user who can choose
  // their IdP username could take over an existing dashboard account.
  if (!user) {
    const byName = await findUserByName(username);
    if (byName) {
      if (byName.oauth_sub && byName.oauth_sub !== sub) {
        throw new Error(`The username "${username}" is already linked to a different SSO account`);
      }
      if (byName.pass_hash) {
        throw new Error(`The dashboard user "${username}" already has a password — ask an administrator to link it to SSO`);
      }
      user = byName;
    }
  }

  if (!user && cfg.autoCreate) {
    user = await createUser({
      username,
      displayName: String(profile.name || profile.given_name || username),
      oauthProvider: provider,
      oauthSub: sub,
    });
  }
  if (!user) throw new Error(`No dashboard user named "${username}" exists and auto-provisioning is disabled`);

  if (!user.oauth_sub) linkOauth(user.id, provider, sub);

  // Optional claim-based admin promotion
  if (cfg.adminGroupClaim && cfg.adminGroupValue) {
    const claim = profile[cfg.adminGroupClaim];
    const has = Array.isArray(claim) ? claim.includes(cfg.adminGroupValue) : claim === cfg.adminGroupValue;
    if (has && user.role !== 'admin') {
      user = { ...user, role: 'admin' };
    }
  }
  return user;
}

export function oauthRedirectUri(req) {
  // Prefer an explicit, admin-set public base URL (PUBLIC_URL) so a spoofed Host
  // header can never influence the redirect_uri. Forwarded proto/host are only
  // honored behind a trusted proxy (TRUST_PROXY=1); otherwise use the request host.
  if (config.publicUrl) return joinUrl(config.publicUrl, '/api/oauth/callback');
  const proto = (config.trustProxy ? req.headers['x-forwarded-proto']?.split(',')[0]?.trim() : '') || req.protocol || 'http';
  const host = (config.trustProxy ? req.headers['x-forwarded-host']?.split(',')[0]?.trim() : '') || req.get('host');
  return joinUrl(`${proto}://${host}`, '/api/oauth/callback');
}
