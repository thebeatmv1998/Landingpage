// Mock upstream services for testing connectors. Single express app, path-prefixed.
// Every service expects its own API key / credentials and returns 401 on mismatch.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = path.join(__dirname, '..', 'public', 'icons');

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_B64, 'base64');

const app = express();
app.use(express.json());
app.use(express.text({ type: ['text/*', 'application/graphql'] }));

// Serve the bundled icons so the mock Unraid can expose realistic iconUrls.
app.get('/icons/:file', (req, res) => {
  const file = path.basename(req.params.file);
  const full = path.join(ICONS_DIR, file);
  if (fs.existsSync(full)) return res.sendFile(full);
  return res.status(404).end();
});

function keyOk(req, keyName = 'X-Api-Key') {
  const k = req.get(keyName) || req.query.apikey || req.query.api_key;
  return k && k.startsWith('testkey-');
}
function basicOk(req, user, pass) {
  const h = req.get('Authorization') || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  return u === user && p === pass;
}
function need(res, ok, msg = 'bad credentials') {
  if (!ok) { res.status(401).json({ error: msg }); return false; }
  return true;
}

// ------------------------------------------------------------------ Sonarr
const SERIES = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, title: `Series ${i + 1}`, monitored: i < 10, statistics: { sizeOnDisk: 100 * 1024 ** 3 } }));
const ARR_QUEUE = { page: 1, pageSize: 500, totalRecords: 2, records: [
  { id: 1, title: 'Great Download S01E01', status: 'downloading', trackedDownloadStatus: 'ok', progress: 42.5, size: 1000000000, sizeleft: 575000000, quality: { quality: { name: 'WEBDL-1080p' } }, indexer: 'nzbgeek' },
  { id: 2, title: 'Other Download S02E05', status: 'downloading', trackedDownloadStatus: 'warning', progress: 88, size: 2000000000, sizeleft: 240000000, quality: { quality: { name: 'HDTV-720p' } }, indexer: 'dsn' },
] };
const DISKS = [
  { id: 1, path: '/mnt/media', label: 'Media', freeSpace: 250 * 1024 ** 3, totalSpace: 1000 * 1024 ** 3 },
  { id: 2, path: '/mnt/backup', label: 'Backup', freeSpace: 900 * 1024 ** 3, totalSpace: 1000 * 1024 ** 3 },
];
// Unraid docker containers, including the three WebUI resolution paths.
const UNRAID_CONTAINERS = [
  { id: 'c-jellyfin', names: ['/jellyfin'], state: 'RUNNING', image: 'lscr.io/linuxserver/jellyfin', status: 'Up 2 days', webUiUrl: 'http://192.168.1.10:8096', iconUrl: 'https://cdn.example.test/jellyfin.webp' },
  { id: 'c-sonarr', names: ['/sonarr'], state: 'RUNNING', image: 'lscr.io/linuxserver/sonarr', status: 'Up 2 days', isUpdateAvailable: true, ports: [{ privatePort: 8989, publicPort: 8989, type: 'TCP', ip: '0.0.0.0' }] },
  { id: 'c-pihole', names: ['/pihole'], state: 'RUNNING', image: 'pihole/pihole', status: 'Up 2 days', lanIpPorts: ['192.168.1.10:8081'], iconUrl: '/icons/pihole.webp' },
  { id: 'c-old', names: ['/old-thing'], state: 'EXITED', image: 'old/thing', status: 'Exited (0) 3 days ago' },
];
const CAL_ITEM = { id: 9, seriesId: 1, episodeFileId: 0, seasonNumber: 2, episodeNumber: 7, title: 'The Flash', airDateUtc: new Date(Date.now() + 36e5 * 30).toISOString(), hasFile: false, grabbed: true,
  // No series.title here — Sonarr's calendar payload can omit it (title comes from /series).
  series: { images: [{ coverType: 'poster', url: '/MediaCover/1/poster.jpg' }] } };

app.use('/sonarr', (req, res, next) => { if (!need(res, keyOk(req))) return; next(); });
app.get('/sonarr/api/v3/system/status', (req, res) => res.json({ appName: 'Sonarr', version: '4.0.5.1710' }));
app.get('/sonarr/api/v3/health', (req, res) => res.json([]));
app.get('/sonarr/api/v3/series', (req, res) => res.json(SERIES));
app.get('/sonarr/api/v3/queue', (req, res) => res.json(ARR_QUEUE));
app.get('/sonarr/api/v3/diskspace', (req, res) => res.json(DISKS));
app.get('/sonarr/api/v3/wanted/missing', (req, res) => res.json({ page: 1, pageSize: 1, totalRecords: 3, records: [] }));
app.get('/sonarr/api/v3/calendar', (req, res) => res.json([CAL_ITEM]));
app.get('/sonarr/api/v3/mediacover/1/poster.jpg', (req, res) => { res.type('image/png'); res.send(PNG); });

