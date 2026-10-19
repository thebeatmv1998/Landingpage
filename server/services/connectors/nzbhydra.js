// NZBHydra 2 — uses the External API v1 (verified against the server source):
//   GET /externalapi/v1/ping                  — verifies API key + reachability
//   GET /externalapi/v1/stats?sections=…      — aggregated statistics
//   GET /externalapi/v1/history/…             — paged history with totals
// Auth: "X-Api-Key" header or "apikey" query parameter.
// Indexer statuses (enabled/disabled/errors) still come from the legacy
// POST /api/stats/indexers with the apikey in the JSON BODY, and require
// "Allow stats access via API" to be enabled in NZBHydra's authentication settings.

const KEY_HELP = 'NZBHydra requires "Allow stats access via API" to be enabled (Authentication settings) for statistics';

function withKey(ctx, path) {
  const joiner = path.includes('?') ? '&' : '?';
  return `${path}${joiner}apikey=${encodeURIComponent(ctx.apiKey || '')}`;
}

function v1Headers(ctx) {
  return { 'X-Api-Key': ctx.apiKey, Accept: 'application/json' };
}

async function v1Stats(ctx) {
  const res = await ctx.api(withKey(ctx, '/externalapi/v1/stats?sections=INDEXER_API_ACCESS,INDEXER_DOWNLOAD_SHARES'), {
    headers: v1Headers(ctx),
    timeoutMs: 15000,
  });
  return res.json;
}

async function indexerStatuses(ctx) {
  // legacy endpoint: POST only, apikey inside the JSON body
  const res = await ctx.api(withKey(ctx, '/api/stats/indexers'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apikey: ctx.apiKey }),
    timeoutMs: 12000,
  });
  const j = res.json;
  return Array.isArray(j) ? j : (Array.isArray(j?.indexers) ? j.indexers : []);
}

async function historyTotal(ctx, kind) {
  try {
    const res = await ctx.api(withKey(ctx, `/externalapi/v1/history/${kind}?limit=1`), {
      headers: v1Headers(ctx),
      timeoutMs: 15000,
    });
    const j = res.json;
    const total = Number(j?.totalElements ?? j?.totalItems ?? j?.totalCount);
    return Number.isFinite(total) ? total : null;
  } catch { return null; }
}

export default {
  async test(ctx) {
    if (!ctx.base) return { ok: false, message: 'URL is required' };
    if (!ctx.apiKey) return { ok: false, message: 'API key is required' };
    try {
      await ctx.api(withKey(ctx, '/externalapi/v1/ping'), { headers: v1Headers(ctx), timeoutMs: 12000 });
      return { ok: true, message: 'Connected to NZBHydra 2 (External API v1)' };
    } catch (err) {
      if (/HTTP 401/.test(err.message)) {
        return { ok: false, message: 'NZBHydra found, but the API key is invalid — Settings → Main → API key' };
      }
      if (/HTTP 403/.test(err.message)) {
        return { ok: false, message: `Key accepted, but access is forbidden — ${KEY_HELP}` };
      }
      // very old NZBHydra2 without the v1 API: try the legacy stats endpoint
      try {
        const list = await indexerStatuses(ctx);
        return { ok: true, message: `Connected to NZBHydra 2 (legacy API) — ${list.length} indexer records` };
      } catch (err2) {
        return { ok: false, message: `v1: ${err.message} / legacy: ${err2.message}` };
      }
    }
  },

  async poll(ctx) {
    const stats = [];
    const charts = {};

    // 1) indexer statuses (legacy endpoint, best-effort)
    let enabled = null, disabled = 0, errored = 0;
    try {
      const list = await indexerStatuses(ctx);
      enabled = list.filter((i) => i?.state === 'ENABLED').length;
      disabled = list.length - enabled;
      errored = list.filter((i) => i?.level === 'ERROR' || i?.lastError).length;
      if (enabled != null) {
        stats.push({ label: 'Indexers', value: enabled });
        if (disabled) stats.push({ label: 'Disabled', value: disabled, emphasis: true });
        if (errored) stats.push({ label: 'Errors', value: errored, tone: 'bad' });
      }
    } catch { /* statuses optional */ }

    // 2) v1 aggregate stats: per-indexer success rates + download shares
    let accessesPerDay = null;
    try {
      const s = await v1Stats(ctx);
      const access = Array.isArray(s?.indexerApiAccessStats) ? s.indexerApiAccessStats : [];
      accessesPerDay = access.reduce((acc, a) => acc + Number(a?.averageAccessesPerDay ?? 0), 0);
      if (accessesPerDay > 0) stats.push({ label: 'API accesses/day', value: Math.round(accessesPerDay) });
      const bars = access
        .map((a) => ({ label: a?.indexerName || '?', value: Math.round(Number(a?.percentSuccessful ?? 0)), sub: `${Math.round(Number(a?.percentSuccessful ?? 0))}% ok` }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 8);
      if (bars.length) charts.bars = bars;
    } catch { /* aggregate stats optional */ }

    // 3) totals from history pages (parallel)
    const [searches, downloads] = await Promise.all([
      historyTotal(ctx, 'searches'),
      historyTotal(ctx, 'downloads'),
    ]);
    if (searches != null) stats.push({ label: 'Searches', value: searches });
    if (downloads != null) stats.push({ label: 'Downloads', value: downloads });

    if (!stats.length) throw new Error('No statistics available — ' + KEY_HELP);
    return { stats, activity: [], charts };
  },
};
