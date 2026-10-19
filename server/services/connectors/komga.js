// Komga — comics/manga server. Basic auth or API key (X-API-Key).

async function headers(ctx) {
  const h = { Accept: 'application/json' };
  const basic = ctx.basicHeader();
  if (basic) h['Authorization'] = basic;
  if (ctx.apiKey) h['X-API-Key'] = ctx.apiKey;
  return h;
}

async function api(ctx, path) {
  const res = await ctx.api(path, { headers: await headers(ctx), timeoutMs: 15000 });
  return res.json;
}

export default {
  async test(ctx) {
    if (!ctx.base) return { ok: false, message: 'URL is required' };
    if (!ctx.apiKey && !(ctx.username && ctx.password)) {
      return { ok: false, message: 'Username + password or API key required' };
    }
    try {
      const libs = await api(ctx, '/api/v1/libraries');
      return { ok: true, message: `Connected — ${Array.isArray(libs) ? libs.length : 0} libraries` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  },

  async poll(ctx) {
    const libraries = await api(ctx, '/api/v1/libraries').catch(() => []);
    const seriesPage = await api(ctx, '/api/v1/series?size=1').catch(() => null);
    const booksPage = await api(ctx, '/api/v1/books?size=1').catch(() => null);

    const stats = [
      { label: 'Libraries', value: Array.isArray(libraries) ? libraries.length : 0 },
      { label: 'Series', value: seriesPage?.totalElements ?? '–' },
      { label: 'Books', value: booksPage?.totalElements ?? '–' },
    ];

    return { stats, charts: {} };
  },
};