// ------------------------------------------------------------------ Radarr
const MOVIES = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, title: `Movie ${i + 1}`, monitored: true, hasFile: i > 4, statistics: { sizeOnDisk: 5 * 1024 ** 3 } }));
app.use('/radarr', (req, res, next) => { if (!need(res, keyOk(req))) return; next(); });
app.get('/radarr/api/v3/system/status', (req, res) => res.json({ appName: 'Radarr', version: '5.2.6.8376' }));
app.get('/radarr/api/v3/health', (req, res) => res.json([{ source: 'IndexerLongTermStatus', message: 'Indexers unavailable' }]));
app.get('/radarr/api/v3/movie', (req, res) => res.json(MOVIES));
app.get('/radarr/api/v3/queue', (req, res) => res.json({ totalRecords: 0, records: [] }));
app.get('/radarr/api/v3/diskspace', (req, res) => res.json(DISKS));
app.get('/radarr/api/v3/calendar', (req, res) => res.json([{ id: 5, title: 'New Film', releaseDate: new Date(Date.now() + 36e5 * 72).toISOString(), hasFile: false, images: [{ coverType: 'poster', url: 'https://image.tmdb.org/new-film.jpg' }] }]));
app.get('/radarr/api/v3/mediacover/5/poster.jpg', (req, res) => { res.type('image/png'); res.send(PNG); });

// ------------------------------------------------------------------ Lidarr
app.use('/lidarr', (req, res, next) => { if (!need(res, keyOk(req))) return; next(); });
const ALBUMS = { page: 1, pageSize: 1000, totalRecords: 8, records: Array.from({ length: 8 }, (_, i) => ({
  id: i + 1, title: `Album ${i + 1}`, monitored: true, statistics: { trackFileCount: i < 5 ? 10 : 0, trackCount: 10 },
})) };
app.get('/lidarr/api/v1/system/status', (req, res) => res.json({ appName: 'Lidarr', version: '2.3.0.4206' }));
app.get('/lidarr/api/v1/health', (req, res) => res.json([]));
app.get('/lidarr/api/v1/album', (req, res) => res.json(ALBUMS));
app.get('/lidarr/api/v1/queue', (req, res) => res.json({ totalRecords: 1, records: [{ id: 3, title: 'New Album', status: 'downloading', progress: 10, size: 80000000, sizeleft: 72000000 }] }));
app.get('/lidarr/api/v1/diskspace', (req, res) => res.json(DISKS));
app.get('/lidarr/api/v1/calendar', (req, res) => res.json([{ id: 2, title: 'Fresh LP', releaseDate: new Date(Date.now() + 36e5 * 96).toISOString(), artist: { name: 'Cool Artist', images: [{ coverType: 'poster', url: 'https://e-cdns-images.dzzzdn.co/artist.jpg' }] }, images: [{ coverType: 'cover', url: 'https://e-cdns-images.dzzzdn.co/album.jpg' }] }]));
app.get('/lidarr/api/v1/mediacover/2/cover.jpg', (req, res) => { res.type('image/png'); res.send(PNG); });

// ------------------------------------------------------------------ Prowlarr
app.use('/prowlarr', (req, res, next) => { if (!need(res, keyOk(req))) return; next(); });
app.get('/prowlarr/api/v1/system/status', (req, res) => res.json({ appName: 'Prowlarr', version: '1.17.2' }));
app.get('/prowlarr/api/v1/indexer', (req, res) => res.json([{ id: 1, enable: true, name: 'nzbgeek' }, { id: 2, enable: true, name: 'dsn' }, { id: 3, enable: false, name: 'old' }]));
app.get('/prowlarr/api/v1/health', (req, res) => res.json([]));
app.get('/prowlarr/api/v1/indexerstats', (req, res) => res.json({
  queries: 234, grabs: 56, failedQueries: 2, failedGrabs: 1,
  indexers: [
    { indexerId: 1, indexerName: 'nzbgeek', queries: 150, grabs: 40 },
    { indexerId: 2, indexerName: 'dsn', queries: 84, grabs: 16 },
  ],
}));

