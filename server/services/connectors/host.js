// Host system connector - CPU, RAM, swap, temperature, network and uptime
// straight from /proc and /sys. Designed for a container: mount the host's
// /proc and /sys read-only (see README) and point the connector at them.
import fs from 'node:fs/promises';
import os from 'node:os';
import { fmtBytes, sleep } from '../../core/util.js';

const state = new Map(); // service id -> previous counters + sparkline samples
const MAX_SAMPLES = 60;

async function readable(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function roots(ctx) {
  const extra = ctx.extra || {};
  const proc = String(
    extra.procRoot || process.env.HOST_PROC
      || (await readable('/host/proc/stat') ? '/host/proc' : '/proc'),
  ).replace(/\/+$/, '');
  const sys = String(
    extra.sysRoot || process.env.HOST_SYS
      || (await readable('/host/sys/class/thermal') ? '/host/sys' : '/sys'),
  ).replace(/\/+$/, '');
  return { proc, sys };
}

function parseCpu(text) {
  const line = text.split('\n').find((row) => row.startsWith('cpu '));
  if (!line) throw new Error('no cpu line in /proc/stat');
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  const [user, nice, system, idle, iowait, irq, softirq, steal] = fields;
  const total = fields.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  return { total, idle: (idle || 0) + (iowait || 0) };
}

function parseMeminfo(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s*kB/.exec(line);
    if (match) out[match[1]] = Number(match[2]) * 1024;
  }
  return out;
}

async function readNetwork(proc) {
  const text = await fs.readFile(`${proc}/net/dev`, 'utf8');
  let rx = 0;
  let tx = 0;
  for (const line of text.split('\n').slice(2)) {
    const match = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    if (match[1].trim() === 'lo') continue;
    const fields = match[2].trim().split(/\s+/).map(Number);
    rx += fields[0] || 0;
    tx += fields[8] || 0;
  }
  return { rx, tx };
}

async function readHwmon(sys) {
  const base = `${sys}/class/hwmon`;
  let entries = [];
  try {
    entries = await fs.readdir(base);
  } catch {
    return { temp: null, type: '' };
  }
  let best = null;
  let type = '';
  for (const entry of entries) {
    let files = [];
    try {
      files = await fs.readdir(`${base}/${entry}`);
    } catch {
      continue;
    }
    const name = (await fs.readFile(`${base}/${entry}/name`, 'utf8').catch(() => '')).trim();
    for (const file of files.filter((item) => /^temp\d+_input$/.test(item))) {
      try {
        const raw = Number((await fs.readFile(`${base}/${entry}/${file}`, 'utf8')).trim());
        if (!Number.isFinite(raw)) continue;
        const celsius = raw > 1000 ? raw / 1000 : raw;
        if (celsius > 0 && celsius < 150 && (best == null || celsius > best)) {
          best = celsius;
          type = name || file;
        }
      } catch {
        // try the next sensor
      }
    }
  }
  return { temp: best, type };
}

async function readTemperature(sys) {
  const base = `${sys}/class/thermal`;
  let entries = [];
  try {
    entries = await fs.readdir(base);
  } catch {
    return readHwmon(sys);
  }
  let best = null;
  let type = '';
  for (const entry of entries.filter((name) => /^thermal_zone\d+$/.test(name))) {
    try {
      const raw = Number((await fs.readFile(`${base}/${entry}/temp`, 'utf8')).trim());
      if (!Number.isFinite(raw)) continue;
      const celsius = raw > 1000 ? raw / 1000 : raw;
      if (celsius > 0 && celsius < 150 && (best == null || celsius > best)) {
        best = celsius;
        type = (await fs.readFile(`${base}/${entry}/type`, 'utf8').catch(() => '')).trim();
      }
    } catch {
      // try the next sensor
    }
  }
  if (best == null) return readHwmon(sys);
  return { temp: best, type, error: '' };
}

function humanUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function pushSample(list, value) {
  list.push(Number(value.toFixed(2)));
  while (list.length > MAX_SAMPLES) list.shift();
}

