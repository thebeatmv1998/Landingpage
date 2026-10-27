import { fmtBytes, fmtBytesSI, pct } from '../../core/util.js';

// Shared connector for Sonarr / Radarr / Lidarr (*arr family).
// kind: 'series' | 'movie' | 'album'   apiBase: '/api/v3' | '/api/v1'

function isoDate(d) { return d.toISOString().slice(0, 10); }

// *arr expose the per-item library size as statistics.sizeOnDisk (recent
// versions) or sizeOnDisk (older ones). Both are bytes.
function diskSize(item) {
  return Number(item?.statistics?.sizeOnDisk ?? item?.sizeOnDisk ?? 0) || 0;
}

async function api(ctx, apiBase, path, opts = {}) {
  const headers = { 'X-Api-Key': ctx.apiKey, Accept: 'application/json', ...(opts.headers || {}) };
  const res = await ctx.api(`${apiBase}${path}`, { ...opts, headers, timeoutMs: 12000 });
  return res.json;
}

async function poll(ctx, kind, apiBase) {
  if (!ctx.base) throw new Error('URL is not configured');
  if (!ctx.apiKey) throw new Error('API key is not configured');

  const status = await api(ctx, apiBase, '/system/status');
  let health = [];
  try { health = await api(ctx, apiBase, '/health'); } catch { health = []; }

  const queueRes = await api(ctx, apiBase, '/queue?pageSize=500').catch(() => ({ totalRecords: 0, records: [] }));
  const records = Array.isArray(queueRes?.records) ? queueRes.records : [];
  const activity = records.slice(0, 25).map((q, i) => {
    const size = Number(q.size || 0), left = Number(q.sizeleft || 0);
    const progress = q.progress != null ? Math.round(q.progress)
      : (size > 0 ? Math.round(((size - left) / size) * 100) : 0);
    return {
      id: q.id ?? i,
      title: q.title || q.sourceTitle || 'Download',
      subtitle: [q.status, q.quality?.quality?.name, q.indexer].filter(Boolean).join(' · ') || 'queued',
      progress: pct(progress, 100),
      state: q.trackedDownloadStatus === 'warning' ? 'warning' : 'active',
    };
  });

  // missing counts + entity lists (also used for calendar poster images)
  let missing = 0;
  let totals = { total: 0, monitored: 0 };
  let sizeOnDisk = 0;
  const posterById = new Map(); // seriesId / movieId / albumId -> poster url
  const titleById = new Map();  // seriesId -> series title (calendar events may omit it)
  const pickPoster = (images, coverType) => (images || []).find((i) => i.coverType === coverType)?.url || '';
  if (kind === 'series') {
    const w = await api(ctx, apiBase, '/wanted/missing?pageSize=1').catch(() => null);
    missing = w?.totalRecords ?? 0;
    const s = await api(ctx, apiBase, '/series').catch(() => []);
    totals.total = s.length;
    totals.monitored = s.filter((x) => x.monitored).length;
    for (const ser of s) {
      sizeOnDisk += diskSize(ser);
      posterById.set(ser.id, pickPoster(ser.images, 'poster'));
      titleById.set(ser.id, ser.title || '');
    }
  } else if (kind === 'movie') {
    const m = await api(ctx, apiBase, '/movie').catch(() => []);
    totals.total = m.length;
    totals.monitored = m.filter((x) => x.monitored).length;
    missing = m.filter((x) => x.monitored && !x.hasFile).length;
    for (const mov of m) { sizeOnDisk += diskSize(mov); posterById.set(mov.id, pickPoster(mov.images, 'poster')); }
  } else if (kind === 'album') {
    const a = await api(ctx, apiBase, '/album?monitored=true&pageSize=1000').catch(() => ({ records: [], totalRecords: 0 }));
    const albums = Array.isArray(a?.records) ? a.records : (Array.isArray(a) ? a : []);
    totals.total = a?.totalRecords ?? albums.length;
    totals.monitored = albums.filter((x) => x.monitored).length;
    missing = albums.filter((x) => x.monitored && x.statistics && x.statistics.trackFileCount === 0).length;
    for (const al of albums) { sizeOnDisk += diskSize(al); posterById.set(al.id, pickPoster(al.images, 'cover') || pickPoster(al.images, 'poster')); }
  }

  // disk space
  const disks = await api(ctx, apiBase, '/diskspace').catch(() => []);
  const diskList = (Array.isArray(disks) ? disks : [])
    .filter((d) => d.totalSpace > 0)
    .map((d) => ({
      label: d.label || d.path,
      usedGB: +((d.totalSpace - d.freeSpace) / 1e9).toFixed(1),
      freeGB: +(Number(d.freeSpace || 0) / 1e9).toFixed(1),
      totalGB: +(d.totalSpace / 1e9).toFixed(1),
    }));

  // upcoming calendar (7 days) — poster from the entity list map (works on every version)
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 8);
  const cal = await api(ctx, apiBase, `/calendar?start=${isoDate(start)}&end=${isoDate(end)}`).catch(() => []);
  const calendar = (Array.isArray(cal) ? cal : []).map((ev) => {
    const entityId = kind === 'series' ? ev.seriesId : ev.id;
    const entityImage = posterById.get(entityId) || '';
    const fallbackImage = kind === 'album'
      ? pickPoster(ev.images, 'cover') || pickPoster(ev.artist?.images, 'poster')
      : pickPoster(ev.series?.images, 'poster') || pickPoster(ev.images, 'poster');
    const source = entityImage || fallbackImage;
    // Serve the cover through the *arr API instead of the root /MediaCover path:
    // the API endpoint authenticates with X-Api-Key (the root path is behind form
    // login / a reverse proxy) and works with HomeDeck's image proxy.
    const localName = /\/MediaCover\/[^/]+\/([^/?#]+)$/i.exec(source || '')?.[1];
    const filename = localName || (kind === 'album' ? 'cover.jpg' : 'poster.jpg');
    const image = entityId ? `${apiBase}/mediacover/${entityId}/${filename}` : source;
    return {
      date: ev.airDateUtc || ev.releaseDateUtc || ev.releaseDate || null,
      title: kind === 'series'
        ? (ev.series?.title || titleById.get(ev.seriesId) || 'Episode')
        : kind === 'movie' ? (ev.title || 'Movie')
        : (ev.artist?.name || ev.title || 'Album'),
      subtitle: kind === 'series'
        ? `S${String(ev.seasonNumber ?? 0).padStart(2, '0')}E${String(ev.episodeNumber ?? 0).padStart(2, '0')}${ev.title ? ' · ' + ev.title : ''}`
        : kind === 'album' ? ev.title || '' : '',
      type: kind,
      image,
      hasFile: !!ev.hasFile,
      grabbed: !!ev.grabbed,
    };
  });

  const stats = [
    { label: kind === 'series' ? 'Series' : kind === 'movie' ? 'Movies' : 'Albums', value: totals.total },
    { label: 'Monitored', value: totals.monitored },
    { label: 'Missing', value: missing, emphasis: missing > 0 },
  ];
  if (sizeOnDisk > 0) stats.push({ label: 'On disk', value: fmtBytesSI(sizeOnDisk) });
  if (activity.length) stats.push({ label: 'In queue', value: queueRes.totalRecords ?? activity.length, emphasis: true });
  const healthIssues = Array.isArray(health) ? health.length : 0;
  if (healthIssues) stats.push({ label: 'Health issues', value: healthIssues, emphasis: true, tone: 'bad' });

  return {
    stats,
    activity,
    calendar,
    version: status?.version || '',
    charts: { disks: diskList },
  };
}

async function test(ctx, kind, apiBase) {
  if (!ctx.base) return { ok: false, message: 'URL is required' };
  if (!ctx.apiKey) return { ok: false, message: 'API key is required' };
  try {
    const s = await api(ctx, apiBase, '/system/status');
    return { ok: true, message: `Connected to ${s?.appName || kind} v${s?.version || '?'}` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

async function runAction(ctx, kind, apiBase, action) {
  if (!ctx.base) return { ok: false, message: 'URL is not configured' };
  if (!ctx.apiKey) return { ok: false, message: 'API key is not configured' };
  const commands = {
    series: { missing_search: 'MissingEpisodeSearch', refresh: 'RefreshSeries', rss_sync: 'RssSync' },
    movie: { missing_search: 'MissingMoviesSearch', refresh: 'RefreshMovie', rss_sync: 'RssSync' },
    album: { missing_search: 'MissingAlbumSearch', refresh: 'RefreshArtist', rss_sync: 'RssSync' },
  }[kind] || {};
  const command = commands[action];
  if (!command) return { ok: false, message: `Unknown action "${action}"` };
  try {
    await api(ctx, apiBase, '/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: command }),
    });
    const labels = {
      missing_search: 'Missing media search started',
      refresh: 'Library refresh started',
      rss_sync: 'RSS sync started',
    };
    return { ok: true, message: labels[action] };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

export function makeArrConnector(kind, apiBase) {
  return {
    async test(ctx) { return test(ctx, kind, apiBase); },
    async poll(ctx) { return poll(ctx, kind, apiBase); },
    async action(ctx, payload = {}) { return runAction(ctx, kind, apiBase, payload.action); },
  };
}