// ------------------------------------------------------------------ NZBHydra
// legacy /api/stats/indexers: POST-only, apikey in the BODY (empty body → 500 like the real server)
app.get('/nzbhydra/api/stats/indexers', (req, res) => res.status(405).json({ error: 'Method Not Allowed' }));
app.post('/nzbhydra/api/stats/indexers', (req, res) => {
  if (req.body?.apikey !== 'testkey-hydra') {
    res.status(500).type('html').send('<!DOCTYPE html><html><head><title>NZBHydra 2</title></head><body>error</body></html>');
    return;
  }
  res.json([
    { indexer: 'nzbgeek', state: 'ENABLED', level: null, lastError: null },
    { indexer: 'dsn', state: 'ENABLED', level: null, lastError: null },
    { indexer: 'oldie', state: 'DISABLED_USER', level: 'ERROR', lastError: 'expired' },
  ]);
});
// external API v1: X-Api-Key header or apikey query param
function hydraKeyOk(req) {
  return req.get('X-Api-Key') === 'testkey-hydra' || req.query.apikey === 'testkey-hydra';
}
app.get('/nzbhydra/externalapi/v1/ping', (req, res) => {
  if (!need(res, hydraKeyOk(req))) return;
  res.json({ version: '8.0.0' });
});
app.get('/nzbhydra/externalapi/v1/stats', (req, res) => {
  if (!need(res, hydraKeyOk(req))) return;
  res.json({
    indexerApiAccessStats: [
      { indexerName: 'nzbgeek', percentSuccessful: 96.5, averageAccessesPerDay: 17.2 },
      { indexerName: 'dsn', percentSuccessful: 91.0, averageAccessesPerDay: 8.8 },
    ],
    indexerDownloadShares: [
      { indexerName: 'nzbgeek', count: 30 },
      { indexerName: 'dsn', count: 12 },
    ],
  });
});
app.get('/nzbhydra/externalapi/v1/history/searches', (req, res) => {
  if (!need(res, hydraKeyOk(req))) return;
  res.json({ content: [{ id: 1 }], totalElements: 234 });
});
app.get('/nzbhydra/externalapi/v1/history/downloads', (req, res) => {
  if (!need(res, hydraKeyOk(req))) return;
  res.json({ content: [{ id: 1 }], totalElements: 42 });
});
app.post('/nzbhydra/api/stats', (req, res) => {
  if (!need(res, keyOk(req, 'X-Api-Key'))) return;
  res.json({
    indexerApiAccessStats: [{ indexerName: 'nzbgeek', count: 400 }, { indexerName: 'dsn', count: 220 }],
    indexerDownloadShares: [{ indexerName: 'nzbgeek', count: 30 }, { indexerName: 'dsn', count: 12 }],
    avgResponseTimes: { times: [] },
  });
});

// ------------------------------------------------------------------ SABnzbd
let sabPaused = false;
const sabPausedSlots = new Set();
app.use('/sabnzbd', (req, res, next) => {
  if (!need(res, (req.query.apikey === 'testkey-sab' ? true : false))) return; next();
});
app.get('/sabnzbd/sabnzbd/api', (req, res) => {
  const mode = String(req.query.mode || '');
  if (mode === 'version') return res.json({ version: '4.1.0' });
  if (mode === 'pause') { sabPaused = true; return res.json({ status: true }); }
  if (mode === 'resume') { sabPaused = false; return res.json({ status: true }); }
  if (mode === 'slot_pause') { sabPausedSlots.add(String(req.query.value || '')); return res.json({ status: true }); }
  if (mode === 'slot_resume') { sabPausedSlots.delete(String(req.query.value || '')); return res.json({ status: true }); }
  if (mode === 'queue') {
    return res.json({ queue: {
      status: sabPaused ? 'Paused' : 'Downloading', paused: String(sabPaused), kbpersec: sabPaused ? '0' : '2048',
      mbleft: '512', mb: '2048', timeleft: sabPaused ? '0:00:00' : '0:04:16',
      slots: [
        { nzo_id: 'a1', filename: 'Linux ISO 2024', cat: 'iso', status: sabPausedSlots.has('a1') ? 'Paused' : (sabPaused ? 'Paused' : 'Downloading'), percentage: 75, timeleft: '0:01:00' },
        { nzo_id: 'a2', filename: 'Backup set', cat: 'Default', status: 'Queued', percentage: 0, timeleft: '0:03:16' },
      ],
    } });
  }
  if (mode === 'history') {
    return res.json({ history: { slots: [
      { nzo_id: 'h1', name: 'Done ISO', status: 'Completed', bytes: 1500000000, fail_message: '' },
      { nzo_id: 'h2', name: 'Bad rar', status: 'Failed', bytes: 500000000, fail_message: 'CRC error' },
    ] } });
  }
  res.json({});
});

