// Audiobookshelf — libraries, users and open playback sessions.
// Auth: server API key (Bearer) preferred, else username/password login.
const tokenCache = new Map(); // service id -> { token, expiresAt }
const TOKEN_TTL = 60 * 60 * 1000;

function bearerFor(ctx, token) {
  return `Bearer ${token ?? ctx.apiKey ?? ''}`;
}

async function login(ctx) {
  const res = await ctx.api('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ctx.username, password: ctx.password }),
    timeoutMs: 12000,
  });
  const token = res.json?.user?.token;
  if (!token) throw new Error('Login succeeded but no token returned');
  return token;
}

// Reuse the bearer token between polls instead of logging in every cycle.
async function tokenFor(ctx) {
  if (ctx.apiKey) return null;
  const cached = tokenCache.get(ctx.id);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const token = await login(ctx);
  tokenCache.set(ctx.id, { token, expiresAt: Date.now() + TOKEN_TTL });
  return token;
}

async function authed(ctx, path, token) {
  try {
    const res = await ctx.api(path, { headers: { Authorization: bearerFor(ctx, token) }, timeoutMs: 12000 });
    return res.json;
  } catch (err) {
    if (!ctx.apiKey && /HTTP 401/.test(err.message)) {
      // token expired / server restarted — log in once more and retry
      tokenCache.delete(ctx.id);
      const fresh = await login(ctx);
      tokenCache.set(ctx.id, { token: fresh, expiresAt: Date.now() + TOKEN_TTL });
      const res = await ctx.api(path, { headers: { Authorization: bearerFor(ctx, fresh) }, timeoutMs: 12000 });
      return res.json;
    }
    throw err;
  }
}

function toTime(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function openSessions(ctx, token) {
  try {
    // /api/sessions returns paginated *history* — every book ever started.
    // /api/sessions/open is the live list.
    const open = await authed(ctx, '/api/sessions/open', token);
    return Array.isArray(open?.sessions) ? open.sessions : [];
  } catch {
    // Older ABS versions: fall back to the history endpoint but keep only
    // sessions updated in the last five minutes.
    const history = await authed(ctx, '/api/sessions', token);
    const all = Array.isArray(history) ? history : (Array.isArray(history?.sessions) ? history.sessions : []);
    const cutoff = Date.now() - 5 * 60 * 1000;
    return all.filter((session) => {
      const at = toTime(session.updatedAt);
      return !at || at >= cutoff;
    });
  }
}

export default {
  reset(id) { tokenCache.delete(id); },

  async test(ctx) {
    if (!ctx.base) return { ok: false, message: 'URL is required' };
    if (!ctx.apiKey && !(ctx.username && ctx.password)) {
      return { ok: false, message: 'API key or username + password required' };
    }
    try {
      const token = ctx.apiKey ? null : await login(ctx);
      const libs = await authed(ctx, '/api/libraries', token);
      const n = Array.isArray(libs?.libraries) ? libs.libraries.length : 0;
      return { ok: true, message: `Connected — ${n} libraries` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  },

  async poll(ctx) {
    const token = await tokenFor(ctx);

    const libsRes = await authed(ctx, '/api/libraries', token);
    const libraries = Array.isArray(libsRes?.libraries) ? libsRes.libraries : [];

    let users = [];
    try {
      const u = await authed(ctx, '/api/users', token);
      users = Array.isArray(u?.users) ? u.users : (Array.isArray(u) ? u : []);
    } catch { users = []; }

    // open sessions (admin only endpoint) — never the paginated history
    const sessions = await openSessions(ctx, token).catch(() => []);

    const usersById = new Map(users.map((u) => [u.id, u.username || u.name || 'User']));
    const nowPlaying = sessions.slice(0, 20).map((s, i) => {
      const item = s.libraryItem || s.book || {};
      const meta = item.media?.metadata || s.mediaMetadata || {};
      const author = meta.authorName || meta.author || s.displayAuthor || (s.mediaType === 'podcast' ? 'Podcast' : '');
      const title = meta.title || s.displayTitle || item.title || 'Listening';
      const pos = Number(s.currentTime || 0);
      const dur = Number(s.duration || 0);
      const itemId = s.libraryItemId || s.extraData?.libraryItemId || item.id;
      const updatedAt = toTime(s.updatedAt);
      // ABS does not store a paused flag. Paused clients stop syncing, so a
      // session whose last update is older than ~20s is treated as paused.
      const paused = updatedAt > 0 && Date.now() - updatedAt > 20_000;
      return {
        id: s.id ?? i,
        user: usersById.get(s.userId) || s.userId || 'User',
        title,
        subtitle: author,
        art: itemId ? `/api/items/${itemId}/cover?width=400` : '',
        position: Math.round(pos),
        positionMs: Math.round(pos * 1000),
        positionAt: updatedAt || Date.now(),
        playbackRate: paused ? 0 : 1,
        paused,
        duration: Math.round(dur),
        progress: dur > 0 ? Math.min(100, Math.round((pos / dur) * 100)) : 0,
        device: s.deviceInfo?.client || s.deviceInfo?.name || '',
      };
    });

    const stats = [
      { label: 'Libraries', value: libraries.length },
      { label: 'Users', value: users.length },
    ];
    if (nowPlaying.length) {
      const active = nowPlaying.filter((entry) => !entry.paused).length;
      stats.unshift({ label: 'Listening', value: active, emphasis: active > 0 });
    }
    // total items if the server provides per-library stats
    const totalItems = libraries.reduce((acc, l) => acc + Number(l.stats?.totalItems ?? 0), 0);
    if (totalItems) stats.push({ label: 'Items', value: totalItems });

    return { stats, nowPlaying, charts: {} };
  },
};
