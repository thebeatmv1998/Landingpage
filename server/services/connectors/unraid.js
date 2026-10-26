// Unraid — server stats via the Unraid 7 GraphQL API (/graphql, x-api-key header).
import { bundledIconFor } from '../registry.js';
// All field shapes verified against the official generated schema (unraid/api repo):
//   info.os.uptime           — BOOT TIME as ISO string (not seconds!)
//   array.capacity.kilobytes — capacity in KILOBYTES (.disks is the disk COUNT!)
//   array.disks / array.caches — data disks and cache pools (both ArrayDisk)
//   docker.containers        — container states as ContainerState enum (RUNNING/PAUSED/EXITED)
//   metrics.cpu.percentTotal, metrics.memory.{total used available} — live utilization
// Strategy: one combined query (1 request); if the server rejects any field
// (older/newer API version), fall back to independent probes per part.
//
// Setup on Unraid: Settings → Management Access → API Keys → create key.
// GraphQL sandbox must be enabled: Settings → Management Access → Developer Options,
// or console: `unraid-api developer --sandbox true`.

async function gql(ctx, query, timeoutMs = 15000) {
  const res = await ctx.api('/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.apiKey },
    body: JSON.stringify({ query }),
    timeoutMs,
  });
  const j = res.json;
  if (j?.errors?.length) throw new Error(j.errors[0]?.message || 'GraphQL error');
  if (!j?.data) throw new Error('GraphQL returned no data');
  return j.data;
}

async function probe(ctx, query) {
  try { return await gql(ctx, query); } catch { return null; }
}

const DISK_FIELDS = 'name size status temp fsSize fsFree fsUsed';
const DISK_FIELDS_BASIC = 'name size status temp';

// Docker containers: webUiUrl is Unraid's resolved template link; lanIpPorts and
// ports are fallbacks for templates that only define placeholders.
const CONTAINER_FIELDS = 'id names state image status webUiUrl iconUrl lanIpPorts isUpdateAvailable ports { privatePort publicPort type ip }';
const CONTAINER_FIELDS_BASIC = 'names state';

const Q_COMBINED = `query {
  info { os { platform distro release uptime } cpu { manufacturer brand cores threads } }
  array {
    state
    capacity { kilobytes { free used total } }
    parityCheckStatus { status progress running }
    disks { ${DISK_FIELDS} }
    caches { ${DISK_FIELDS} }
  }
  docker { containers { ${CONTAINER_FIELDS} } }
  metrics { cpu { percentTotal } memory { total used available } }
}`;

const Q_INFO = `query {
  info { os { platform distro release uptime } cpu { manufacturer brand cores threads } }
}`;
const Q_ARRAY = `query {
  array {
    state
    capacity { kilobytes { free used total } }
    parityCheckStatus { status progress running }
    disks { ${DISK_FIELDS} }
    caches { ${DISK_FIELDS} }
  }
}`;
// Older API builds may not expose the filesystem fields (fsSize/fsFree/fsUsed yet).
const Q_ARRAY_BASIC = `query {
  array {
    state
    capacity { kilobytes { free used total } }
    disks { ${DISK_FIELDS_BASIC} }
    caches { ${DISK_FIELDS_BASIC} }
  }
}`;
const Q_CONTAINERS = `query {
  docker { containers { ${CONTAINER_FIELDS} } }
}`;
const Q_CONTAINERS_BASIC = `query {
  docker { containers { ${CONTAINER_FIELDS_BASIC} } }
}`;
const Q_METRICS = `query {
  metrics { cpu { percentTotal } memory { total used available } }
}`;

function fmtUptime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// info.os.uptime is the boot time as an ISO string; tolerate seconds too
function parseUptime(uptime) {
  if (uptime == null || uptime === '') return null;
  const asNum = Number(uptime);
  if (Number.isFinite(asNum) && asNum > 0) {
    return fmtUptime(asNum > 1e11 ? asNum / 1000 : asNum); // ms or seconds
  }
  const bootMs = Date.parse(String(uptime));
  if (Number.isFinite(bootMs) && bootMs > 0) {
    return fmtUptime((Date.now() - bootMs) / 1000);
  }
  return String(uptime).slice(0, 40); // unknown format — show raw
}

