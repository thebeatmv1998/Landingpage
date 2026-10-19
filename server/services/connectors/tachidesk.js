// Suwayomi (Tachidesk) — since Suwayomi 2.x the REST API (/api/v1) is gone and
// everything runs over GraphQL at /api/graphql. We use GraphQL first and fall
// back to the legacy REST API for very old servers. Optional basic auth.

async function headers(ctx) {
  const h = { Accept: 'application/json' };
  const basic = ctx.basicHeader();
  if (basic) h['Authorization'] = basic;
  return h;
}

async function gql(ctx, query) {
  const res = await ctx.api('/api/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await headers(ctx)) },
    body: JSON.stringify({ query }),
    timeoutMs: 15000,
  });
  const j = res.json;
  if (j?.errors?.length) throw new Error(j.errors[0]?.message || 'GraphQL error');
  if (!j?.data) throw new Error('GraphQL returned no data');
  return j.data;
}

function numList(payload) {
  // handles both relay-ish {nodes:[...]} and plain [...] shapes
  const list = Array.isArray(payload) ? payload : (Array.isArray(payload?.nodes) ? payload.nodes : null);
  return list || [];
}

// A capped page keeps one request but avoids transferring a huge library every poll.
// Libraries larger than this show approximate sums (prefixed with "~").
const LIBRARY_PAGE = 2000;

const MANGA_QUERIES = [
  `query { mangas(condition: { inLibrary: true }, first: ${LIBRARY_PAGE}) { totalCount nodes { id title unreadCount downloadCount } } }`,
  `query { mangas(condition: { inLibrary: true }, first: ${LIBRARY_PAGE}) { totalCount id title unreadCount downloadCount } }`,
  `query { libraryMangas { id title unreadCount downloadCount } }`,
];

const CATEGORY_QUERIES = [
  `query { categories { totalCount nodes { id name } } }`,
  `query { categories { totalCount id name } }`,
  `query { categories { id name } }`,
];

async function tryQueries(ctx, queries, pick) {
  let lastErr = null;
  for (const q of queries) {
    try {
      const data = await gql(ctx, q);
      const value = pick(data);
      if (value !== undefined && value !== null) return value;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('No compatible GraphQL query');
}

async function pollViaGraphQL(ctx) {
  const mangasData = await tryQueries(ctx, MANGA_QUERIES, (d) => d.mangas ?? d.libraryMangas);
  const manga = numList(mangasData);
  let categories = [];
  try {
    const catData = await tryQueries(ctx, CATEGORY_QUERIES, (d) => d.categories);
    categories = numList(catData);
  } catch { categories = []; }

  const unread = manga.reduce((acc, m) => acc + Number(m?.unreadCount ?? 0), 0);
  const downloads = manga.reduce((acc, m) => acc + Number(m?.downloadCount ?? 0), 0);
  const total = Number(mangasData?.totalCount ?? manga.length);
  const approximate = Number.isFinite(total) && total > manga.length;
  const sum = (n) => (approximate ? `~${n}` : n);

  const stats = [
    { label: 'Manga', value: total, emphasis: manga.length > 0 },
    { label: 'Categories', value: categories.length },
  ];
  if (unread) stats.push({ label: 'Unread', value: sum(unread), emphasis: true });
  if (downloads) stats.push({ label: 'Downloaded', value: sum(downloads) });

  return { stats };
}

async function pollViaRest(ctx) {
  const [categories, library] = await Promise.all([
    ctx.api('/api/v1/category', { headers: await headers(ctx), timeoutMs: 15000 }).then((r) => r.json).catch(() => []),
    ctx.api('/api/v1/library', { headers: await headers(ctx), timeoutMs: 15000 }).then((r) => r.json).catch(() => []),
  ]);
  const manga = Array.isArray(library) ? library : (Array.isArray(library?.library) ? library.library : []);
  const cats = Array.isArray(categories) ? categories : [];
  const unread = manga.reduce((acc, m) => acc + Number(m?.unreadCount ?? m?.unread ?? 0), 0);
  const downloads = manga.reduce((acc, m) => acc + Number(m?.downloadCount ?? 0), 0);

  const stats = [
    { label: 'Manga', value: manga.length, emphasis: manga.length > 0 },
    { label: 'Categories', value: cats.length },
  ];
  if (unread) stats.push({ label: 'Unread', value: unread, emphasis: true });
  if (downloads) stats.push({ label: 'Downloaded', value: downloads });

  return { stats };
}

export default {
  async test(ctx) {
    if (!ctx.base) return { ok: false, message: 'URL is required' };
    try {
      // introspection works on every GraphQL server — proves the endpoint + auth
      await gql(ctx, `query { __schema { queryType { name } } }`);
      return { ok: true, message: 'Connected to Suwayomi server (GraphQL API)' };
    } catch (err) {
      try {
        await ctx.api('/api/v1/settings', { headers: await headers(ctx), timeoutMs: 15000 });
        return { ok: true, message: 'Connected to Suwayomi server (legacy REST API)' };
      } catch (err2) {
        return { ok: false, message: `GraphQL: ${err.message} / REST: ${err2.message}` };
      }
    }
  },

  async poll(ctx) {
    try {
      return await pollViaGraphQL(ctx);
    } catch (gqlErr) {
      try {
        return await pollViaRest(ctx);
      } catch { throw gqlErr; }
    }
  },
};
