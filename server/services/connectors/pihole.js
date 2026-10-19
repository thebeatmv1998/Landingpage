// Pi-hole — supports both v5 (api.php) and v6 (/api/auth + X-FTL-SID).
// v6 sessions are cached and reused (Pi-hole limits concurrent API sessions;
// logging in on every poll would exhaust "webserver.api.max_sessions" fast).

const sessionCache = new Map(); // service id -> { sid, expiresAt }

async function tryV5(ctx) {
  const params = new URLSearchParams({ summary: '' });
  if (ctx.password) params.set('auth', ctx.password);
  const res = await ctx.api(`/admin/api.php?${params.toString()}`, { timeoutMs: 10000 });
  const j = res.json;
  if (!j || j.dns_queries_today === undefined) return null;
  const stats = [
    { label: 'Queries today', value: Number(j.dns_queries_today || 0), emphasis: true },
    { label: 'Blocked', value: Number(j.ads_blocked_today || 0), tone: 'bad' },
    { label: 'Blocked %', value: (Number(j.ads_percentage_today || 0)).toFixed(1) + '%', emphasis: true },
    { label: 'Clients', value: Number(j.unique_clients || 0) },
    { label: 'Blocklist', value: Number(j.domains_being_blocked || 0) },
  ];
  return { stats, status: j.status || 'enabled' };
}

async function tryV5Graph(ctx) {
  const params = new URLSearchParams({ overTimeData10mins: '' });
  if (ctx.password) params.set('auth', ctx.password);
  const res = await ctx.api(`/admin/api.php?${params.toString()}`, { timeoutMs: 10000 });
  const j = res.json;
  const domains = j?.domains_over_time, ads = j?.ads_over_time;
  if (!domains || !ads) return null;
  const times = Object.keys(domains).map(Number).sort((a, b) => a - b).slice(-144); // last 24h
  return {
    points: times.map((t) => ({
      t,
      queries: Number(domains[t] || 0),
      blocked: Number(ads[t] || 0),
    })),
  };
}

async function getSession(ctx) {
  const cached = sessionCache.get(ctx.id);
  if (cached && cached.expiresAt > Date.now() - 30_000) return cached.sid;
  const res = await ctx.api('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ctx.password || '' }),
    timeoutMs: 10000,
  });
  const sess = res.json?.session;
  const sid = sess?.sid;
  if (!sid) throw new Error('Pi-hole v6 auth failed (wrong password?)');
  const ttl = (Number(sess.validity) || 300) * 1000;
  sessionCache.set(ctx.id, { sid, expiresAt: Date.now() + Math.max(60_000, ttl - 30_000) });
  return sid;
}

function dropSession(ctx) {
  sessionCache.delete(ctx.id);
}

async function tryV6(ctx) {
  const sid = await getSession(ctx);
  const headers = { 'X-FTL-SID': sid };
  let sum;
  try {
    sum = (await ctx.api('/api/stats/summary', { headers, timeoutMs: 10000 })).json || {};
  } catch (err) {
    dropSession(ctx); // stale/invalidated session — re-login next poll
    throw err;
  }
  const q = sum.queries || {};
  const blocked = Number(q.blocked ?? 0);
  const total = Number(q.total ?? 0);
  const stats = [
    { label: 'Queries today', value: total, emphasis: true },
    { label: 'Blocked', value: blocked, tone: 'bad' },
    { label: 'Blocked %', value: (Number(q.percent_blocked ?? 0)).toFixed(1) + '%', emphasis: true },
    { label: 'Clients', value: Number(sum.clients?.active ?? sum.clients?.total ?? 0) },
    { label: 'Blocklist', value: Number(sum.gravity?.domains_being_blocked ?? 0) },
  ];
  return { stats, status: 'enabled', headers };
}

async function v6Graph(ctx, headers) {
  const res = await ctx.api('/api/history', { headers, timeoutMs: 10000 });
  const hist = res.json?.history;
  if (!Array.isArray(hist)) return null;
  return {
    points: hist.slice(-144).map((h) => ({
      t: Number(h.timestamp),
      // v6 returns flat fields; older builds nest them under `queries`.
      queries: Number(h.queries?.total ?? h.total ?? 0),
      blocked: Number(h.queries?.blocked ?? h.blocked ?? 0),
    })),
  };
}

const V6_SEATS_HINT = 'Pi-hole rejected the login: all API sessions are in use ("api_seats_exceeded"). ' +
  'Either wait for sessions to expire, or raise "webserver.api.max_sessions" in /etc/pihole/pihole.toml.';

export default {
  // Called by the runner when the service credentials/URL change.
  reset(id) { sessionCache.delete(id); },

  async test(ctx) {
    if (!ctx.base) return { ok: false, message: 'URL is required' };
    if (ctx.password) {
      try {
        await tryV6(ctx);
        return { ok: true, message: 'Connected (Pi-hole v6 API)' };
      } catch (e6) {
        if (/api_seats_exceeded/.test(e6.message)) return { ok: false, message: V6_SEATS_HINT };
        // if this is a v6 server, its /admin/api.php answers with a 400 hint — treat as v6 problem
        try {
          const v5 = await tryV5(ctx);
          if (v5) return { ok: true, message: 'Connected (Pi-hole v5 API)' };
          return { ok: false, message: 'Neither v5 nor v6 API answered: ' + e6.message };
        } catch (e5) {
          return { ok: false, message: 'v5: ' + e5.message + ' / v6: ' + e6.message };
        }
      }
    }
    try {
      const v5 = await tryV5(ctx);
      if (v5) return { ok: true, message: 'Connected (Pi-hole v5 API, no auth)' };
      return { ok: false, message: 'API answered but not with a v5 summary — configure the password' };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  },

  async poll(ctx) {
    if (ctx.password) {
      // v6 first (its API needs an authenticated session), fall back to v5
      try {
        const v6 = await tryV6(ctx);
        const graph = await v6Graph(ctx, v6.headers).catch(() => null);
        const points = graph?.points || [];
        return {
          stats: v6.stats,
          charts: { pihole: { series: points } },
        };
      } catch (err) {
        if (/api_seats_exceeded/.test(err.message)) throw new Error(V6_SEATS_HINT);
        // fall through to v5 (but a v6 server answers /admin/api.php with a 400 hint)
        try {
          const v5 = await tryV5(ctx);
          if (v5) {
            const graph = await tryV5Graph(ctx).catch(() => null);
            return { stats: v5.stats, charts: { pihole: { series: graph?.points || [] } } };
          }
        } catch { /* report original error below */ }
        throw err;
      }
    }
    const v5 = await tryV5(ctx);
    if (!v5) throw new Error('Pi-hole API did not return a summary — check URL/password');
    const graph = await tryV5Graph(ctx).catch(() => null);
    return {
      stats: v5.stats,
      charts: { pihole: { series: graph?.points || [] } },
    };
  },
};
