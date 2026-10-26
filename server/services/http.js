import { decryptSecret } from '../core/config.js';
import { joinUrl, fetchJson, httpFetch, safeJsonParse } from '../core/util.js';
import { signSubsonic } from './subsonic.js';

// Build the execution context handed to every connector call.
export function serviceCtx(serviceRow) {
  const apiKey = decryptSecret(serviceRow.api_key);
  const password = decryptSecret(serviceRow.password);
  const extra = safeJsonParse(serviceRow.extra, {}) || {};
  const base = String(serviceRow.url || '').replace(/\/+$/, '');
  const ctx = {
    id: serviceRow.id,
    type: serviceRow.type,
    name: serviceRow.name,
    base,
    apiKey,
    username: serviceRow.username || '',
    password,
    extra,
    headers: {},
    url: (path) => joinUrl(base, path || '/'),
    // JSON call with the service's own auth applied by connectors via opts
    api: async (path, opts = {}) => fetchJson(ctx.url(path), opts),
    text: async (path, opts = {}) => httpFetch(ctx.url(path), opts),
    basicHeader() {
      if (!ctx.username) return null;
      return 'Basic ' + Buffer.from(`${ctx.username}:${password}`).toString('base64');
    },
    bearerHeader() {
      return apiKey ? `Bearer ${apiKey}` : null;
    },
    query(params) {
      const sp = new URLSearchParams(params || {});
      return sp.toString();
    },
  };
  return ctx;
}

export const IMG_LIMIT = 8 * 1024 * 1024;
// Raster-only allowlist. Deliberately excludes SVG: the proxy is same-origin and
// a top-level SVG document can execute script in the HomeDeck origin.
const IMAGE_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
]);

// Audiobookshelf cover art needs a Bearer token. API-key setups already have
// one; username/password setups need a login token for the image proxy too.
const absImageTokens = new Map(); // service id -> { token, expiresAt }

async function absImageToken(ctx) {
  if (ctx.apiKey) return ctx.apiKey;
  const cached = absImageTokens.get(ctx.id);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const res = await ctx.api('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ctx.username, password: ctx.password }),
    timeoutMs: 12000,
  });
  const token = res.json?.user?.token;
  if (!token) throw new Error('Audiobookshelf login returned no token');
  absImageTokens.set(ctx.id, { token, expiresAt: Date.now() + 60 * 60 * 1000 });
  return token;
}

// Download a binary asset (image) from a service with its auth headers.
// NOTE: this must use arrayBuffer(), NOT res.text() — decoding binary through
// a UTF-8 string corrupts JPEG/PNG bytes (introduces U+FFFD replacement chars).
export async function fetchImage(serviceRow, path) {
  const ctx = serviceCtx(serviceRow);
  const headers = { ...(ctx.headers || {}) };
  applyImageAuth(serviceRow.type, ctx, headers);
  if (serviceRow.type === 'audiobookshelf' && !ctx.apiKey) {
    try {
      const token = await absImageToken(ctx);
      if (token) headers.Authorization = `Bearer ${token}`;
    } catch { /* the request below will surface the actual error */ }
  }
  let res;
  try {
    // Subsonic/Navidrome cover art needs the signed query parameters; the
    // credentials stay server-side (the browser only sees /api/proxy/...).
    const target = serviceRow.type === 'navidrome'
      ? ctx.url(signSubsonic(path, ctx.username, ctx.password))
      : ctx.url(path);
    res = await fetch(target, { headers, redirect: 'follow', signal: AbortSignal.timeout(12000) });
  } catch (err) {
    const cause = err?.cause?.code || err?.code || '';
    throw new Error('Could not fetch image: ' + (cause || err?.message || 'unknown error'));
  }
  if (!res.ok) throw new Error(`Upstream returned HTTP ${res.status}`);
  const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_TYPES.has(type)) throw new Error('Unsupported image type');
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > IMG_LIMIT) throw new Error('Image too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > IMG_LIMIT) throw new Error('Image too large');
  return { buf, type };
}

function applyImageAuth(type, ctx, headers) {
  switch (type) {
    case 'sonarr':
    case 'radarr':
    case 'lidarr':
      // *arr MediaCover files are served from the app root and need the API key
      // when the instance has authentication enabled.
      if (ctx.apiKey) headers['X-Api-Key'] = ctx.apiKey;
      break;
    case 'jellyfin':
      if (ctx.apiKey) {
        headers['X-Emby-Token'] = ctx.apiKey;
        headers['Authorization'] = `MediaBrowser Token="${ctx.apiKey}"`;
      }
      break;
    case 'audiobookshelf':
      if (ctx.apiKey) headers['Authorization'] = `Bearer ${ctx.apiKey}`;
      break;
    case 'immich':
      if (ctx.apiKey) headers['x-api-key'] = ctx.apiKey;
      break;
    case 'komga': {
      const basic = ctx.basicHeader();
      if (basic) headers['Authorization'] = basic;
      if (ctx.apiKey) headers['X-API-Key'] = ctx.apiKey;
      break;
    }
    case 'nextcloud': {
      const basic = ctx.basicHeader();
      if (basic) headers['Authorization'] = basic;
      break;
    }
    default:
      break;
  }
}
