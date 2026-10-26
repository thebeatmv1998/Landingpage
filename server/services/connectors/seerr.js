// Seerr request connector, with compatibility for legacy Overseerr/Jellyseerr
// installations. They share the same /api/v1 request API and X-Api-Key auth.
const API = '/api/v1';
const TMDB_IMAGE = 'https://image.tmdb.org/t/p/w342';
const DETAILS_TTL = 30 * 60 * 1000;
const DETAILS_MAX = 500;
const detailsCache = new Map(); // "movie:tmdbId" / "tv:tmdbId" -> { data, expiresAt }

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

async function mediaDetails(ctx, media, headers) {
  const type = media?.mediaType;
  const id = media?.tmdbId;
  if (!['movie', 'tv'].includes(type) || !id) return {};
  const key = `${type}:${id}`;
  const cached = detailsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  try {
    const data = await api(ctx, `/${type}/${encodeURIComponent(String(id))}`, { headers, timeoutMs: 10000 }) || {};
    const out = {
      title: data.title || data.name || '',
      posterPath: data.posterPath || '',
      date: data.releaseDate || data.firstAirDate || '',
    };
    while (detailsCache.size >= DETAILS_MAX) {
      const oldest = detailsCache.keys().next().value;
      if (!oldest) break;
      detailsCache.delete(oldest);
    }
    detailsCache.set(key, { data: out, expiresAt: Date.now() + DETAILS_TTL });
    return out;
  } catch {
    return {};
  }
}

function authHeaders(ctx) {
  return { Accept: 'application/json', 'X-Api-Key': ctx.apiKey || '' };
}

async function api(ctx, path, opts = {}) {
  const res = await ctx.api(API + path, { ...opts, headers: { ...authHeaders(ctx), ...(opts.headers || {}) }, timeoutMs: opts.timeoutMs || 12000 });
  return res.json;
}

function pageCount(page) {
  const n = Number(page?.pageInfo?.results ?? page?.pageInfo?.total);
  if (Number.isFinite(n) && n >= 0) return n;
  return Array.isArray(page?.results) ? page.results.length : 0;
}

function normalizeStatus(request) {
  const media = request?.media || {};
  const mediaStatus = String(media.status ?? '').toUpperCase();
  if (mediaStatus === 'AVAILABLE' || Number(media.status) === 5) return 'available';
  const raw = String(request?.status ?? '').toUpperCase();
  const byNumber = { 1: 'pending', 2: 'approved', 3: 'declined', 4: 'failed', 5: 'available' };
  const byName = { PENDING: 'pending', APPROVED: 'approved', DECLINED: 'declined', FAILED: 'failed', COMPLETED: 'available' };
  return byName[raw] || byNumber[Number(request?.status)] || String(request?.status || 'unknown').toLowerCase();
}

function statusLabel(status) {
  return {
    pending: 'Pending', approved: 'Approved', available: 'Available',
    declined: 'Declined', failed: 'Failed', processing: 'Processing',
  }[status] || 'Unknown';
}

function filterForStatus(status) {
  if (status === 'pending' || status === 'approved' || status === 'available') return status;
  if (status === 'declined' || status === 'failed') return 'all';
  return 'all';
}