// ------------------------------------------------------------------ Jellyfin
app.get('/jellyfin/System/Info/Public', (req, res) => res.json({ ProductName: 'Jellyfin Server', ServerName: 'MediaBox', Version: '10.9.8' }));
function jfAuth(req) { return req.get('X-Emby-Token') === 'testkey-jf'; }
function jfAuthCanon(req) {
  const a = req.get('Authorization') || '';
  return /^MediaBrowser\b/.test(a) && a.includes('Token="testkey-jf"');
}
// /System/Info demands the canonical Jellyfin 10.12+ auth header — proves the connector sends it
app.use('/jellyfin', (req, res, next) => {
  if (req.path === '/System/Info') { if (!need(res, jfAuthCanon(req))) return; return next(); }
  if (!need(res, jfAuth(req) || jfAuthCanon(req))) return; next();
});
app.get('/jellyfin/System/Info', (req, res) => res.json({ ServerName: 'MediaBox', Version: '10.9.8' }));
app.get('/jellyfin/Items/Counts', (req, res) => res.json({ MovieCount: 350, SeriesCount: 45, EpisodeCount: 3200, SongCount: 9800 }));
app.get('/jellyfin/Library/MediaFolders', (req, res) => res.json({ Items: [
  { Id: 'l1', Name: 'Movies', CollectionType: 'movies' }, { Id: 'l2', Name: 'TV', CollectionType: 'tvshows' },
] }));
app.get('/jellyfin/Sessions', (req, res) => res.json([
  { Id: 's1', UserName: 'alice', DeviceName: 'Living Room TV', NowPlayingItem: {
    Id: 'm123', Name: 'Blade Runner', Type: 'Movie', RunTimeTicks: 8_100_000_0000, ImageTags: { Primary: 'tag1' } },
    PlayState: { PositionTicks: 4_050_000_0000 },
    TranscodingInfo: { IsVideoDirect: false, IsAudioDirect: true, VideoCodec: 'h264', AudioCodec: 'aac', Bitrate: 6_000_000 } },
  { Id: 's2', UserName: 'bob', DeviceName: 'Phone', NowPlayingItem: {
    Id: 'e77', Name: 'Pilot', Type: 'Episode', SeriesName: 'Great Series', ParentIndexNumber: 1, IndexNumber: 1, RunTimeTicks: 2_400_000_0000 },
    PlayState: { PositionTicks: 600_000_0000, IsPaused: true } },
]));
app.post('/jellyfin/Sessions/:id/Playing/:cmd', (req, res) => res.status(204).end());
app.get('/jellyfin/Items/m123/Images/Primary', (req, res) => { res.type('image/png'); res.send(PNG); });
app.get('/jellyfin/Items/svg/Images/Primary', (req, res) => {
  res.type('image/svg+xml');
  res.send('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
});

// ------------------------------------------------------------------ Audiobookshelf
app.use('/abs', (req, res, next) => {
  const bearer = req.get('Authorization') || '';
  const ok = bearer === 'Bearer testkey-abs' || bearer === `Bearer mocktoken`;
  if (!need(res, ok)) return; next();
});
app.post('/abs/login', (req, res) => res.json({ user: { id: 'u1', username: 'absadmin', token: 'mocktoken' } }));
app.get('/abs/api/libraries', (req, res) => res.json({ libraries: [
  { id: 'lb1', name: 'Audiobooks', mediaType: 'book', stats: { totalItems: 420 } },
  { id: 'lb2', name: 'Podcasts', mediaType: 'podcast', stats: { totalItems: 35 } },
] }));
app.get('/abs/api/users', (req, res) => res.json({ users: [{ id: 'u1', username: 'absadmin' }, { id: 'u2', username: 'mom' }] }));
// Historical sessions endpoint — HomeDeck must NOT use this for Now Playing.
app.get('/abs/api/sessions', (req, res) => res.json([
  { id: 'ps-old', userId: 'u2', mediaType: 'book', libraryItemId: 'it-old', currentTime: 3920, duration: 7200, updatedAt: Date.now() - 86400000, libraryItem: { id: 'it-old', media: { metadata: { title: 'Old Book', authorName: 'Old Author' } } }, deviceInfo: { client: 'Mobile' } },
]));
// Live listening sessions.
app.get('/abs/api/sessions/open', (req, res) => res.json({
  sessions: [
    {
      id: 'ps1',
      userId: 'u2',
      mediaType: 'book',
      libraryItemId: 'it1',
      currentTime: 1800,
      duration: 36000,
      updatedAt: Date.now(),
      mediaMetadata: { title: 'Dune', authorName: 'Frank Herbert' },
      displayTitle: 'Dune',
      displayAuthor: 'Frank Herbert',
      extraData: { libraryItemId: 'it1' },
      libraryItem: { id: 'it1', media: { metadata: { title: 'Dune', authorName: 'Frank Herbert' } } },
      deviceInfo: { client: 'Mobile' },
    },
    {
      id: 'ps2',
      userId: 'u2',
      mediaType: 'book',
      libraryItemId: 'it2',
      currentTime: 600,
      duration: 3600,
      updatedAt: Date.now() - 120000,
      libraryItemId: 'it2',
      mediaMetadata: { title: 'Paused Book', authorName: 'Paused Author' },
      displayTitle: 'Paused Book',
      displayAuthor: 'Paused Author',
      extraData: { libraryItemId: 'it2' },
      deviceInfo: { client: 'Tablet' },
    },
  ],
  shareSessions: [],
}));
app.get('/abs/api/items/it1/cover', (req, res) => { res.type('image/png'); res.send(PNG); });
app.get('/abs/api/items/it2/cover', (req, res) => { res.type('image/png'); res.send(PNG); });

// ------------------------------------------------------------------ Navidrome (Subsonic API)
// Subsonic requests must carry u/t/s — like the real Navidrome API.
app.use('/navidrome/rest', (req, res, next) => {
  if (!req.query.u || !req.query.t || !req.query.s) {
    return res.status(401).json({ 'subsonic-response': { status: 'failed', version: '1.16.1', error: { code: 40, message: 'Wrong username or password' } } });
  }
  next();
});
app.get('/navidrome/rest/ping.view', (req, res) => res.json({ 'subsonic-response': { status: 'ok', version: '1.16.1' } }));
app.get('/navidrome/rest/getNowPlaying.view', (req, res) => res.json({
  'subsonic-response': {
    status: 'ok',
    version: '1.16.1',
    nowPlaying: {
      entry: [{
        id: 'nav-song-1',
        title: 'Blade Runner Blues',
        artist: 'Vangelis',
        album: 'Blade Runner',
        coverArt: 'cover-1',
        duration: 240,
        position: 96,
        positionMs: 96500,
        playbackRate: 1,
        state: 'playing',
        username: 'naviuser',
        playerName: 'Feishin',
        playerId: 1,
        isPaused: false,
      }, {
        id: 'nav-song-2',
        title: 'Paused Track',
        artist: 'Daft Punk',
        album: 'Discovery',
        coverArt: 'cover-2',
        duration: 180,
        position: 30,
        positionMs: 30000,
        playbackRate: 0,
        state: 'paused',
        username: 'naviuser',
        playerName: 'Feishin',
        playerId: 2,
        isPaused: true,
      }],
    },
  },
}));
app.get('/navidrome/rest/getScanStatus.view', (req, res) => res.json({
  'subsonic-response': { status: 'ok', version: '1.16.1', scanStatus: { scanning: false, count: 1234 } },
}));
app.get('/navidrome/rest/getArtists.view', (req, res) => res.json({
  'subsonic-response': {
    status: 'ok',
    version: '1.16.1',
    artists: {
      index: [
        { name: 'Vangelis', artist: [{ id: 'a1', name: 'Vangelis' }] },
        { name: 'Daft Punk', artist: [{ id: 'a2', name: 'Daft Punk' }] },
      ],
    },
  },
}));
app.get('/navidrome/rest/getAlbumList2.view', (req, res) => res.json({
  'subsonic-response': {
    status: 'ok',
    version: '1.16.1',
    albumList2: {
      album: [
        { id: 'al1', name: 'Blade Runner', artist: 'Vangelis' },
        { id: 'al2', name: 'Discovery', artist: 'Daft Punk' },
      ],
    },
  },
}));
app.get('/navidrome/rest/getPlaylists.view', (req, res) => res.json({
  'subsonic-response': { status: 'ok', version: '1.16.1', playlists: { playlist: [{ id: 'p1', name: 'Favorites' }] } },
}));
app.get('/navidrome/rest/getCoverArt.view', (req, res) => { res.type('image/png'); res.send(PNG); });

// ------------------------------------------------------------------ Nextcloud
app.get('/nextcloud/status.php', (req, res) => res.json({ productname: 'Nextcloud', version: '29.0.3', maintenance: false }));
app.use('/nextcloud', (req, res, next) => { if (!need(res, basicOk(req, 'ncadmin', 'ncpass'))) return; next(); });
app.get('/nextcloud/ocs/v2.php/apps/serverinfo/api/v1/info', (req, res) => res.json({
  ocs: {
    meta: { status: 'ok', statuscode: 200, message: 'OK' },
    data: {
      nextcloud: {
        system: {
          version: '29.0.3',
          freespace: 1.2 * 1024 ** 3,
          cpuload: [0.4, 0.3, 0.2],
          mem_total: 16 * 1024 ** 2, // KB
          mem_free: 8 * 1024 ** 2,   // KB
        },
        storage: { num_users: 5, num_files: 154320, num_storages: 3 },
        shares: { num_shares: 17 },
      },
      server: { webserver: 'nginx', php: { version: '8.3' }, database: { type: 'mysql', version: '8.0' } },
      activeUsers: { last5minutes: 1, last1hour: 2, last24hours: 3 },
    },
  },
}));

// ------------------------------------------------------------------ Pi-hole v6
// session-aware: counts logins so the smoke test can prove session reuse
const piholeSessions = new Set();
let piholeLogins = 0;
app.get('/pihole/_debug', (req, res) => res.json({ logins: piholeLogins }));
app.post('/pihole/api/auth', (req, res) => {
  if (req.body?.password !== 'piholepass') return res.status(401).json({ error: 'invalid' });
  piholeLogins++;
  const sid = `MOCKSID-${piholeLogins}`;
  piholeSessions.add(sid);
  res.json({ session: { sid, valid: true, validity: 300 } });
});
app.get('/pihole/api/stats/summary', (req, res) => {
  if (!need(res, piholeSessions.has(req.get('X-FTL-SID')))) return;
  res.json({ queries: { total: 12345, blocked: 2345, percent_blocked: 19.0 }, clients: { active: 8, total: 12 }, gravity: { domains_being_blocked: 1420000 } });
});
app.get('/pihole/api/history', (req, res) => {
  if (!need(res, piholeSessions.has(req.get('X-FTL-SID')))) return;
  const now = Math.floor(Date.now() / 1000 / 600) * 600;
  res.json({ history: Array.from({ length: 144 }, (_, i) => ({ timestamp: now - (143 - i) * 600, total: 40 + (i % 7) * 5, blocked: 8 })) });
});

// ------------------------------------------------------------------ Pi-hole v5
app.get('/pihole5/admin/api.php', (req, res) => {
  const auth = req.query.auth;
  if (req.query.overTimeData10mins !== undefined) {
    if (auth !== 'v5token') { res.json({}); return; }
    const now = Math.floor(Date.now() / 1000 / 600) * 600;
    const domains = {}, ads = {};
    for (let i = 0; i < 144; i++) { domains[now - (143 - i) * 600] = 30 + i % 5; ads[now - (143 - i) * 600] = 6; }
    res.json({ domains_over_time: domains, ads_over_time: ads });
    return;
  }
  if (req.query.summary === undefined || auth !== 'v5token') { res.json({}); return; }
  res.json({
    dns_queries_today: 8123, ads_blocked_today: 1500, ads_percentage_today: 18.5,
    unique_clients: 6, domains_being_blocked: 1300000, queries_forwarded: 6000, queries_cached: 600, status: 'enabled',
  });
});

// ------------------------------------------------------------------ Immich
app.get('/immich/api/server/ping', (req, res) => res.json({ res: 'pong' })); // public in real Immich
app.use('/immich', (req, res, next) => {
  const k = req.get('x-api-key') || '';
  if (!need(res, k.startsWith('testkey-immich'))) return; next();
});
// statistics + users are admin-only — 403 for a key that is not the admin key
function immichAdmin(req) { return req.get('x-api-key') === 'testkey-immich'; }
app.get('/immich/api/server/statistics', (req, res) => {
  if (!immichAdmin(req)) return res.status(403).json({ error: 'Forbidden', code: 'admin_required' });
  res.json({ photos: 24500, videos: 3100, usage: 800 * 1024 ** 3 });
});
app.get('/immich/api/users', (req, res) => res.status(404).json({ error: 'Not found' })); // moved in new Immich versions
app.get('/immich/api/admin/users', (req, res) => {
  if (!immichAdmin(req)) return res.status(403).json({ error: 'Forbidden', code: 'admin_required' });
  res.json([{ id: 'a' }, { id: 'b' }]);
});
app.get('/immich/api/server/version', (req, res) => res.json({ major: 1, minor: 111, patch: 0 }));

// ------------------------------------------------------------------ Komga
app.use('/komga', (req, res, next) => {
  const ok = basicOk(req, 'komga@local', 'komgapass') || req.get('X-API-Key') === 'testkey-komga';
  if (!need(res, ok)) return; next();
});
app.get('/komga/api/v1/libraries', (req, res) => res.json([{ id: 'k1', name: 'Comics' }, { id: 'k2', name: 'Manga' }]));
app.get('/komga/api/v1/series', (req, res) => res.json({ content: [{ id: 's1' }], totalElements: 321, totalPages: 33, size: 1 }));
app.get('/komga/api/v1/books', (req, res) => res.json({ content: [{ id: 'b1' }], totalElements: 4120, totalPages: 412, size: 1 }));

// ------------------------------------------------------------------ Pingvin Share
app.use('/pingvin', (req, res, next) => {
  if (req.path.startsWith('/api/auth/')) return next();
  const bearer = req.get('Authorization') || '';
  if (!need(res, bearer === 'Bearer pingvin-token')) return; next();
});
app.post('/pingvin/api/auth/sessions', (req, res) => {
  if (req.body?.email === 'me@example.com' && req.body?.password === 'pvinpass') {
    return res.json({ accessToken: 'pingvin-token', expiresAt: new Date(Date.now() + 36e5).toISOString() });
  }
  res.status(401).json({ message: 'Bad credentials' });
});
app.get('/pingvin/api/shares', (req, res) => res.json([
  { id: 'sh1', name: 'holiday-photos', expiration: new Date(Date.now() + 864e5).toISOString(), visits: 12 },
  { id: 'sh2', name: 'docs', expiration: new Date(Date.now() - 864e5).toISOString(), visits: 3 },
]));

// ------------------------------------------------------------------ Stash
app.post('/stash/graphql', (req, res) => {
  const key = req.get('ApiKey') || req.get('apikey');
  if (key !== undefined && key !== 'testkey-stash') return res.status(401).json({ errors: [{ message: 'bad api key' }] });
  const q = typeof req.body === 'string' ? req.body : req.body?.query || '';
  const camel = q.includes('sceneCount');
  const d = { sceneCount: 1234, imageCount: 8000, galleryCount: 320, performerCount: 95, studioCount: 40, tagCount: 510, sceneMarkerCount: 88, oCounter: 12, totalPlayCount: 666, totalPlayDuration: 123456, totalSize: 2.5 * 1024 ** 4 };
  const data = {};
  if (camel) data.stats = d;
  else data.stats = Object.fromEntries(Object.entries(d).map(([k, v]) => [k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase()), v]));
  res.json({ data });
});

