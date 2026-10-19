// Vaultwarden — /alive health check; optional ADMIN_TOKEN for user count.

export default {
  async test(ctx) {
    if (!ctx.base) return { ok: false, message: 'URL is required' };
    try {
      const res = await ctx.text('/alive', { timeoutMs: 10000 });
      if (res.ok) return { ok: true, message: 'Vaultwarden is alive' };
      return { ok: false, message: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  },

  async poll(ctx) {
    const alive = await ctx.text('/alive', { timeoutMs: 10000 });
    if (!alive.ok) throw new Error(`HTTP ${alive.status}`);
    const stats = [{ label: 'Status', value: 'Online', emphasis: true }];

    if (ctx.apiKey) {
      for (const scheme of ['Bearer', '']) {
        try {
          const headers = { Accept: 'application/json' };
          if (scheme) headers['Authorization'] = `${scheme} ${ctx.apiKey}`.trim();
          else headers['Authorization'] = ctx.apiKey;
          const res = await ctx.api('/admin/users', { headers, timeoutMs: 10000 });
          const j = res.json;
          const users = Array.isArray(j) ? j.length : (Array.isArray(j?.Users) ? j.Users.length : (Array.isArray(j?.data) ? j.data.length : null));
          if (users != null) {
            stats.push({ label: 'Users', value: users });
            break;
          }
        } catch { /* try next scheme */ }
      }
    }
    return { stats, charts: {} };
  },
};
