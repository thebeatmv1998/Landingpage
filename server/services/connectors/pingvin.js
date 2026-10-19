// Pingvin Share — login session then list shares.
// v2 API: POST /api/auth/sessions {email,password} -> {accessToken}; fallback /api/auth/login.

async function login(ctx) {
  const body = JSON.stringify({ email: ctx.username, password: ctx.password });
  const headers = { 'Content-Type': 'application/json' };
  let res;
  try {
    res = await ctx.api('/api/auth/sessions', { method: 'POST', headers, body, timeoutMs: 12000 });
  } catch {
    res = await ctx.api('/api/auth/login', { method: 'POST', headers, body, timeoutMs: 12000 });
  }
  const token = res.json?.accessToken || res.json?.token || res.json?.session?.accessToken;
  if (!token) throw new Error('Login failed — no access token (check email/password)');
  return token;
}

const tokenCache = new Map(); // service id -> { token, expiresAt }
const TOKEN_TTL = 30 * 60 * 1000;

async function tokenFor(ctx) {
  const cached = tokenCache.get(ctx.id);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const token = await login(ctx);
  tokenCache.set(ctx.id, { token, expiresAt: Date.now() + TOKEN_TTL });
  return token;
}

async function fetchShares(ctx) {
  let token = await tokenFor(ctx);
  const get = () => ctx.api('/api/shares', { headers: { Authorization: `Bearer ${token}` }, timeoutMs: 12000 });
  try {
    return (await get()).json;
  } catch (err) {
    if (!/HTTP 401/.test(err.message)) throw err;
    tokenCache.delete(ctx.id);
    token = await login(ctx);
    tokenCache.set(ctx.id, { token, expiresAt: Date.now() + TOKEN_TTL });
    return (await get()).json;
  }
}

export default {
  reset(id) { tokenCache.delete(id); },

  async test(ctx) {
    if (!ctx.base) return { ok: false, message: 'URL is required' };
    if (!(ctx.username && ctx.password)) return { ok: false, message: 'Email and password required' };
    try {
      await login(ctx);
      return { ok: true, message: 'Connected to Pingvin Share' };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  },

  async poll(ctx) {
    const data = await fetchShares(ctx);
    let shares = data;
    if (shares && Array.isArray(shares.shares)) shares = shares.shares;
    if (!Array.isArray(shares)) shares = [];
    const now = Date.now();
    const active = shares.filter((s) => {
      const exp = s?.expiration ? Date.parse(s.expiration) : null;
      return exp == null || Number.isNaN(exp) || exp > now;
    });
    const totalVisits = shares.reduce((acc, s) => acc + Number(s?.visits ?? 0), 0);

    const stats = [
      { label: 'Active shares', value: active.length, emphasis: active.length > 0 },
      { label: 'Total shares', value: shares.length },
    ];
    if (totalVisits) stats.push({ label: 'Views', value: totalVisits });

    return { stats, charts: {} };
  },
};