// ------------------------------------------------------------------ Tachidesk (Suwayomi)
// Suwayomi 2.x: REST /api/v1 is gone, everything is GraphQL at /api/graphql
app.use('/tachidesk', (req, res, next) => {
  const auth = req.get('Authorization');
  if (auth !== undefined && !basicOk(req, 'suwa', 'suwapass')) { res.status(401).json({ error: 'bad' }); return; }
  next();
});
app.all('/tachidesk/api/v1/*', (req, res) => res.status(404).json({ title: 'Endpoint not found', status: 404, type: 'https://javalin.io/documentation#badrequestresponse' }));
app.post('/tachidesk/api/graphql', (req, res) => {
  const q = String(req.body?.query || '');
  if (q.includes('__schema')) {
    return res.json({ data: { __schema: { queryType: { name: 'Query' } } } });
  }
  if (q.includes('mangas')) {
    return res.json({ data: { mangas: { totalCount: 2, nodes: [
      { id: 1, title: 'Solo Leveling', unreadCount: 12, downloadCount: 40 },
      { id: 2, title: 'One Piece', unreadCount: 300, downloadCount: 0 },
    ] } } });
  }
  if (q.includes('categories')) {
    return res.json({ data: { categories: { totalCount: 2, nodes: [ { id: 1, name: 'Default' }, { id: 2, name: 'Reading' } ] } } });
  }
  res.status(400).json({ errors: [{ message: 'Unknown query' }] });
});