// Unraid reports disk size and array capacity in KILOBYTES, and its own UI uses
// decimal units (1 KB = 1000 B, 1 TB = 10^12 B) — so a 16 TB disk reads "16.0 TB",
// not the 14.6 TiB a 1024-based formatter would produce.
const KB = 1000;
const GIGA = 1e9; // decimal GB in bytes

function fmtSI(bytes) {
  const b = Number(bytes);
  if (!Number.isFinite(b) || b <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = b, i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}
const fmtKB = (kb) => fmtSI(Number(kb) * KB);   // kilobytes → "16.0 TB"
const fmtGB = (gb) => fmtSI(Number(gb) * GIGA); // decimal GB → "16.0 TB"
// kilobytes → decimal gigabytes (the charts.disks contract)
const kbToGB = (kb) => {
  const n = Number(kb);
  return Number.isFinite(n) && n > 0 ? (n * KB) / GIGA : null;
};

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function diskStateDot(status) {
  const s = String(status || '').toUpperCase();
  if (/INVALID|ERROR|DISABLE/.test(s)) return 'bad';
  if (/NP|STANDBY|NEW|NOT_PRESENT/.test(s)) return 'warn';
  return 'ok'; // DISK_OK, DISK_NVME, etc.
}

// Unraid templates store either an absolute icon URL or a path on the Unraid host.
function resolveIcon(url, base) {
  const u = String(url || '').trim();
  if (!u) return '';
  if (/^(https?:|data:image\/)/i.test(u)) return u;
  // Templates sometimes store a path on the Unraid host (e.g. /mnt/user/...).
  // That is not reachable over HTTP; return empty so the bundled icon wins.
  if (/^\/(mnt|boot|usr|etc|var|root|home)\//i.test(u)) return '';
  try { return new URL(u, base).toString(); } catch { return ''; }
}

// Resolve a container's WebUI link. Unraid usually returns a ready URL in
// `webUiUrl` (resolved from the container template); otherwise fall back to
// `lanIpPorts` or the first published TCP port on the Unraid host.
function resolveWebUi(c, host) {
  const fill = (raw) => {
    let u = String(raw || '').trim();
    if (!u) return '';
    if (/\[IP\]/i.test(u)) u = u.replace(/\[IP\]/gi, host || '');
    u = u.replace(/\[PORT:(\d+)\]/gi, (m, priv) => {
      const ports = Array.isArray(c?.ports) ? c.ports : [];
      const match = ports.find((p) => p && String(p.privatePort) === String(priv) && p.publicPort);
      return match ? String(match.publicPort) : priv;
    });
    return u;
  };
  const candidates = [];
  if (typeof c?.webUiUrl === 'string' && c.webUiUrl.trim()) candidates.push(c.webUiUrl);
  if (Array.isArray(c?.lanIpPorts)) {
    for (const v of c.lanIpPorts) {
      if (!v) continue;
      candidates.push(/^https?:\/\//i.test(v) ? v : `http://${v}`);
    }
  }
  for (const raw of candidates) {
    const u = fill(raw);
    if (!u) continue;
    try {
      const parsed = new URL(u);
      // Validate the protocol/host but return the template URL as-is (keeps paths).
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname) return u;
    } catch { /* try the next candidate */ }
  }
  const p = (Array.isArray(c?.ports) ? c.ports : [])
    .find((x) => x && x.publicPort && String(x.type || '').toUpperCase() !== 'UDP');
  return host && p ? `http://${host}:${p.publicPort}` : '';
}

export default {
  async test(ctx) {
    if (!ctx.base) return { ok: false, message: 'URL is required' };
    if (!ctx.apiKey) return { ok: false, message: 'API key is required (Unraid: Settings → Management Access → API Keys)' };
    try {
      const info = await gql(ctx, Q_INFO);
      const os = info?.info?.os || {};
      const threads = info?.info?.cpu?.threads;
      const [array, containers, metrics] = await Promise.all([
        probe(ctx, Q_ARRAY_BASIC), probe(ctx, Q_CONTAINERS), probe(ctx, Q_METRICS),
      ]);
      const marks = [`array ${array?.array ? '✓' : '✗'}`, `containers ${containers?.docker ? '✓' : '✗'}`, `live-metrics ${metrics?.metrics ? '✓' : '✗'}`];
      return {
        ok: true,
        message: `Connected to ${os.distro || 'Unraid'} ${os.release || ''}${threads ? ` (${threads} threads)` : ''} — ${marks.join(', ')}`,
      };
    } catch (err) {
      let msg = err.message;
      if (/401|403|Unauthorized|permission/i.test(msg)) {
        msg = 'API key rejected — create one under Settings → Management Access → API Keys';
      } else if (/404|Cannot (query|POST)/i.test(msg) || /no response body/.test(msg)) {
        msg = 'No Unraid API under this URL — is the GraphQL sandbox enabled? (Settings → Management Access → Developer Options, or `unraid-api developer --sandbox true`)';
      }
      return { ok: false, message: msg };
    }
  },

  // Container actions via the Unraid Docker mutations. Updates pull the new image
  // and recreate the container, so allow a long timeout.
  async action(ctx, { action, value } = {}) {
    if (action === 'update-all') {
      const data = await gql(ctx, 'mutation { docker { updateAllContainers { id names state } } }', 240_000);
      const list = Array.isArray(data?.docker?.updateAllContainers) ? data.docker.updateAllContainers : [];
      return { ok: true, message: `Updated ${list.length} container${list.length === 1 ? '' : 's'}` };
    }
    const fields = { update: 'updateContainer', start: 'start', stop: 'stop', restart: 'restart' };
    const field = fields[action];
    if (!field) return { ok: false, message: `Unknown action "${action}"` };
    if (!value) return { ok: false, message: 'Missing container id' };
    await gql(ctx, `mutation { docker { ${field}(id: ${JSON.stringify(String(value))}) { id names state } } }`, 240_000);
    const past = { update: 'updated', start: 'started', stop: 'stopped', restart: 'restarted' }[action] || 'updated';
    return { ok: true, message: `Container ${past}` };
  },

  async poll(ctx) {
    // combined query first (1 request); fall back to per-part probes
    let combined = await probe(ctx, Q_COMBINED);
    let infoRes = combined, arrayRes = combined, containersRes = combined, metricsRes = combined;
    if (!combined || (!combined.info && !combined.array && !combined.docker && !combined.metrics)) {
      [infoRes, arrayRes, containersRes, metricsRes] = await Promise.all([
        probe(ctx, Q_INFO), probe(ctx, Q_ARRAY), probe(ctx, Q_CONTAINERS), probe(ctx, Q_METRICS),
      ]);
    }

    if (!infoRes && !arrayRes && !containersRes && !metricsRes) {
      throw new Error('Unraid API answered but rejected every query — API version or sandbox configuration?');
    }
    // If the array query failed only because of the optional fs* fields, retry without them.
    if (!arrayRes?.array) {
      const basic = await probe(ctx, Q_ARRAY_BASIC);
      if (basic?.array) arrayRes = basic;
    }
    // Same for the newer container fields (webUiUrl/lanIpPorts/ports).
    if (!containersRes?.docker?.containers) {
      const basic = await probe(ctx, Q_CONTAINERS_BASIC);
      if (basic?.docker?.containers) containersRes = basic;
    }
    let host = '';
    try { host = new URL(ctx.base).hostname; } catch { /* base may not be absolute */ }

    const os = infoRes?.info?.os || {};
    const cpu = infoRes?.info?.cpu || {};
    const array = arrayRes?.array || null;
    const containersRaw = containersRes?.docker?.containers || null;
    const metrics = metricsRes?.metrics || null;
    const stats = [];
    const uptimeStr = parseUptime(os.uptime);
    if (uptimeStr) stats.push({ label: 'Uptime', value: uptimeStr, emphasis: true });
    if (cpu.threads != null || cpu.cores != null) {
      stats.push({ label: 'CPU', value: `${cpu.threads ?? cpu.cores ?? '?'} threads` });
    }
    if (metrics?.cpu?.percentTotal != null) {
      const cpuPct = Math.round(toNum(metrics.cpu.percentTotal));
      if (cpuPct != null) stats.push({ label: 'CPU now', value: cpuPct + '%', emphasis: cpuPct > 60 });
    }
    if (metrics?.memory) {
      // prefer (total - available): Linux "used" includes cache and reads absurdly high
      const total = toNum(metrics.memory.total);
      const available = toNum(metrics.memory.available);
      const usedRaw = toNum(metrics.memory.used);
      let memPct = null;
      if (total > 0 && available != null) memPct = Math.round(((total - available) / total) * 100);
      else if (metrics.memory.percentTotal != null) memPct = Math.round(toNum(metrics.memory.percentTotal));
      else if (total > 0 && usedRaw != null) memPct = Math.round((usedRaw / total) * 100);
      if (memPct != null) stats.push({ label: 'RAM now', value: memPct + '%', emphasis: memPct > 80 });
    }
    if (array?.state) stats.push({ label: 'Array', value: array.state, tone: array.state === 'STARTED' ? 'good' : 'warn' });
    if (array?.parityCheckStatus?.running) {
      const p = Math.round(Number(array.parityCheckStatus.progress) || 0);
      stats.push({ label: 'Parity', value: p + '%', emphasis: true });
    }

    // containers — normalized for the Docker widget fallback too
    let containers = null;
    if (Array.isArray(containersRaw) && containersRaw.length) {
      const list = containersRaw;
      const running = list.filter((c) => String(c.state || '').toUpperCase() === 'RUNNING').length;
      stats.push({ label: 'Containers', value: `${running}/${list.length}` });
      containers = list.map((c) => {
        const name = (Array.isArray(c.names) ? c.names[0] : c.names || 'unknown').replace(/^\//, '');
        const icon = resolveIcon(c.iconUrl, ctx.base);
        const bundled = bundledIconFor(name, c.image);
        return {
          id: c.id || '',
          name,
          state: String(c.state || '').toLowerCase(),
          status: String(c.status || c.state || '').toLowerCase(),
          image: c.image || '',
          update: !!c.isUpdateAvailable,
          url: resolveWebUi(c, host),
          icon: icon || bundled,
          iconFallback: icon ? bundled : '',
        };
      });
    }

    const charts = {};
    const diskRows = [
      ...(Array.isArray(array?.disks) ? array.disks : []).map((d) => ({ ...d, isCache: false })),
      ...(Array.isArray(array?.caches) ? array.caches : []).map((d) => ({ ...d, isCache: true })),
    ];
    const disks = diskRows
      .filter((d) => d && d.name)
      .map((d) => ({
        label: d.isCache ? `cache/${String(d.name).replace(/^\/mnt\//, '')}` : String(d.name).replace(/^\/mnt\//, ''),
        size: fmtKB(d.size),
        free: fmtKB(d.fsFree),
        used: fmtKB(d.fsUsed),
        pct: (toNum(d.fsUsed) != null && toNum(d.fsSize) > 0) ? Math.round((toNum(d.fsUsed) / toNum(d.fsSize)) * 100) : null,
        temp: toNum(d.temp) != null && toNum(d.temp) > 0 ? Math.round(toNum(d.temp)) : null,
        status: d.status || '',
      }));
    const cap = array?.capacity?.kilobytes || null;
    if (cap && toNum(cap.total) > 0) {
      // Unraid reports free/used/total capacity in kilobytes; derive whichever
      // value is missing so the remaining space is always right.
      const totalGB = kbToGB(cap.total);
      const usedRaw = kbToGB(cap.used);
      const freeRaw = kbToGB(cap.free);
      let usedGB = usedRaw != null ? usedRaw
        : (freeRaw != null ? totalGB - freeRaw : totalGB);
      let freeGB = freeRaw != null ? freeRaw : totalGB - usedGB;
      usedGB = Math.min(Math.max(0, usedGB), totalGB);
      freeGB = Math.min(Math.max(0, freeGB), totalGB);
      const pctUsed = totalGB > 0 ? Math.round((usedGB / totalGB) * 100) : 0;
      charts.disks = [{
        label: 'Array',
        usedGB: +usedGB.toFixed(1),
        freeGB: +freeGB.toFixed(1),
        totalGB: +totalGB.toFixed(1),
      }];
      stats.push({ label: 'Array free', value: fmtGB(freeGB), tone: pctUsed > 90 ? 'bad' : 'good' });
    }

    return {
      stats,
      disks,
      containers,
      charts,
      version: os.release || '',
      serverName: os.distro || 'Unraid',
    };
  },
};
