import { fmtBytes } from '../../core/util.js';

// SABnzbd — classic API: /sabnzbd/api?mode=...&output=json&apikey=...

function url(ctx, params) {
  const sp = new URLSearchParams({ output: 'json', apikey: ctx.apiKey || '', ...params });
  return `/sabnzbd/api?${sp.toString()}`;
}

async function call(ctx, params) {
  const res = await ctx.api(url(ctx, params), { timeoutMs: 10000 });
  // SAB returns {status: false, error: "..."} on bad keys
  if (res.json && res.json.status === false && res.json.error) throw new Error(res.json.error);
  return res.json;
}

export default {
  async test(ctx) {
    if (!ctx.base) return { ok: false, message: 'URL is required' };
    if (!ctx.apiKey) return { ok: false, message: 'API key is required' };
    try {
      const j = await call(ctx, { mode: 'version' });
      return { ok: true, message: `Connected to SABnzbd v${j?.version || '?'}` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  },

  // Actions: pause/resume the whole queue or single slots. Values: {action, value?}
  async action(ctx, { action, value } = {}) {
    switch (action) {
      case 'pause':
        await call(ctx, { mode: 'pause', value: '0' });
        return { ok: true, message: 'SABnzbd queue paused' };
      case 'resume':
        await call(ctx, { mode: 'resume', value: '0' });
        return { ok: true, message: 'SABnzbd queue resumed' };
      case 'slot_pause':
        if (!value) return { ok: false, message: 'Missing slot id' };
        await call(ctx, { mode: 'slot_pause', value });
        return { ok: true };
      case 'slot_resume':
        if (!value) return { ok: false, message: 'Missing slot id' };
        await call(ctx, { mode: 'slot_resume', value });
        return { ok: true };
      default:
        return { ok: false, message: `Unknown action "${action}"` };
    }
  },

  async poll(ctx) {
    const [queueJ, historyJ] = await Promise.all([
      call(ctx, { mode: 'queue' }).catch(() => null),
      call(ctx, { mode: 'history', limit: '12' }).catch(() => null),
    ]);
    const q = queueJ?.queue || {};
    const paused = String(q.paused) === 'true' || String(q.status || '').toLowerCase() === 'paused';
    const slots = Array.isArray(q.slots) ? q.slots : [];
    const speedBps = Number(q.kbpersec || 0) * 1024;
    const mbLeft = Number(q.mbleft || 0);
    const mbTotal = Number(q.mb || 0);
    const overall = mbTotal > 0 ? Math.round(((mbTotal - mbLeft) / mbTotal) * 100) : 0;

    const activity = slots.slice(0, 20).map((s, i) => ({
      id: s.nzo_id ?? i,
      title: s.filename || 'Download',
      subtitle: [s.cat !== 'Default' ? s.cat : '', s.status].filter(Boolean).join(' · '),
      progress: Math.round(Number(s.percentage || 0)),
      state: 'active',
      paused: String(s.status || '').toLowerCase() === 'paused',
      meta: s.timeleft || '',
    }));

    const hSlots = Array.isArray(historyJ?.history?.slots) ? historyJ.history.slots : [];
    const history = hSlots.slice(0, 10).map((h, i) => ({
      id: h.nzo_id ?? i,
      title: h.name || 'Completed',
      subtitle: h.status === 'Failed' ? (h.fail_message || 'Failed') : `${h.status || 'Done'} · ${fmtBytes(h.bytes)}`,
      progress: 100,
      state: h.status === 'Failed' ? 'failed' : 'done',
    }));

    const stats = [
      { label: 'Status', value: paused ? 'Paused' : (slots.length ? 'Downloading' : 'Idle'), emphasis: slots.length > 0 && !paused },
      { label: 'Queue', value: slots.length },
      { label: 'Speed', value: paused ? '0 B/s' : fmtBytes(speedBps) + '/s', emphasis: speedBps > 0 && !paused },
    ];
    if (q.timeleft) stats.push({ label: 'ETA', value: q.timeleft });

    return {
      stats,
      activity,
      history,
      charts: {
        downloads: { overall, speedBps: Math.round(speedBps), paused },
      },
    };
  },
};