// ------------------------------------------------------------------ Vaultwarden
app.get('/vaultwarden/alive', (req, res) => res.status(200).send('OK'));
app.get('/vaultwarden/admin/users', (req, res) => {
  const auth = req.get('Authorization') || '';
  if (auth !== 'Bearer vw-admin-token' && auth !== 'vw-admin-token') return res.status(401).json({ error: 'unauth' });
  res.json({ Users: [{ email: 'a@x' }, { email: 'b@x' }, { email: 'c@x' }] });
});

// ------------------------------------------------------------------ Unraid
app.post('/unraid/graphql', (req, res) => {
  if (!need(res, req.get('x-api-key') === 'testkey-unraid')) return;
  const q = String(req.body?.query || '');
  if (/updateContainer/.test(q) && /fail/i.test(q)) {
    return res.json({ errors: [{ message: 'container update failed (mock)' }] });
  }
  if (q.includes('dockerContainers')) {
    // legacy root that current Unraid API versions no longer have
    return res.status(400).json({ errors: [{ message: "Cannot query field 'dockerContainers' on type 'Query'." }] });
  }
  if (q.includes('__schema')) {
    return res.json({ data: { __schema: { queryType: { name: 'Query' } } } });
  }
  if (q.includes('metrics') && q.includes('array')) {
    // combined query
    return res.json({ data: {
      info: {
        os: { platform: 'Linux', distro: 'Unraid', release: '7.1.4', uptime: new Date(Date.now() - 123456000).toISOString() },
        cpu: { manufacturer: 'Intel', brand: 'Core i5-12400', cores: 6, threads: 12 },
      },
      array: {
        state: 'STARTED',
        parityCheckStatus: { status: 'RUNNING', progress: 42.5, running: true },
        // capacity in KILOBYTES: 10 TB total, 8 TB used
        capacity: { kilobytes: { free: 13_000_000_000, used: 95_000_000_000, total: 108_000_000_000 } },
        disks: [
          { name: 'parity', size: 16_000_000_000, status: 'DISK_OK', temp: 34 },
          { name: 'disk1', size: 16_000_000_000, fsSize: 16_000_000_000, fsFree: 15_600_000_000, fsUsed: 353_000_000, status: 'DISK_OK', temp: 38 },
        ],
        caches: [
          { name: 'cache', size: 2_000_000_000, fsSize: 2_000_000_000, fsFree: 1_800_000_000, fsUsed: 200_000_000, status: 'DISK_OK', temp: 41 },
        ],
      },
      docker: { containers: UNRAID_CONTAINERS },
      // 32 GB total, "used" 31.75 GB (incl. cache) but 16 GB available → real usage 50%
      metrics: { cpu: { percentTotal: 23.4 }, memory: { total: 34359738368, used: 34091302912, available: 17179869184 } },
    } });
  }
  if (q.includes('metrics')) {
    return res.json({ data: { metrics: { cpu: { percentTotal: 23.4 }, memory: { total: 34359738368, used: 34091302912, available: 17179869184 } } } });
  }
  if (q.includes('docker')) {
    return res.json({ data: { docker: { containers: UNRAID_CONTAINERS } } });
  }
  res.json({ data: {
    info: {
      os: { platform: 'Linux', distro: 'Unraid', release: '7.1.4', uptime: new Date(Date.now() - 123456000).toISOString() },
      cpu: { manufacturer: 'Intel', brand: 'Core i5-12400', cores: 6, threads: 12 },
    },
    array: {
      state: 'STARTED',
      capacity: { kilobytes: { free: 13_000_000_000, used: 95_000_000_000, total: 108_000_000_000 } },
      disks: [
        { name: 'parity', size: 16_000_000_000, status: 'DISK_OK', temp: 34 },
        { name: 'disk1', size: 16_000_000_000, fsSize: 16_000_000_000, fsFree: 15_600_000_000, fsUsed: 353_000_000, status: 'DISK_OK', temp: 38 },
      ],
      caches: [
        { name: 'cache', size: 2_000_000_000, fsSize: 2_000_000_000, fsFree: 1_800_000_000, fsUsed: 200_000_000, status: 'DISK_OK', temp: 41 },
      ],
    },
  } });
});