export default {
  reset(id) {
    state.delete(id);
  },

  async test(ctx) {
    try {
      const { proc, sys } = await roots(ctx);
      const cpu = parseCpu(await fs.readFile(`${proc}/stat`, 'utf8'));
      const mem = parseMeminfo(await fs.readFile(`${proc}/meminfo`, 'utf8'));
      const temp = await readTemperature(sys);
      const parts = [`${os.cpus().length || '?'} CPUs`, `${fmtBytes(mem.MemTotal || 0)} RAM`];
      if (!cpu) throw new Error('unreadable CPU counters');
      parts.push(temp.temp != null ? `${Math.round(temp.temp)} °C` : 'no temperature sensor');
      return { ok: true, message: `Host metrics from ${proc} - ${parts.join(', ')}` };
    } catch (err) {
      return { ok: false, message: `Host metrics unavailable: ${err.message}` };
    }
  },

  async poll(ctx) {
    const { proc, sys } = await roots(ctx);
    let statText;
    try {
      statText = await fs.readFile(`${proc}/stat`, 'utf8');
    } catch (err) {
      throw new Error(`Cannot read ${proc}/stat (mount the host /proc read-only): ${err.message}`);
    }
    let cpu = parseCpu(statText);
    let memText;
    try {
      memText = await fs.readFile(`${proc}/meminfo`, 'utf8');
    } catch (err) {
      throw new Error(`Cannot read ${proc}/meminfo: ${err.message}`);
    }
    const uptimeText = await fs.readFile(`${proc}/uptime`, 'utf8').catch(() => '0 0');
    const loadText = await fs.readFile(`${proc}/loadavg`, 'utf8').catch(() => '0 0 0');
    const net = await readNetwork(proc).catch(() => ({ rx: 0, tx: 0 }));
    const thermal = await readTemperature(sys);

    const previous = state.get(ctx.id);
    // The very first poll has no delta yet; take a second sample 150 ms later.
    if (!previous) {
      await sleep(150);
      cpu = parseCpu(await fs.readFile(`${proc}/stat`, 'utf8'));
    }
    const now = Date.now();
    let cpuPct = 0;
    if (previous?.cpu) {
      const total = cpu.total - previous.cpu.total;
      const idle = cpu.idle - previous.cpu.idle;
      if (total > 0) cpuPct = Math.max(0, Math.min(100, (1 - idle / total) * 100));
    }

    const mem = parseMeminfo(memText);
    const memTotal = mem.MemTotal || 0;
    const memAvailable = mem.MemAvailable ?? ((mem.MemFree || 0) + (mem.Buffers || 0) + (mem.Cached || 0));
    const ramPct = memTotal > 0 ? Math.max(0, Math.min(100, ((memTotal - memAvailable) / memTotal) * 100)) : 0;
    const swapTotal = mem.SwapTotal || 0;
    const swapUsed = Math.max(0, swapTotal - (mem.SwapFree || 0));
    const swapPct = swapTotal > 0 ? (swapUsed / swapTotal) * 100 : 0;

    let rxRate = 0;
    let txRate = 0;
    if (previous?.net && previous.at) {
      const seconds = Math.max(0.5, (now - previous.at) / 1000);
      rxRate = Math.max(0, (net.rx - previous.net.rx) / seconds);
      txRate = Math.max(0, (net.tx - previous.net.tx) / seconds);
    }

    const uptimeSeconds = Number.parseFloat(String(uptimeText).trim().split(/\s+/)[0]) || 0;
    const load = String(loadText).trim().split(/\s+/).slice(0, 3).map((v) => Number(v) || 0);

    const samples = previous?.samples || { cpu: [], mem: [], netRx: [], netTx: [] };
    pushSample(samples.cpu, cpuPct);
    pushSample(samples.mem, ramPct);
    pushSample(samples.netRx, rxRate);
    pushSample(samples.netTx, txRate);

    state.set(ctx.id, { cpu, net, at: now, samples });

    const stats = [
      { label: 'CPU', value: `${Math.round(cpuPct)}%`, emphasis: true, tone: cpuPct > 90 ? 'bad' : cpuPct > 75 ? 'warn' : undefined },
      { label: 'RAM', value: `${Math.round(ramPct)}%`, emphasis: true, tone: ramPct > 90 ? 'bad' : undefined },
      { label: 'Temp', value: thermal.temp != null ? `${Math.round(thermal.temp)} °C` : 'n/a', tone: thermal.temp != null && thermal.temp > 80 ? 'warn' : undefined },
      { label: 'Uptime', value: humanUptime(uptimeSeconds) },
      { label: 'Load', value: load.map((v) => v.toFixed(2)).join(' / ') },
      { label: 'Net down', value: `${fmtBytes(rxRate)}/s` },
      { label: 'Net up', value: `${fmtBytes(txRate)}/s` },
    ];
    if (swapTotal > 0) stats.splice(2, 0, { label: 'Swap', value: `${Math.round(swapPct)}%` });

    const hints = [];
    if (thermal.temp == null) {
      hints.push(`No temperature sensor under ${sys}/class/thermal - mount the host /sys read-only to enable it.`);
    }
    if (proc === '/proc') {
      hints.push('Using the container\'s /proc; mount the host /proc read-only for host network counters.');
    }

    return {
      stats,
      hints,
      charts: {
        host: {
          cpu: samples.cpu.slice(),
          mem: samples.mem.slice(),
          netRx: samples.netRx.slice(),
          netTx: samples.netTx.slice(),
        },
      },
      serverName: os.hostname(),
      version: os.release(),
    };
  },
};
