// Jellyfin — media server with live "now playing" via /Sessions.
// Jellyfin 10.12+ ("Jellyfin 12") disables legacy authentication (X-Emby-Token /
// api_key query parameter) by default, so we send the canonical
// `Authorization: MediaBrowser Token="..."` header and keep the legacy header
// for older servers (both accepted).

function authHeaders(ctx) {
  const h = {};
  if (ctx.apiKey) {
    h['Authorization'] = `MediaBrowser Client="HomeDeck", Device="HomeDeck Dashboard", DeviceId="homedeck-${ctx.id}", Version="1.0.0", Token="${ctx.apiKey}"`;
    h['X-Emby-Token'] = ctx.apiKey;
  }
  return h;
}

function apiHeaders(ctx) {
  return { Accept: 'application/json', ...authHeaders(ctx) };
}

async function api(ctx, path) {
  const res = await ctx.api(path, { headers: apiHeaders(ctx), timeoutMs: 12000 });
  return res.json;
}

// /System/Info needs auth and its availability has shifted across versions —
// the always-public /System/Info/Public carries the same name/version.
async function serverIdentity(ctx) {
  try {
    const info = await api(ctx, '/System/Info');
    if (info?.ServerName || info?.Version) return info;
  } catch { /* fall through to public */ }
  return api(ctx, '/System/Info/Public');
}

const KEY_HELP = 'Jellyfin Dashboard → Network → API Keys';

export default {
  async test(ctx) {
    if (!ctx.base) return { ok: false, message: 'URL is required' };
    if (!ctx.apiKey) return { ok: false, message: 'API key is required (Dashboard → API Keys)' };

    let pub;
    try {
      pub = await api(ctx, '/System/Info/Public');
      if (!pub?.ProductName && !pub?.ServerName) {
        return { ok: false, message: 'Something answered, but it does not look like Jellyfin — check the URL/port' };
      }
    } catch (err) {
      return {
        ok: false,
        message: `No Jellyfin at this URL (${err.message}) — check the port (Jellyfin default: 8096) or append the base URL if one is configured in Jellyfin`,
      };
    }

    try {
      const info = await api(ctx, '/System/Info');
      return { ok: true, message: `Connected to ${info?.ServerName || pub.ServerName || 'Jellyfin'} v${info?.Version || pub.Version || '?'}` };
    } catch (err) {
      if (/HTTP 401/.test(err.message)) {
        return { ok: false, message: `Jellyfin found, but the API key is invalid — ${KEY_HELP}` };
      }
      // /System/Info may be gone/reshaped on this Jellyfin version — verify the key with another endpoint
      try {
        await api(ctx, '/Items/Counts');
        return { ok: true, message: `Connected to ${pub.ServerName || 'Jellyfin'} v${pub.Version || '?'}` };
      } catch (err2) {
        if (/HTTP 401/.test(err2.message)) {
          return { ok: false, message: `Jellyfin found, but the API key is invalid — ${KEY_HELP}` };
        }
        return { ok: false, message: `Jellyfin reachable, but its API endpoints did not answer (${err.message} / ${err2.message})` };
      }
    }
  },

  // Remote control for active Jellyfin sessions (pause/resume/stop).
  async action(ctx, { action, value } = {}) {
    const cmd = { pause: 'Pause', resume: 'Unpause', stop: 'Stop' }[action];
    if (!cmd) return { ok: false, message: `Unknown action "${action}"` };
    if (!value) return { ok: false, message: 'Missing session id' };
    try {
      const res = await ctx.text(`/Sessions/${encodeURIComponent(String(value))}/Playing/${cmd}`, {
        method: 'POST',
        headers: apiHeaders(ctx),
        timeoutMs: 10000,
      });
      if (!res.ok) return { ok: false, message: `Jellyfin returned HTTP ${res.status}` };
      return {
        ok: true,
        message: action === 'pause' ? 'Playback paused' : action === 'resume' ? 'Playback resumed' : 'Playback stopped',
      };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  },

  async poll(ctx) {
    const info = await serverIdentity(ctx).catch(() => ({}));
    let counts = {};
    try { counts = await api(ctx, '/Items/Counts') || {}; } catch { counts = {}; }
    let libraries = [];
    try {
      const mf = await api(ctx, '/Library/MediaFolders');
      libraries = (mf?.Items || []).filter((i) => i.CollectionType);
    } catch { libraries = []; }

    // Active sessions → now playing
    let sessions = [];
    try { sessions = await api(ctx, '/Sessions?activeWithinSeconds=300') || []; } catch { sessions = []; }
    const nowPlaying = (Array.isArray(sessions) ? sessions : [])
      .filter((s) => s.NowPlayingItem)
      .map((s) => {
        const item = s.NowPlayingItem;
        const pos = ticksToSec(s.PlayState?.PositionTicks);
        const dur = ticksToSec(item.RunTimeTicks);
        const tag = item.ImageTags?.Primary || '';
        const art = `/Items/${item.Id}/Images/Primary?maxWidth=480&quality=85${tag ? `&tag=${tag}` : ''}`;
        const seriesEp = item.Type === 'Episode' && item.SeriesName
          ? `${item.SeriesName} · S${String(item.ParentIndexNumber ?? 0).padStart(2, '0')}E${String(item.IndexNumber ?? 0).padStart(2, '0')}`
          : '';
        const tc = s.TranscodingInfo || s.PlayState?.TranscodingInfo || null;
        const transcoding = tc ? {
          // Jellyfin reports direct play as the absence of transcoding per stream
          video: tc.IsVideoDirect === false ? `transcode → ${tc.VideoCodec || 'video'}` : 'direct',
          audio: tc.IsAudioDirect === false ? `transcode → ${tc.AudioCodec || 'audio'}` : 'direct',
          bitrate: Number(tc.Bitrate) || null,
        } : null;
        return {
          id: s.Id || '',
          paused: !!s.PlayState?.IsPaused,
          user: s.UserName || 'Unknown',
          title: item.Name || 'Unknown',
          subtitle: seriesEp || (item.Type === 'Movie' ? 'Movie' : item.Type || ''),
          art,
          position: Math.round(pos),
          duration: Math.round(dur),
          positionAt: Date.now(),
          progress: dur > 0 ? Math.min(100, Math.round((pos / dur) * 100)) : 0,
          transcoding,
          device: s.DeviceName || '',
          controls: ['pause', 'resume', 'stop'],
        };
      });

    const stats = [
      { label: 'Movies', value: counts.MovieCount ?? '–' },
      { label: 'Series', value: counts.SeriesCount ?? '–' },
      { label: 'Episodes', value: counts.EpisodeCount ?? '–' },
      { label: 'Songs', value: counts.SongCount ?? '–' },
    ];
    if (nowPlaying.length) stats.unshift({ label: 'Playing now', value: nowPlaying.length, emphasis: true });

    return {
      stats,
      nowPlaying,
      version: info?.Version || '',
      serverName: info?.ServerName || '',
      charts: {},
    };
  },
};

function ticksToSec(t) { return Math.max(0, Number(t || 0) / 10_000_000); }
