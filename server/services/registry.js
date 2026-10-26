// Registry of all supported service types.
// This drives: the admin "add service" gallery, the settings form fields,
// default poll intervals, categories and dashboard icons.

const F = {
  apiKey: (extra = {}) => ({ key: 'api_key', label: 'API key', type: 'password', required: false, ...extra }),
  username: (extra = {}) => ({ key: 'username', label: 'Username', type: 'text', required: false, ...extra }),
  password: (extra = {}) => ({ key: 'password', label: 'Password', type: 'password', required: false, ...extra }),
};

export const CATEGORIES = ['Automation', 'Media', 'Downloads', 'Reading', 'Cloud & Files', 'Network', 'Photos', 'Security', 'System', 'Other'];

export const registry = [
  {
    type: 'sonarr', label: 'Sonarr', blurb: 'TV show automation — queue, missing episodes, disk space, calendar',
    category: 'Automation', color: '#00a2e7', glyph: 'tv', apiBase: '/api/v3', pollMs: 15000,
    fields: [F.apiKey({ required: true })],
  },
  {
    type: 'radarr', label: 'Radarr', blurb: 'Movie automation — queue, missing movies, disk space, calendar',
    category: 'Automation', color: '#fcb425', glyph: 'film', apiBase: '/api/v3', pollMs: 15000,
    fields: [F.apiKey({ required: true })],
  },
  {
    type: 'lidarr', label: 'Lidarr', blurb: 'Music automation — albums, missing tracks, queue',
    category: 'Automation', color: '#f79c1d', glyph: 'music', apiBase: '/api/v1', pollMs: 15000,
    fields: [F.apiKey({ required: true })],
  },
  {
    type: 'prowlarr', label: 'Prowlarr', blurb: 'Indexer manager — enabled indexers, query & grab statistics',
    category: 'Automation', color: '#d97706', glyph: 'search', apiBase: '/api/v1', pollMs: 30000,
    fields: [F.apiKey({ required: true })],
  },
  {
    type: 'nzbhydra', label: 'NZBHydra 2', blurb: 'Usenet meta search — indexer status and API stats',
    category: 'Automation', color: '#10b981', glyph: 'search', pollMs: 60000,
    fields: [F.apiKey({ required: true })],
  },
  {
    type: 'sabnzbd', label: 'SABnzbd', blurb: 'Usenet downloader — live queue, speed and history',
    category: 'Downloads', color: '#7c3aed', glyph: 'download', pollMs: 5000,
    fields: [F.apiKey({ required: true })],
  },
  {
    type: 'jellyfin', label: 'Jellyfin', blurb: 'Media server — library counts and live "now playing" streams',
    category: 'Media', color: '#882cb3', glyph: 'play', pollMs: 8000,
    fields: [F.apiKey({ required: true, help: 'Dashboard → Settings → API Keys' })],
  },
  {
    type: 'audiobookshelf', label: 'Audiobookshelf', blurb: 'Audiobook & podcast server — libraries, users, active sessions',
    category: 'Media', color: '#c19d56', glyph: 'book', pollMs: 15000,
    fields: [F.apiKey({ help: 'Server API key (or use username/password below)' }), F.username(), F.password()],
  },
  {
    type: 'seerr', label: 'Seerr', blurb: 'Media requests — the unified Overseerr/Jellyseerr successor (Plex, Jellyfin & Emby)',
    category: 'Media', color: '#5b8cff', glyph: 'film', icon: '/icons/seerr.webp', pollMs: 60000,
    fields: [F.apiKey({ required: true, help: 'Seerr → Settings → General → API Key' })],
  },
  {
    type: 'overseerr', label: 'Overseerr (legacy)', blurb: 'Deprecated — use Seerr for new installs',
    category: 'Media', color: '#e5a00d', glyph: 'film', icon: '/icons/overseerr.webp', pollMs: 60000,
    hidden: true,
    fields: [F.apiKey({ required: true, help: 'Overseerr → Settings → General → API Key' })],
  },
  {
    type: 'jellyseerr', label: 'Jellyseerr (legacy)', blurb: 'Deprecated — use Seerr for new installs',
    category: 'Media', color: '#8b5cf6', glyph: 'tv', icon: '/icons/jellyseerr.webp', pollMs: 60000,
    hidden: true,
    fields: [F.apiKey({ required: true, help: 'Jellyseerr → Settings → General → API Key' })],
  },
  {
    type: 'navidrome', label: 'Navidrome', blurb: 'Music server — live sessions from Feishin/Symfonium, library stats, cover art',
    category: 'Media', color: '#1e90ff', glyph: 'music', pollMs: 15000,
    fields: [
      F.username({ required: true, label: 'Navidrome username', help: 'Use an admin account to see sessions from other players (Feishin, Symfonium, web player, …)' }),
      F.password({ required: true, label: 'Navidrome password' }),
    ],
  },
  {
    type: 'nextcloud', label: 'Nextcloud', blurb: 'Files & collaboration — storage, users, shares, CPU & memory',
    category: 'Cloud & Files', color: '#0082c9', glyph: 'cloud', pollMs: 60000,
    fields: [F.username({ required: true }), F.password({ required: true, label: 'Password / app password' })],
  },
  {
    type: 'pihole', label: 'Pi-hole', blurb: 'Network ad blocking — live query stats and 24h graph (v5 & v6)',
    category: 'Network', color: '#96060c', glyph: 'shield', pollMs: 10000,
    fields: [F.password({ help: 'v6 API password. v5: web interface password (api.php auth token)' })],
  },
  {
    type: 'immich', label: 'Immich', blurb: 'Photo library — photos, videos and storage usage',
    category: 'Photos', color: '#4250af', glyph: 'image', pollMs: 120000,
    fields: [F.apiKey({ required: true })],
  },
  {
    type: 'komga', label: 'Komga', blurb: 'Comics & manga server — libraries, series and books',
    category: 'Reading', color: '#16a34a', glyph: 'book', pollMs: 120000,
    fields: [
      F.apiKey({ help: 'Komga → user settings → API keys (recommended). Alternatively use username/password below.' }),
      F.username(),
      F.password(),
    ],
  },
  {
    type: 'pingvin', label: 'Pingvin Share', blurb: 'File sharing — active shares overview',
    category: 'Cloud & Files', color: '#f43f5e', glyph: 'share', pollMs: 120000,
    fields: [F.username({ required: true, label: 'Email' }), F.password({ required: true })],
  },
  {
    type: 'stash', label: 'Stash', blurb: 'Media organizer — scenes, performers, play stats',
    category: 'Media', color: '#e11d48', glyph: 'film', pollMs: 120000,
    fields: [F.apiKey({ help: 'API key from Settings → Security (leave empty if none)' })],
  },
  {
    type: 'tachidesk', label: 'Tachidesk / Suwayomi', blurb: 'Manga server — library, categories, unread counts',
    category: 'Reading', color: '#0ea5e9', glyph: 'book', pollMs: 120000,
    fields: [F.username({ help: 'Only if basic auth is enabled' }), F.password()],
  },
  {
    type: 'vaultwarden', label: 'Vaultwarden', blurb: 'Password manager — status and user count',
    category: 'Security', color: '#175ddc', glyph: 'key', pollMs: 120000,
    fields: [F.apiKey({ help: 'Optional ADMIN_TOKEN to show user count' })],
  },
  {
    type: 'docker', label: 'Docker', blurb: 'Container engine — container states via the Docker socket',
    category: 'System', color: '#1d63ed', glyph: 'cube', pollMs: 20000,
    fields: [{
      key: 'extra.socketPath', label: 'Docker socket path', type: 'text', required: false,
      placeholder: '/var/run/docker.sock or npipe:////./pipe/docker_engine',
    }],
  },
  {
    type: 'unraid', label: 'Unraid Server', blurb: 'CPU, uptime, array & disk temperatures via the Unraid 7 GraphQL API',
    category: 'System', color: '#f15a2c', glyph: 'cube', pollMs: 30000,
    fields: [F.apiKey({ required: true, help: 'Unraid: Settings → Management Access → API Keys. Also enable the sandbox: Settings → Developer Options or `unraid-api developer --sandbox true`' })],
  },
  {
    type: 'generic', label: 'Generic service', blurb: 'Any self-hosted app — up/down check + response time',
    category: 'Other', color: '#64748b', glyph: 'globe', pollMs: 60000,
    fields: [
      { key: 'extra.checkPath', label: 'Check path', type: 'text', placeholder: '/', required: false },
      F.apiKey({ label: 'Bearer token (optional)' }),
    ],
  },
];