function mapRequest(r, details = {}) {
  const media = r?.media || {};
  const requester = r?.requestedBy || {};
  const rawPoster = String(media.posterPath || media.poster_path || details.posterPath || '').trim();
  const poster = rawPoster
    ? (/^https?:\/\//i.test(rawPoster) ? rawPoster : TMDB_IMAGE + (rawPoster.startsWith('/') ? rawPoster : '/' + rawPoster))
    : '';
  const date = media.releaseDate || media.firstAirDate || details.date || '';
  const year = String(date).slice(0, 4);
  const kind = media.mediaType === 'movie' ? 'Movie' : media.mediaType === 'tv' ? 'TV' : '';
  const status = normalizeStatus(r);
  return {
    id: r?.id ?? '',
    status,
    statusLabel: statusLabel(status),
    title: media.title || media.name || details.title || media.originalTitle || media.originalName || 'Unknown title',
    subtitle: [kind, year].filter(Boolean).join(' · '),
    user: requester.displayName || requester.username || requester.email || 'Unknown user',
    poster,
    type: media.mediaType || '',
    filter: filterForStatus(status),
  };
}

export default {
  async test(ctx) {
    if (!ctx.base) return { ok: false, message: 'URL is required' };
    if (!ctx.apiKey) return { ok: false, message: 'API key is required (Overseerr/Jellyseerr → Settings → API Key)' };
    const label = ctx.type === 'seerr' ? 'Seerr' : ctx.type === 'jellyseerr' ? 'Jellyseerr' : 'Overseerr';
    let version = '';
    try {
      const status = await api(ctx, '/status', { timeoutMs: 10000 });
      version = status?.version || status?.commitTag || '';
    } catch { /* status endpoint is optional; the request call proves auth */ }
    try {
      const page = await api(ctx, '/request?take=1&skip=0&filter=all&sort=added&sortDirection=desc', { timeoutMs: 10000 });
      const total = pageCount(page);
      return { ok: true, message: `Connected to ${label}${version ? ' v' + version : ''} — ${total} request${total === 1 ? '' : 's'}` };
    } catch (err) {
      const msg = /HTTP 401|HTTP 403/i.test(err.message) ? 'API key rejected' : err.message;
      return { ok: false, message: msg };
    }
  },

  async action(ctx, { action, value } = {}) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) return { ok: false, message: 'Invalid request id' };
    const verb = action === 'approve_request' ? 'approve' : action === 'decline_request' ? 'decline' : '';
    if (!verb) return { ok: false, message: `Unknown action "${action}"` };
    try {
      await api(ctx, `/request/${id}/${verb}`, { method: 'POST', timeoutMs: 15000 });
      return { ok: true, message: verb === 'approve' ? 'Request approved' : 'Request declined' };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  },

  async poll(ctx) {
    const headers = authHeaders(ctx);
    const recentQuery = '/request?take=20&skip=0&filter=all&sort=added&sortDirection=desc';
    const countQuery = (filter) => `/request?take=1&skip=0&filter=${filter}&sort=added&sortDirection=desc`;
    const [recent, pending, approved, available] = await Promise.all([
      api(ctx, recentQuery, { headers }),
      api(ctx, countQuery('pending'), { headers }).catch(() => null),
      api(ctx, countQuery('approved'), { headers }).catch(() => null),
      api(ctx, countQuery('available'), { headers }).catch(() => null),
    ]);
    const results = Array.isArray(recent?.results) ? recent.results : [];
    // Media lists often contain only tmdbId/mediaType, not titles or posters.
    // Resolve details lazily (cached, limited concurrency) so the UI shows the
    // actual movie/show name instead of "Request #123".
    const requests = await mapLimit(results, 4, async (r) => {
      const media = r?.media || {};
      const needsDetails = (!media.title && !media.name) || !media.posterPath
        || (!media.releaseDate && !media.firstAirDate);
      const details = needsDetails ? await mediaDetails(ctx, media, headers) : {};
      return mapRequest(r, details);
    });
    const counts = {
      open: pageCount(pending),
      approved: pageCount(approved),
      available: pageCount(available),
    };
    const stats = [
      { label: 'Open', value: counts.open, tone: counts.open > 0 ? 'warn' : undefined, emphasis: counts.open > 0 },
      { label: 'Approved', value: counts.approved, tone: counts.approved > 0 ? 'good' : undefined },
      { label: 'Available', value: counts.available, tone: counts.available > 0 ? 'good' : undefined },
    ];
    return {
      stats,
      requests,
      requestCounts: counts,
      charts: { requests: counts },
    };
  },
};
