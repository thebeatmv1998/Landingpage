// Navidrome — Subsonic API. Shows live sessions from Feishin, Symfonium, the
// web player, etc., plus library/scan statistics.
//
// Auth uses a Navidrome username + password. Use an admin account if you want
// to see sessions from other users/players (Navidrome only exposes all sessions
// to admins).
import { signSubsonic } from '../subsonic.js';

const statsCache = new Map(); // service id -> { stats, at }
const STATS_TTL = 5 * 60 * 1000;

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

async function subsonic(ctx, method, params = {}) {
  const path = signSubsonic(`/rest/${method}.view`, ctx.username, ctx.password, params);
  const res = await ctx.api(path, { timeoutMs: 12000 });
  const body = res.json?.['subsonic-response'];
  if (!body) throw new Error('Not a Navidrome/Subsonic response — check the URL');
  if (body.status !== 'ok') throw new Error(body.error?.message || `Subsonic error ${body.error?.code ?? ''}`);
  return body;
}

export default {
  reset(id) {
    statsCache.delete(id);
  },

  async test(ctx) {
    if (!ctx.base) return { ok: false, message: 'URL is required' };
    if (!ctx.username || !ctx.password) return { ok: false, message: 'Username and password are required' };
    try {
      const p = await subsonic(ctx, 'ping');
      return { ok: true, message: `Connected to Navidrome (Subsonic ${p.version || '?'})` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  },

  async poll(ctx) {
    const now = await subsonic(ctx, 'getNowPlaying');
    const entries = asArray(now.nowPlaying?.entry);
    const seenAt = Date.now();
    const nowPlaying = entries.slice(0, 20).map((e, i) => {
      const rawPositionMs = Number(e.positionMs);
      const rawPosition = Number(e.position);
      const positionMs = Number.isFinite(rawPositionMs)
        ? rawPositionMs
        : (Number.isFinite(rawPosition) ? rawPosition * 1000 : 0);
      const state = String(e.state || '').toLowerCase();
      const rawRate = Number(e.playbackRate);
      const paused = !!e.isPaused || state === 'paused' || state === 'stopped'
        || (Number.isFinite(rawRate) && rawRate === 0);
      const playbackRate = paused ? 0 : (Number.isFinite(rawRate) && rawRate > 0 ? rawRate : 1);
      const duration = Math.max(0, Number(e.duration || 0));
      return {
        id: `${e.id || 'track'}:${e.playerId ?? i}`,
        user: e.username || 'User',
        title: e.title || 'Unknown track',
        subtitle: [e.artist, e.album].filter(Boolean).join(' · '),
        art: e.coverArt ? `/rest/getCoverArt.view?id=${encodeURIComponent(e.coverArt)}` : '',
        position: Math.round(positionMs / 1000),
        positionMs: Math.round(positionMs),
        positionAt: seenAt,
        playbackRate,
        duration: Math.round(duration),
        progress: duration > 0 ? Math.min(100, Math.round((positionMs / 1000 / duration) * 100)) : 0,
        device: e.playerName || e.clientName || '',
        paused,
        state: state || (paused ? 'paused' : 'playing'),
      };
    });

    // Library stats are best-effort and change slowly — cache them for five
    // minutes so a 15 s now-playing poll doesn't re-index the whole library.
    let baseStats = [];
    const cached = statsCache.get(ctx.id);
    if (cached && Date.now() - cached.at < STATS_TTL) {
      baseStats = cached.stats;
    } else {
      const [scanRes, artistsRes, albumsRes, playlistsRes] = await Promise.allSettled([
        subsonic(ctx, 'getScanStatus'),
        subsonic(ctx, 'getArtists'),
        subsonic(ctx, 'getAlbumList2', { type: 'alphabeticalByArtist', size: '500', offset: '0' }),
        subsonic(ctx, 'getPlaylists'),
      ]);

      if (scanRes.status === 'fulfilled') {
        const count = Number(scanRes.value.scanStatus?.count);
        if (Number.isFinite(count) && count > 0) baseStats.push({ label: 'Songs', value: count });
      }
      if (artistsRes.status === 'fulfilled') {
        const indexes = asArray(artistsRes.value.artists?.index);
        const count = indexes.reduce((sum, index) => sum + asArray(index?.artist).length, 0);
        if (count > 0) baseStats.push({ label: 'Artists', value: count });
      }
      if (albumsRes.status === 'fulfilled') {
        const albums = asArray(albumsRes.value.albumList2?.album);
        if (albums.length) baseStats.push({ label: 'Albums', value: albums.length >= 500 ? '500+' : albums.length });
      }
      if (playlistsRes.status === 'fulfilled') {
        const playlists = asArray(playlistsRes.value.playlists?.playlist);
        if (playlists.length) baseStats.push({ label: 'Playlists', value: playlists.length });
      }
      statsCache.set(ctx.id, { stats: baseStats, at: Date.now() });
    }

    const stats = [];
    const playingCount = nowPlaying.filter((entry) => !entry.paused).length;
    if (playingCount) stats.push({ label: 'Playing', value: playingCount, emphasis: true });
    stats.push(...baseStats);

    return { stats, nowPlaying, charts: {} };
  },
};