// ------------------------------------------------------------------ Overseerr / Jellyseerr
function overseerrRouter(version) {
  const router = express.Router();
  const requests = [
    { id: 1, status: 1, media: { mediaType: 'movie', title: 'Dune: Part Two', posterPath: '/dune.jpg', status: 2, releaseDate: '2024-03-01' }, requestedBy: { displayName: 'Alice', username: 'alice' } },
    { id: 2, status: 2, media: { mediaType: 'tv', title: 'Severance', posterPath: '/severance.jpg', status: 5, firstAirDate: '2022-02-18' }, requestedBy: { displayName: 'Bob', username: 'bob' } },
    { id: 3, status: 2, media: { mediaType: 'tv', title: 'The Bear', posterPath: '/bear.jpg', status: 3, firstAirDate: '2022-06-23' }, requestedBy: { displayName: 'Cara', username: 'cara' } },
    { id: 4, status: 3, media: { mediaType: 'movie', title: 'Argylle', posterPath: '/argylle.jpg', status: 2, releaseDate: '2024-02-02' }, requestedBy: { displayName: 'Dan', username: 'dan' } },
    { id: 5, status: 1, media: { mediaType: 'movie', title: 'Furiosa', posterPath: '/furiosa.jpg', status: 2, releaseDate: '2024-05-24' }, requestedBy: { displayName: 'Eve', username: 'eve' } },
  ];
  const auth = (req, res) => {
    const key = req.get('X-Api-Key') || '';
    if (!key.startsWith('testkey-')) { res.status(401).json({ error: 'invalid api key' }); return false; }
    return true;
  };
  const filtered = (filter) => {
    if (filter === 'pending') return requests.filter((r) => Number(r.status) === 1);
    if (filter === 'approved') return requests.filter((r) => Number(r.status) === 2);
    if (filter === 'available') return requests.filter((r) => Number(r.media?.status) === 5);
    if (filter === 'processing') return requests.filter((r) => Number(r.media?.status) === 3);
    if (filter === 'declined') return requests.filter((r) => Number(r.status) === 3);
    return requests;
  };
  router.get('/api/v1/status', (req, res) => res.json({ version, commitTag: 'mock', updateAvailable: false }));
  router.get('/api/v1/request', (req, res) => {
    if (!auth(req, res)) return;
    const filter = String(req.query.filter || 'all');
    const list = filtered(filter).slice().sort((a, b) => b.id - a.id);
    const take = Math.max(1, Math.min(100, Number(req.query.take) || 20));
    const skip = Math.max(0, Number(req.query.skip) || 0);
    const page = Math.floor(skip / take) + 1;
    res.json({
      pageInfo: { pages: Math.max(1, Math.ceil(list.length / take)), pageSize: take, results: list.length, page },
      results: list.slice(skip, skip + take),
    });
  });
  router.post('/api/v1/request/:id/approve', (req, res) => {
    if (!auth(req, res)) return;
    const item = requests.find((r) => r.id === Number(req.params.id));
    if (!item) return res.status(404).json({ error: 'request not found' });
    item.status = 2;
    res.json({ id: item.id, status: item.status });
  });
  router.post('/api/v1/request/:id/decline', (req, res) => {
    if (!auth(req, res)) return;
    const item = requests.find((r) => r.id === Number(req.params.id));
    if (!item) return res.status(404).json({ error: 'request not found' });
    item.status = 3;
    res.json({ id: item.id, status: item.status });
  });
  return router;
}
app.use('/seerr', overseerrRouter('3.0.0'));
app.use('/overseerr', overseerrRouter('1.33.0'));
app.use('/jellyseerr', overseerrRouter('2.1.0'));

// ------------------------------------------------------------------ generic
app.get('/generic/', (req, res) => res.status(200).send('hello'));

app.post('/webhook', (req, res) => res.status(200).json({ ok: true }));

app.listen(9000, '127.0.0.1', () => console.log('mock upstreams on :9000'));
