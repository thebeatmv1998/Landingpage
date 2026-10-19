import crypto from 'node:crypto';

export function genToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function randomInt(max) {
  return crypto.randomInt(0, max);
}

export function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) {
    // still burn equivalent time to avoid length oracle
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function joinUrl(base, path) {
  if (!path) return base || '';
  return String(base || '').replace(/\/+$/, '') + (String(path).startsWith('/') ? String(path) : '/' + String(path));
}

export function nowMs() {
  return Date.now();
}

export function deepMerge(target, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? target : patch;
  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Plain fetch with timeout; returns {status, headers, text, json} or throws Error with friendly message
export async function httpFetch(url, { method = 'GET', headers = {}, body, timeoutMs = 10000 } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const cause = err?.cause?.code || err?.code || '';
    if (err?.name === 'TimeoutError' || cause === 'UND_ERR_CONNECT_TIMEOUT') throw new Error('Connection timed out');
    if (cause === 'ECONNREFUSED') throw new Error('Connection refused');
    if (cause === 'ENOTFOUND') throw new Error('Host not found');
    if (cause === 'ECONNRESET') throw new Error('Connection reset');
    if (cause && String(cause).startsWith('CERT')) throw new Error('TLS certificate error: ' + cause);
    throw new Error('Could not connect: ' + (cause || err?.message || 'unknown error'));
  }
  const text = await res.text();
  return { status: res.status, ok: res.ok, headers: res.headers, text, url: res.url };
}

export async function fetchJson(url, opts = {}) {
  const res = await httpFetch(url, opts);
  if (!res.ok) {
    const head = res.text.slice(0, 120).replace(/\s+/g, ' ');
    throw new Error(`HTTP ${res.status}${head ? ': ' + head : ' (no response body)'}`);
  }
  let json;
  try {
    json = JSON.parse(res.text);
  } catch {
    const head = res.text.slice(0, 120).replace(/\s+/g, ' ');
    throw new Error(`Expected JSON but got HTTP ${res.status} (${head || 'empty response'}) — check URL and API key`);
  }
  return { ...res, json };
}

export function fmtBytes(bytes, digits = 1) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

// Decimal (SI) variant — storage UIs/tools (Unraid, drive vendors) use 1000-based units.
export function fmtBytesSI(bytes, digits = 1) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function safeJsonParse(str, fallback = null) {
  if (typeof str !== 'string' || !str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

// Poll intervals are stored in ms. Coerce to a finite integer within bounds so a
// bad value can never become a non-numeric string that defeats the scheduler's
// throttle (which would otherwise poll the upstream every second).
export function clampPollMs(v, min = 5000, max = 24 * 60 * 60 * 1000) {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, min), max);
}

export function pct(part, total) {
  const t = Number(total), p = Number(part);
  if (!Number.isFinite(t) || !Number.isFinite(p) || t <= 0) return 0;
  return clamp(Math.round((p / t) * 100), 0, 100);
}
