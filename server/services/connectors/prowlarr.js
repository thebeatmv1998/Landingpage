const API = '/api/v1';

async function api(ctx, path, opts = {}) {
  const headers = { 'X-Api-Key': ctx.apiKey, Accept: 'application/json', ...(opts.headers || {}) };
  const res = await ctx.api(`${API}${path}`, { ...opts, headers, timeoutMs: 12000 });
  return res.json;
}

export default {
  async test(ctx) {
    if (!ctx.base) return { ok: false, message: 'URL is required' };
    if (!ctx.apiKey) return { ok: false, message: 'API key is required' };
    try {
      const s = await api(ctx, '/system/status');
      return { ok: true, message: `Connected to Prowlarr v${s?.version || '?'}` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  },

  async poll(ctx) {
    const [indexers, health] = await Promise.all([
      api(ctx, '/indexer').catch(() => []),
      api(ctx, '/health').catch(() => []),
    ]);
    const list = Array.isArray(indexers) ? indexers : [];
    const enabled = list.filter((x) => x.enable).length;
    let stats = { queries: 0, grabs: 0, failedQueries: 0, failedGrabs: 0 };
    let perIndexer = [];
    try {
      const s = await api(ctx, '/indexerstats');
      stats = {
        queries: Number(s?.queries ?? 0),
        grabs: Number(s?.grabs ?? 0),
        failedQueries: Number(s?.failedQueries ?? 0),
        failedGrabs: Number(s?.failedGrabs ?? 0),
      };
      perIndexer = (Array.isArray(s?.indexers) ? s.indexers : [])
        .map((i) => ({ label: i.indexerName || `#${i.indexerId}`, value: Number(i.queries ?? 0), sub: `${Number(i.grabs ?? 0)} grabs` }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 8);
    } catch { /* optional */ }

    const statsOut = [
      { label: 'Indexers', value: enabled },
      { label: 'Queries', value: stats.queries },
      { label: 'Grabs', value: stats.grabs },
    ];
    if (stats.failedQueries || stats.failedGrabs) {
      statsOut.push({ label: 'Failures', value: stats.failedQueries + stats.failedGrabs, tone: 'bad' });
    }
    const healthIssues = Array.isArray(health) ? health.length : 0;
    if (healthIssues) statsOut.push({ label: 'Health', value: healthIssues, tone: 'bad' });

    return {
      stats: statsOut,
      activity: [],
      charts: { bars: perIndexer },
    };
  },
};
