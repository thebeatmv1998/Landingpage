// Generic connector — check any HTTP(S) endpoint for liveness + response time.
// Makes the dashboard easy to extend to services without a dedicated connector.

export default {
  async test(ctx) {
    if (!ctx.base) return { ok: false, message: 'URL is required' };
    const path = ctx.extra.checkPath || '/';
    const started = Date.now();
    try {
      const headers = {};
      if (ctx.apiKey) headers['Authorization'] = `Bearer ${ctx.apiKey}`;
      const res = await ctx.text(path, { headers, timeoutMs: 10000 });
      const ms = Date.now() - started;
      if (res.ok) return { ok: true, message: `HTTP ${res.status} in ${ms} ms` };
      return { ok: false, message: `HTTP ${res.status} in ${ms} ms` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  },

  async poll(ctx) {
    const path = ctx.extra.checkPath || '/';
    const started = Date.now();
    const headers = {};
    if (ctx.apiKey) headers['Authorization'] = `Bearer ${ctx.apiKey}`;
    const res = await ctx.text(path, { headers, timeoutMs: 10000 });
    const ms = Date.now() - started;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return {
      stats: [
        { label: 'Status', value: 'Online', tone: 'good', emphasis: true },
        { label: 'Response', value: `${ms} ms` },
        { label: 'HTTP', value: String(res.status) },
      ],
      charts: {},
    };
  },
};
