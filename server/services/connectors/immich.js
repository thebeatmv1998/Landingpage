// Immich — server ping/version/statistics via x-api-key.
// /api/server/statistics and /api/users are admin-only on the Immich server:
// the API key must belong to an administrator account (403 otherwise).
import { fmtBytesSI } from '../../core/util.js';

async function api(ctx, path) {
  const headers = { 'x-api-key': ctx.apiKey, Accept: 'application/json' };
  const res = await ctx.api(path, { headers, timeoutMs: 15000 });
  return res.json;
}

const ADMIN_HELP = 'create this API key with an administrator account and grant at least the "server.statistics" permission (Account Settings → API Keys)';

export default {
  async test(ctx) {
    if (!ctx.base) return { ok: false, message: 'URL is required' };
    if (!ctx.apiKey) return { ok: false, message: 'API key is required (Immich → Account Settings → API Keys)' };
    try {
      const pong = await api(ctx, '/api/server/ping');
      if (pong?.res !== 'pong') return { ok: false, message: 'Unexpected ping response' };
    } catch (err) {
      return { ok: false, message: `No Immich at this URL (${err.message}) — check the port (Immich default: 2283)` };
    }
    // ping is public — actually verify the key against an admin endpoint
    try {
      await api(ctx, '/api/server/statistics');
      return { ok: true, message: 'Connected to Immich (admin key verified)' };
    } catch (err) {
      if (/HTTP 403/.test(err.message)) {
        return { ok: false, message: `Immich key works, but lacks admin rights — ${ADMIN_HELP}` };
      }
      if (/HTTP 401/.test(err.message)) {
        return { ok: false, message: 'Immich found, but the API key is invalid — Account Settings → API Keys' };
      }
      return { ok: false, message: err.message };
    }
  },

  async poll(ctx) {
    let stats;
    try {
      stats = await api(ctx, '/api/server/statistics');
    } catch (err) {
      if (/HTTP 403/.test(err.message)) {
        throw new Error(`Immich rejected the key (statistics is admin-only) — ${ADMIN_HELP}`);
      }
      throw err;
    }
    const photos = Number(stats?.photos ?? 0);
    const videos = Number(stats?.videos ?? 0);
    const usage = Number(stats?.usage ?? 0);

    const out = [
      { label: 'Photos', value: photos, emphasis: true },
      { label: 'Videos', value: videos },
    ];
    if (usage) out.push({ label: 'Storage', value: fmtBytesSI(usage) });

    let users = null;
    try {
      let u = null;
      // user list moved across Immich versions: /api/users (old) → /api/admin/users
      // (new, scope adminUser.read) → /api/user (very old)
      for (const path of ['/api/users', '/api/admin/users', '/api/user']) {
        try { u = await api(ctx, path); break; } catch { u = null; }
      }
      users = Array.isArray(u) ? u.length : null;
    } catch { users = null; }
    if (users != null) out.push({ label: 'Users', value: users });

    let version = '';
    try {
      const v = await api(ctx, '/api/server/version');
      version = `v${v?.major}.${v?.minor}.${v?.patch ?? v?.fix ?? ''}`;
    } catch { /* optional */ }

    return { stats: out, charts: {}, version };
  },
};
