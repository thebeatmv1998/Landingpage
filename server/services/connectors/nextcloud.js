// Nextcloud — status.php + serverinfo OCS API (CPU load, memory, storage, shares).
//
// The serverinfo response is nested:
//   ocs.data.nextcloud.system  { version, freespace, cpuload[], mem_total, mem_free }
//   ocs.data.nextcloud.storage { num_users, num_files, num_storages }
//   ocs.data.nextcloud.shares  { num_shares, … }
// mem_total/mem_free are in KB, freespace in bytes. The serverinfo app must be
// enabled and the account must be an admin (or use an app password with admin).
import { fmtBytesSI } from '../../core/util.js';

function dig(obj, path, fallback = undefined) {
  let cur = obj;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return fallback;
    cur = cur[key];
  }
  return cur === undefined ? fallback : cur;
}

function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function serverinfoHeaders(ctx) {
  return { 'OCS-APIRequest': 'true', Authorization: ctx.basicHeader(), Accept: 'application/json' };
}

async function fetchServerinfo(ctx) {
  const res = await ctx.api('/ocs/v2.php/apps/serverinfo/api/v1/info?format=json', {
    headers: serverinfoHeaders(ctx),
    timeoutMs: 20000,
  });
  const ocs = res.json?.ocs;
  if (ocs?.meta && Number(ocs.meta.statuscode) !== 200) {
    throw new Error(`serverinfo: ${ocs.meta.message || `status ${ocs.meta.statuscode}`}`);
  }
  const data = ocs?.data || {};
  if (!data.nextcloud && !data.system && !data.storage) {
    throw new Error('serverinfo returned no data');
  }
  return data;
}

const HELP = 'enable the "serverinfo" app (Settings → Apps) and use an admin account (or an app password for one)';

export default {
  async test(ctx) {
    if (!ctx.base) return { ok: false, message: 'URL is required' };
    if (!(ctx.username && ctx.password)) return { ok: false, message: 'Username and (app) password required' };
    let status = {};
    try {
      status = (await ctx.api('/status.php', { timeoutMs: 10000 })).json || {};
    } catch (err) {
      return { ok: false, message: err.message };
    }
    const name = status.productname || 'Nextcloud';
    if (status.maintenance) return { ok: true, message: `${name} reachable (maintenance mode ON)` };
    try {
      const data = await fetchServerinfo(ctx);
      const st = data.nextcloud?.storage || {};
      return { ok: true, message: `Connected to ${name} ${status.version || ''} — ${st.num_users ?? '?'} users, ${st.num_files ?? '?'} files` };
    } catch (err) {
      if (/HTTP 401|HTTP 403/.test(err.message)) {
        return { ok: false, message: `Connected to ${name}, but the credentials were rejected — ${HELP}` };
      }
      return { ok: false, message: `Connected to ${name}, but ${err.message} — ${HELP}` };
    }
  },

  async poll(ctx) {
    if (!ctx.basicHeader()) throw new Error('Username and password required');

    let status = {};
    try { status = (await ctx.api('/status.php', { timeoutMs: 10000 })).json || {}; } catch { status = {}; }

    let data;
    try {
      data = await fetchServerinfo(ctx);
    } catch (err) {
      throw new Error(`${err.message} — ${HELP}`);
    }

    const nc = data.nextcloud || {};
    const system = nc.system || data.system || {};
    const storage = nc.storage || data.storage || {};
    const shares = nc.shares || data.shares || {};

    const users = num(storage.num_users ?? dig(data, 'storage.num_users'));
    const files = num(storage.num_files ?? dig(data, 'storage.num_files'));
    const shareCount = num(shares.num_shares ?? dig(data, 'shares.num_shares'));

    // mem_total/mem_free are KB → the ratio is unit-agnostic.
    const memTotal = num(system.mem_total ?? dig(data, 'memory.ram.total'));
    const memFree = num(system.mem_free ?? dig(data, 'memory.ram.free'));

    // cpuload is a 1/5/15-minute load-average array.
    let cpuLoad = null;
    const cl = system.cpuload ?? data.cpuload ?? data.cpu;
    if (Array.isArray(cl) && cl.length) {
      const first = cl[0];
      cpuLoad = (first && typeof first === 'object')
        ? num(first.load ?? first.percent ?? first.percentage)
        : num(first);
    } else if (typeof cl === 'number') cpuLoad = cl;
    else if (cl && typeof cl === 'object') cpuLoad = num(cl.load ?? cl[0]);

    const freeBytes = num(system.freespace ?? dig(data, 'system.freespace') ?? storage.free);

    const stats = [];
    if (users != null) stats.push({ label: 'Users', value: users });
    if (files != null) stats.push({ label: 'Files', value: files });
    if (shareCount != null) stats.push({ label: 'Shares', value: shareCount });
    if (cpuLoad != null) stats.push({ label: 'CPU load', value: cpuLoad.toFixed(2), emphasis: cpuLoad > 2 });
    if (memTotal > 0 && memFree != null) {
      const memPct = Math.max(0, Math.min(100, Math.round(((memTotal - memFree) / memTotal) * 100)));
      stats.push({ label: 'RAM', value: memPct + '%', emphasis: memPct > 80 });
    }
    if (freeBytes != null) stats.push({ label: 'Free space', value: fmtBytesSI(freeBytes) });

    // Only expose a disk bar when the API actually reports total capacity.
    const charts = {};
    const totalBytes = num(storage.total ?? dig(data, 'storage.total'));
    const usedBytes = num(storage.used ?? dig(data, 'storage.used'));
    if (totalBytes > 0) {
      const toGB = (b) => (b == null ? null : +(b / 1e9).toFixed(1));
      charts.disks = [{
        label: 'Nextcloud storage',
        usedGB: toGB(usedBytes),
        freeGB: toGB(storage.free ?? freeBytes),
        totalGB: toGB(totalBytes),
      }];
    }

    return {
      stats,
      charts,
      version: system.version || status.version || dig(data, 'nextcloud.system.version') || '',
      maintenance: !!status.maintenance,
    };
  },
};
