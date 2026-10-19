// Per-service local/public URL failover.
//
// A service can have a local URL (e.g. http://192.168.1.10:8989) and a public
// fallback URL (e.g. https://sonarr.example.com). When the dashboard is opened
// from outside the LAN, the browser cannot reach the local address. We probe it
// with a no-cors request and automatically link to the public URL instead.
//
// The result is cached in localStorage so the next page load already links to
// the working address; a background probe refreshes it.

const CACHE_KEY = 'hd-reach-v1';
const FRESH_MS = 2 * 60 * 1000;      // trust a probe for two minutes
const PROBE_TIMEOUT_MS = 2500;       // covers slow LAN devices when remote

const reach = new Map();             // service id -> { local, at, url, fallback }
const inFlight = new Map();          // service id -> Promise<boolean>
const listeners = new Set();
let cacheReady = false;

function ensureCache() {
  if (cacheReady) return;
  cacheReady = true;
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    for (const [id, v] of Object.entries(raw)) {
      if (!v || typeof v.local !== 'boolean' || !Number.isFinite(v.at)) continue;
      reach.set(Number(id), v);
    }
  } catch { /* private mode / corrupt cache */ }
}

function persist() {
  try {
    if (typeof localStorage === 'undefined') return;
    const obj = {};
    for (const [id, v] of reach) obj[id] = v;
    localStorage.setItem(CACHE_KEY, JSON.stringify(obj));
  } catch { /* ignore quota / private mode */ }
}

/** Pick the URL for a service, given whether the local address is reachable. */
export function pickServiceUrl(svc, localReachable = true) {
  if (!svc) return '';
  const local = svc.url || '';
  const external = svc.fallbackUrl || '';
  if (!external) return local;
  if (svc.autoSwitch === false) return local || external;
  return localReachable ? (local || external) : (external || local);
}

function cacheEntry(svc) {
  ensureCache();
  const entry = reach.get(Number(svc?.id));
  if (!entry) return null;
  // Drop cached results for a service whose addresses changed.
  if (entry.url !== (svc.url || '') || entry.fallback !== (svc.fallbackUrl || '')) return null;
  return entry;
}

/** True when the service is currently linked through its public fallback URL. */
export function isExternal(svc) {
  if (!svc?.fallbackUrl || svc.autoSwitch === false) return false;
  return cacheEntry(svc)?.local === false;
}

/** Effective URL for links, menus and copy actions. */
export function serviceUrl(svc) {
  return pickServiceUrl(svc, !isExternal(svc));
}

/** Cached probe state (or null when unknown / stale for this configuration). */
export function fallbackState(svc) {
  return cacheEntry(svc);
}

export function onReachability(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(svc) {
  for (const fn of listeners) {
    try { fn(svc); } catch { /* a broken listener must not stop the others */ }
  }
}

async function check(svc, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(500, timeout));
  try {
    await fetch(svc.url, {
      mode: 'no-cors',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
      signal: ctrl.signal,
    });
    return true; // opaque response: the host answered
  } catch {
    return false; // DNS failure, refused, TLS error, mixed content, timeout
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe one service. Resolves to true (local reachable), false (use fallback)
 * or null (no fallback / auto-switch disabled).
 */
export async function probeService(svc, { timeout = PROBE_TIMEOUT_MS, force = false } = {}) {
  if (!svc || !svc.id || !svc.url || !svc.fallbackUrl || svc.autoSwitch === false) return null;
  ensureCache();
  const key = Number(svc.id);
  const prev = cacheEntry(svc);
  if (!force && prev && Date.now() - prev.at < FRESH_MS) return prev.local;
  if (inFlight.has(key)) return inFlight.get(key);

  const p = (async () => {
    const local = await check(svc, timeout);
    inFlight.delete(key);
    const next = { local, at: Date.now(), url: svc.url, fallback: svc.fallbackUrl };
    reach.set(key, next);
    persist();
    if (!prev || prev.local !== local) notify(svc);
    return local;
  })();
  inFlight.set(key, p);
  return p;
}

/** Probe every service that has a fallback configured (cached results are skipped). */
export function probeServices(services, opts) {
  const list = [...(services || [])].filter((s) => s && s.id && s.url && s.fallbackUrl && s.autoSwitch !== false);
  return Promise.allSettled(list.map((s) => probeService(s, opts)));
}

/** Forget cached results, e.g. after a network change. */
export function resetReachability() {
  reach.clear();
  persist();
  for (const fn of listeners) { try { fn(null); } catch { /* ignore */ } }
}