export const registryByType = Object.fromEntries(registry.map((r) => [r.type, r]));

// Bundled service icons (WebP, from dashboard-icons.com) served from public/icons/.
// Types without a bundled icon keep their inline SVG glyph as the fallback, and a
// per-service "Icon URL" set in the admin UI always overrides this default.
const ICON_TYPES = new Set([
  'sonarr', 'radarr', 'lidarr', 'prowlarr', 'nzbhydra', 'sabnzbd', 'jellyfin', 'audiobookshelf', 'navidrome',
  'nextcloud', 'pihole', 'immich', 'komga', 'pingvin', 'stash', 'tachidesk', 'vaultwarden', 'docker', 'unraid',
]);
for (const entry of registry) {
  if (ICON_TYPES.has(entry.type)) entry.icon = `/icons/${entry.type}.webp`;
}

// Best-effort icon for Docker containers without a template icon: match the
// container name/image against the bundled dashboardicons (registry types).
export function bundledIconFor(name = '', image = '') {
  const n = String(name || '').toLowerCase();
  const img = String(image || '').toLowerCase();
  for (const r of registry) {
    if (!r.icon) continue;
    const key = r.type;
    const label = String(r.label || '').toLowerCase().replace(/\s+/g, '-');
    if (n === key || n.startsWith(`${key}-`) || n.startsWith(`${key}_`) || n.includes(key)) return r.icon;
    if (img.includes(`/${key}`) || img.includes(`-${key}`) || img.includes(`_${key}`)) return r.icon;
    if (label && (n.includes(label) || img.includes(label))) return r.icon;
  }
  return '';
}

export function serviceMeta(type) {
  return registryByType[type] || {
    type, label: type, blurb: 'Custom service', category: 'Other',
    color: '#64748b', glyph: 'globe', pollMs: 60000, fields: [],
  };
}
