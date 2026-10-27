// End-to-end smoke test: boots a fresh HomeDeck instance + mock upstreams and
// exercises auth, user management, service CRUD, connectors, SSE, settings, uploads.
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(ROOT, 'data-smoke');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

let passed = 0, failed = 0;
const failedNames = [];
function ok(cond, name, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failedNames.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

const jars = new Map(); // name -> cookie string
async function call(path, { method = 'GET', body, as = 'admin', raw, headers = {} } = {}) {
  const h = { ...headers, 'X-HD-CSRF': '1' };
  if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
  const cookie = jars.get(as);
  if (cookie) h['Cookie'] = cookie;
  const res = await fetch(BASE + path, {
    method, headers: h,
    body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.getSetCookie?.() || [];
  for (const sc of setCookie) {
    const kv = sc.split(';')[0];
    const name = kv.split('=')[0];
    const existing = (jars.get(as) || '').split('; ').filter(Boolean).filter((c) => !c.startsWith(name + '='));
    jars.set(as, [...existing, kv].join('; '));
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Raw request that bypasses URL normalization so we can test path-traversal guards
// (fetch/undici silently collapses ".." and "%2e%2e" before the request is sent).
function rawGet(rawPath, cookie) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path: rawPath, headers: cookie ? { Cookie: cookie } : {} }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', () => resolve({ status: 0, text: '' }));
    req.end();
  });
}

async function waitUp(proc) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/ping');
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await wait(500);
  }
  throw new Error('Server did not come up. stderr/stdout captured.');
}

// reuse the server's own TOTP implementation for valid codes
const { totpCode } = await import(pathToFileURL(path.join(ROOT, 'server', 'auth', 'totp.js')).href);

const children = [];
async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  // Fixtures for the host connector: a tiny synthetic /proc + /sys tree.
  fs.mkdirSync(path.join(DATA, 'hostproc', 'net'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'hostproc', 'stat'), 'cpu  1000 0 500 8000 100 0 0 0 0 0\ncpu0 1000 0 500 8000 100 0 0 0 0 0\n');
  fs.writeFileSync(path.join(DATA, 'hostproc', 'meminfo'), 'MemTotal: 16000000 kB\nMemAvailable: 8000000 kB\nSwapTotal: 2000000 kB\nSwapFree: 1500000 kB\n');
  fs.writeFileSync(path.join(DATA, 'hostproc', 'uptime'), '123456.78 0.00\n');
  fs.writeFileSync(path.join(DATA, 'hostproc', 'loadavg'), '0.50 0.40 0.30 1/100 1234\n');
  fs.writeFileSync(path.join(DATA, 'hostproc', 'net', 'dev'), 'Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n  eth0: 1000000 0 0 0 0 0 0 0 2000000 0 0 0 0 0 0 0\n');
  fs.mkdirSync(path.join(DATA, 'hostsys', 'class', 'thermal', 'thermal_zone0'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'hostsys', 'class', 'thermal', 'thermal_zone0', 'temp'), '45000\n');
  fs.writeFileSync(path.join(DATA, 'hostsys', 'class', 'thermal', 'thermal_zone0', 'type'), 'x86_pkg_temp\n');

  const mock = spawn('node', [path.join(ROOT, 'mock', 'mock-server.js')], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(mock);
  mock.stdout.on('data', (d) => process.stdout.write('  [mock] ' + d));
  mock.stderr.on('data', (d) => process.stdout.write('  [mock-err] ' + d));
  await wait(800);

  const server = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, HOST: '127.0.0.1' },
  });
  children.push(server);
  let serverOut = '';
  server.stdout.on('data', (d) => { serverOut += d; });
  server.stderr.on('data', (d) => { serverOut += d; });
  await waitUp();

  console.log('\n— auth & setup');
  let r = await call('/api/meta');
  ok(r.json?.needsSetup === true, 'meta reports needsSetup');
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  ok(r.json?.version === pkgVersion, `meta version matches package.json (${pkgVersion})`);
  ok(r.json?.androidApk?.version === pkgVersion, 'advertised APK version matches the app version');
  r = await call('/api/setup', { method: 'POST', body: { username: 'boss', password: 'supersecret1', displayName: 'Boss' } });
  ok(r.status === 200 && r.json?.user?.role === 'admin', 'setup creates admin');
  r = await call('/api/setup', { method: 'POST', body: { username: 'x', password: 'supersecret1' } });
  ok(r.status === 403, 'second setup call rejected');
  r = await call('/api/login', { method: 'POST', body: { username: 'boss', password: 'WRONG' } });
  ok(r.status === 401, 'wrong password rejected');
  r = await call('/api/me');
  ok(r.status === 200 && r.json?.user?.username === 'boss', 'session cookie works');

  console.log('\n— android app pairing');
  r = await call('/api/meta');
  ok(typeof r.json?.publicUrl === 'string', 'meta exposes the public URL hint');
  r = await call('/api/pair/start', { method: 'POST', body: { serverUrl: 'javascript:alert(1)' } });
  ok(r.status === 400, 'pairing rejects non-http server URLs');
  r = await call('/api/pair/start', { method: 'POST', body: { serverUrl: 'https://deck.example.com/' } });
  ok(r.status === 200 && /^[A-Za-z0-9_-]{20,}$/.test(r.json?.code || ''), 'pairing code generated');
  ok((r.json?.qr || '').startsWith('data:image/png;base64,'), 'pairing QR rendered as a data URL');
  const pair = r.json;
  const pairLink = new URL(pair.payload);
  ok(pairLink.protocol === 'homedeck:' && pairLink.host === 'pair'
    && pairLink.searchParams.get('url') === 'https://deck.example.com'
    && pairLink.searchParams.get('code') === pair.code, 'pairing payload carries server + code');

  // Claim exactly like the Android app: no cookie, no CSRF header.
  let pairRes = await fetch(BASE + '/api/pair/claim', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: pair.code, deviceName: 'Pixel 9' }),
  });
  let pairJson = await pairRes.json();
  ok(pairRes.status === 200 && pairJson.token?.startsWith('hd_')
    && pairJson.user?.username === 'boss' && pairJson.serverUrl === 'https://deck.example.com', 'pairing claim returns a device token');
  const deviceToken = pairJson.token;
  r = await call('/api/pair/devices');
  ok(r.json?.devices?.some((d) => d.name === 'Pixel 9'), 'paired device listed');
  const bearer = (path, opts = {}) => fetch(BASE + path, {
    ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${deviceToken}` },
  });
  let br = await bearer('/api/summary');
  ok(br.status === 200, 'bearer token authenticates the API');
  pairRes = await fetch(BASE + '/api/pair/claim', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: pair.code, deviceName: 'Second' }),
  });
  ok(pairRes.status === 401, 'pairing codes are single-use');
  br = await bearer('/api/pair/current', { method: 'DELETE' });
  ok(br.status === 200, 'device can revoke itself without a CSRF header');
  br = await bearer('/api/summary');
  ok(br.status === 401, 'revoked device token is rejected');

  // Pair again and revoke from the web UI.
  r = await call('/api/pair/start', { method: 'POST', body: { serverUrl: 'https://deck.example.com' } });
  pairRes = await fetch(BASE + '/api/pair/claim', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: r.json.code, deviceName: 'Tablet' }),
  });
  pairJson = await pairRes.json();
  const tabletToken = pairJson.token;
  const tablet = (await call('/api/pair/devices')).json?.devices?.find((d) => d.name === 'Tablet');
  ok(!!tablet?.id, 'second device listed');
  r = await call(`/api/pair/devices/${tablet.id}`, { method: 'DELETE' });
  ok(r.status === 200, 'device revoked from the web');
  br = await fetch(BASE + '/api/summary', { headers: { Authorization: `Bearer ${tabletToken}` } });
  ok(br.status === 401, 'web revocation invalidates the device token');

  console.log('\n— service CRUD');
  const SERVICES = [
    { type: 'sonarr', name: 'Sonarr', url: 'http://127.0.0.1:9000/sonarr', api_key: 'testkey-sonarr', category: 'Automation' },
    { type: 'radarr', name: 'Radarr', url: 'http://127.0.0.1:9000/radarr', api_key: 'testkey-radarr', category: 'Automation' },
    { type: 'lidarr', name: 'Lidarr', url: 'http://127.0.0.1:9000/lidarr', api_key: 'testkey-lidarr', category: 'Automation' },
    { type: 'prowlarr', name: 'Prowlarr', url: 'http://127.0.0.1:9000/prowlarr', api_key: 'testkey-prowlarr', category: 'Automation' },
    { type: 'nzbhydra', name: 'NZBHydra', url: 'http://127.0.0.1:9000/nzbhydra', api_key: 'testkey-hydra', category: 'Automation' },
    { type: 'sabnzbd', name: 'SABnzbd', url: 'http://127.0.0.1:9000/sabnzbd', api_key: 'testkey-sab', category: 'Downloads' },
    { type: 'jellyfin', name: 'Jellyfin', url: 'http://127.0.0.1:9000/jellyfin', api_key: 'testkey-jf', category: 'Media' },
    { type: 'audiobookshelf', name: 'Audiobookshelf', url: 'http://127.0.0.1:9000/abs', api_key: 'testkey-abs', category: 'Media' },
    { type: 'seerr', name: 'Seerr', url: 'http://127.0.0.1:9000/seerr', api_key: 'testkey-seerr', category: 'Media' },
    { type: 'navidrome', name: 'Navidrome', url: 'http://127.0.0.1:9000/navidrome', username: 'naviuser', password: 'navipass', category: 'Media' },
    { type: 'nextcloud', name: 'Nextcloud', url: 'http://127.0.0.1:9000/nextcloud', username: 'ncadmin', password: 'ncpass', category: 'Cloud & Files' },
    { type: 'pihole', name: 'Pi-hole v6', url: 'http://127.0.0.1:9000/pihole', password: 'piholepass', category: 'Network' },
    { type: 'pihole', name: 'Pi-hole v5', url: 'http://127.0.0.1:9000/pihole5', password: 'v5token', category: 'Network' },
    { type: 'immich', name: 'Immich', url: 'http://127.0.0.1:9000/immich', api_key: 'testkey-immich', category: 'Photos' },
    { type: 'komga', name: 'Komga', url: 'http://127.0.0.1:9000/komga', username: 'komga@local', password: 'komgapass', category: 'Reading' },
    { type: 'pingvin', name: 'Pingvin', url: 'http://127.0.0.1:9000/pingvin', username: 'me@example.com', password: 'pvinpass', category: 'Cloud & Files' },
    { type: 'stash', name: 'Stash', url: 'http://127.0.0.1:9000/stash', api_key: 'testkey-stash', category: 'Media' },
    { type: 'tachidesk', name: 'Tachidesk', url: 'http://127.0.0.1:9000/tachidesk', username: 'suwa', password: 'suwapass', category: 'Reading' },
    { type: 'vaultwarden', name: 'Vaultwarden', url: 'http://127.0.0.1:9000/vaultwarden', api_key: 'vw-admin-token', category: 'Security' },
    { type: 'unraid', name: 'Unraid', url: 'http://127.0.0.1:9000/unraid', api_key: 'testkey-unraid', category: 'System' },
    { type: 'host', name: 'Host', url: 'http://127.0.0.1:9000/', category: 'System', extra: { procRoot: path.join(DATA, 'hostproc'), sysRoot: path.join(DATA, 'hostsys') } },
    { type: 'wol', name: 'Wake PC', url: 'http://127.0.0.1:9000/', category: 'System', extra: { mac: 'AA:BB:CC:DD:EE:FF', broadcast: '127.0.0.1', port: '9' } },
    { type: 'generic', name: 'Router', url: 'http://127.0.0.1:9000/generic', category: 'Network' },
    { type: 'docker', name: 'Docker (unavailable in test)', url: 'http://localhost', category: 'System', extra: { socketPath: '/tmp/homedeck-no-such-docker.sock' } },
  ];
  const ids = {};
  for (const s of SERVICES) {
    r = await call('/api/services', { method: 'POST', body: s });
    ok(r.status === 200 && r.json?.id, `create ${s.name}`);
    ids[s.name] = r.json?.id;
  }
  // duplicate key should not create a second record readable — check mask
  r = await call('/api/services');
  ok(r.json?.services?.length === SERVICES.length, 'service list complete');
  ok(r.json.services.every((s) => !JSON.stringify(s).includes('testkey-')), 'API keys never returned in list');

  // per-service public fallback + automatic local/public switching
  r = await call(`/api/services/${ids['Sonarr']}`, { method: 'PUT', body: { fallback_url: 'https://sonarr.example.com', auto_switch: true } });
  ok(r.status === 200, 'fallback URL saved');
  r = await call('/api/services');
  const sonarrCfg = r.json?.services?.find((s) => s.name === 'Sonarr');
  ok(sonarrCfg?.fallback_url === 'https://sonarr.example.com' && sonarrCfg?.auto_switch === true, 'fallback URL + auto-switch round-trip');

  // edit: masked key keeps old secret (rename too, so later lookups by name stay valid)
  r = await call(`/api/services/${ids['Sonarr']}`, { method: 'PUT', body: { api_key: '••••1234', icon_url: 'https://example.com/sonarr.png' } });
  ok(r.status === 200, 'masked api_key accepted as "unchanged"');
  r = await call(`/api/services/${ids['Sonarr']}/test`, { method: 'POST', body: {} });
  ok(r.json?.ok === true, 'Sonarr still connects after masked edit');

  console.log('\n— connector tests (admin test button)');
  for (const s of SERVICES) {
    if (s.type === 'docker') continue; // socket not available in test env
    r = await call(`/api/services/${ids[s.name]}/test`, { method: 'POST', body: {} });
    ok(r.json?.ok === true, `test ${s.name} → ${r.json?.message || r.json?.error || JSON.stringify(r.json)}`);
  }
  // Seerr is the unified successor; Overseerr/Jellyseerr remain aliases.
  r = await call('/api/registry');
  const seerrReg = (r.json || []).find((x) => x.type === 'seerr');
  ok(seerrReg?.icon === '/icons/seerr.webp', 'Seerr registry entry exposes the local icon');
  const seerrIcon = await fetch(BASE + '/icons/seerr.webp');
  ok(seerrIcon.status === 200 && (seerrIcon.headers.get('content-type') || '').includes('image/webp'), 'Seerr icon is served locally');
  const stirlingIcon = await fetch(BASE + '/icons/stirling-pdf.webp');
  ok(stirlingIcon.status === 200 && (stirlingIcon.headers.get('content-type') || '').includes('image/webp'), 'Stirling PDF icon is served locally');
  const deckWebp = await fetch(BASE + '/icons/homedeck.webp');
  ok(deckWebp.status === 200 && (deckWebp.headers.get('content-type') || '').includes('image/webp'), 'HomeDeck WebP icon is served locally');
  const deckPng = await fetch(BASE + '/icons/homedeck.png');
  ok(deckPng.status === 200 && (deckPng.headers.get('content-type') || '').includes('image/png'), 'HomeDeck PNG icon for Unraid is served locally');
  r = await fetch(BASE + '/js/task.js');
  const taskJs = await r.text();
  ok(r.status === 200 && taskJs.includes('export function showTask') && taskJs.includes('task-fill') && taskJs.includes('doneTitle'), 'task progress module is served');
  r = await call(`/api/services/${ids['Seerr']}/action`, { method: 'POST', body: { action: 'approve_request', value: 1 } });
  ok(r.status === 200 && r.json?.ok === true, 'Seerr admin approve request');
  r = await call('/api/summary');
  const seerrSnap = (r.json?.services || []).find((s) => s.type === 'seerr');
  ok(seerrSnap?.requestCounts?.open === 1 && seerrSnap?.requestCounts?.approved === 3 && seerrSnap?.requestCounts?.available === 1,
    'Seerr request counts by status');
  ok(seerrSnap?.requests?.some((x) => x.title === 'Dune: Part Two' && x.user === 'Alice'
    && String(x.poster).startsWith('https://image.tmdb.org/t/p/w342/')),
    'Seerr resolves movie title, poster and requester');
  ok(seerrSnap?.requests?.some((x) => x.title === 'Severance' && x.status === 'available'),
    'Seerr resolves TV title and media availability');
  ok(!seerrSnap?.requests?.some((x) => /^Request #/.test(String(x.title))),
    'Seerr never displays the request number as the title');

  // Komga supports API keys (X-API-Key) as an alternative to Basic auth.
  r = await call('/api/services', { method: 'POST', body: { type: 'komga', name: 'Komga API Key', url: 'http://127.0.0.1:9000/komga', api_key: 'testkey-komga' } });
  const komgaKeyId = r.json?.id;
  r = await call(`/api/services/${komgaKeyId}/test`, { method: 'POST' });
  ok(r.json?.ok === true, 'Komga API key test works');
  await call(`/api/services/${komgaKeyId}`, { method: 'DELETE' });

  console.log('\n— secrets survive editing (all connectors)');
  const listedServices = (await call('/api/services')).json.services;
  for (const s of listedServices) {
    if (!s.has_api_key && !s.has_password) continue;
    r = await call(`/api/services/${s.id}`, { method: 'PUT', body: {
      name: s.name, url: s.url, username: s.username, api_key: '', password: '',
      category: s.category, icon_url: s.icon_url, allowed_groups: s.allowed_groups, extra: s.extra,
    } });
    const tested = r.status === 200
      ? await call(`/api/services/${s.id}/test`, { method: 'POST', body: {} })
      : r;
    ok(tested.json?.ok === true, `blank edit keeps saved secret — ${s.name}`, tested.json?.message || tested.json?.error);
  }

  console.log('\n— testing unsaved services');
  r = await call('/api/services/0/test', { method: 'POST', body: { type: 'sonarr', name: 'New Sonarr', url: 'http://127.0.0.1:9000/sonarr', api_key: 'testkey-sonarr' } });
  ok(r.json?.ok === true, 'test button works for an unsaved service', r.json?.message);
  r = await call(`/api/services/${ids['Pi-hole v6']}/test`, { method: 'POST', body: { type: 'pihole', name: 'Pi-hole v6', url: 'http://127.0.0.1:9000/pihole', username: '', password: '' } });
  ok(r.json?.ok === true, 'Pi-hole test with a blank password uses the saved token', r.json?.message);

  console.log('\n— wrong credentials are reported, not swallowed');
  r = await call('/api/services', { method: 'POST', body: { type: 'sonarr', name: 'BadSonarr', url: 'http://127.0.0.1:9000/sonarr', api_key: 'wrongkey' } });
  const badId = r.json.id;
  r = await call(`/api/services/${badId}/test`, { method: 'POST', body: {} });
  ok(r.json?.ok === false, 'bad API key test fails');
  await call(`/api/services/${badId}`, { method: 'DELETE' });
  r = await call('/api/services', { method: 'POST', body: { type: 'immich', name: 'ImmichRO', url: 'http://127.0.0.1:9000/immich', api_key: 'testkey-immich-readonly' } });
  const roId = r.json.id;
  r = await call(`/api/services/${roId}/test`, { method: 'POST', body: {} });
  ok(r.json?.ok === false && /admin/i.test(r.json?.message || ''), `immich non-admin key reports admin requirement (${(r.json?.message || '').slice(0, 60)})`);
  await call(`/api/services/${roId}`, { method: 'DELETE' });

  console.log('\n— live poller & summary');
  await wait(13000); // let the runner poll everything once
  r = await call('/api/summary');
  const byName = Object.fromEntries((r.json?.services || []).map((s) => [s.name, s]));
  for (const s of SERVICES) {
    const snap = byName[s.name];
    if (s.type === 'docker') { ok(snap && snap.online === false, `docker offline is graceful (${snap?.error?.slice(0, 40)})`); continue; }
    ok(snap?.online === true, `poll ${s.name} online`, snap?.error || '');
  }
  ok(byName['Sonarr']?.stats?.some((x) => x.label === 'Series' && x.value === 12), 'Sonarr stats: 12 series');
  ok(byName['Sonarr']?.activity?.length === 2, 'Sonarr queue has 2 items');
  ok(byName['Sonarr']?.calendar?.length === 1, 'Sonarr calendar upcoming');
  ok(byName['Sonarr']?.charts?.disks?.length === 2, 'Sonarr disk space');
  ok(byName['Radarr']?.stats?.some((x) => x.label === 'Missing' && x.value === 5), 'Radarr missing count = 5');
  ok(byName['Sonarr']?.stats?.some((x) => x.label === 'On disk' && /TB$/.test(String(x.value))), 'Sonarr shows size on disk');
  ok(byName['Radarr']?.stats?.some((x) => x.label === 'On disk' && /GB$/.test(String(x.value))), 'Radarr shows size on disk');
  ok(byName['Sonarr']?.fallbackUrl === 'https://sonarr.example.com' && byName['Sonarr']?.autoSwitch === true, 'summary exposes fallback URL + auto-switch');
  r = await call(`/api/services/${byName['Sonarr'].id}`, { method: 'PUT', body: { auto_switch: false } });
  r = await call('/api/services');
  ok(r.json.services.find((s) => s.name === 'Sonarr')?.auto_switch === false, 'auto-switch can be disabled per service');
  await call(`/api/services/${byName['Sonarr'].id}`, { method: 'PUT', body: { auto_switch: true } });
  ok((byName['Radarr']?.stats || []).some((x) => x.label === 'Health issues' && x.value === 1), 'Radarr health issue surfaced');
  ok(byName['Lidarr']?.stats?.some((x) => x.label === 'Albums' && x.value === 8), 'Lidarr albums count');
  ok(byName['SABnzbd']?.activity?.length === 2 && byName['SABnzbd']?.charts?.downloads?.speedBps > 0, 'SAB queue + speed');
  ok((byName['SABnzbd']?.history || []).some((h) => h.state === 'failed'), 'SAB history failed item');
  ok(byName['Jellyfin']?.nowPlaying?.length === 2, 'Jellyfin now playing 2 sessions');
  ok(byName['Jellyfin']?.nowPlaying?.every((n) => ['pause', 'resume', 'stop'].every((c) => n.controls?.includes(c))), 'Jellyfin exposes pause/resume/stop controls');
  ok(byName['Jellyfin']?.nowPlaying?.[1]?.paused === true, 'Jellyfin paused state surfaced');
  const jellyfinSession = byName['Jellyfin']?.nowPlaying?.[0]?.id;
  ok(!!jellyfinSession, 'Jellyfin session id surfaced');
  r = await call(`/api/services/${byName['Jellyfin'].id}/action`, { method: 'POST', body: { action: 'pause', value: jellyfinSession } });
  ok(r.status === 200 && r.json?.ok === true, 'Jellyfin pause action accepted');
  const movie = byName['Jellyfin']?.nowPlaying?.find((n) => n.title === 'Blade Runner');
  ok(movie?.progress === 50, `Jellyfin progress 50% (${movie?.progress})`);
  ok(byName['Jellyfin']?.nowPlaying?.some((n) => n.subtitle?.includes('S01E01')), 'Jellyfin episode subtitle');
  ok(byName['Audiobookshelf']?.nowPlaying?.length === 2 && byName['Audiobookshelf']?.nowPlaying[0].title === 'Dune', 'ABS open sessions (not history)');
  ok(byName['Audiobookshelf']?.nowPlaying?.every((n) => n.title !== 'Old Book'), 'ABS does not show books that were merely started long ago');
  ok(byName['Audiobookshelf']?.nowPlaying?.[1]?.paused === true && byName['Audiobookshelf']?.nowPlaying?.[1]?.title === 'Paused Book', 'ABS paused session detected from stale sync');
  ok(byName['Audiobookshelf']?.nowPlaying?.[0]?.art === '/api/items/it1/cover?width=400', 'ABS uses the cover endpoint');
  r = await call(`/api/proxy/${byName['Audiobookshelf'].id}/api/items/it1/cover?width=400`);
  ok(r.status === 200 && /^image\//.test(r.headers.get('content-type') || ''), 'ABS cover art proxied with auth');
  ok(byName['Navidrome']?.nowPlaying?.length === 2, 'Navidrome now playing from Feishin');
  ok(byName['Navidrome']?.nowPlaying?.[0]?.device === 'Feishin' && byName['Navidrome']?.nowPlaying?.[0]?.title === 'Blade Runner Blues', 'Navidrome Feishin session details');
  ok(byName['Navidrome']?.nowPlaying?.[0]?.subtitle === 'Vangelis · Blade Runner' && byName['Navidrome']?.nowPlaying?.[0]?.progress === 40, 'Navidrome artist/album/progress');
  ok(byName['Navidrome']?.nowPlaying?.[1]?.paused === true && byName['Navidrome']?.nowPlaying?.[1]?.playbackRate === 0 && byName['Navidrome']?.nowPlaying?.[1]?.positionMs === 30000, 'Navidrome pause state from OpenSubsonic state/rate');
  ok(!(byName['Navidrome']?.nowPlaying || []).some((n) => Array.isArray(n.controls) && n.controls.length), 'Navidrome does not advertise remote playback control');
  ok(byName['Navidrome']?.stats?.some((x) => x.label === 'Playing' && x.value === 1), 'Navidrome playing count excludes paused sessions');
  ok(byName['Navidrome']?.nowPlaying?.[0]?.art === '/rest/getCoverArt.view?id=cover-1', 'Navidrome cover art path');
  ok(byName['Navidrome']?.nowPlaying?.[0]?.positionMs === 96500
    && byName['Navidrome']?.nowPlaying?.[0]?.playbackRate === 1
    && byName['Navidrome']?.nowPlaying?.[0]?.positionAt > 0, 'Navidrome exposes precise live position metadata');
  ok(byName['Navidrome']?.stats?.some((x) => x.label === 'Songs' && x.value === 1234), 'Navidrome song count from scan status');
  ok(byName['Navidrome']?.stats?.some((x) => x.label === 'Artists' && x.value === 2), 'Navidrome artist count');
  ok(byName['Navidrome']?.stats?.some((x) => x.label === 'Albums' && x.value === 2), 'Navidrome album count');
  ok(byName['Navidrome']?.stats?.some((x) => x.label === 'Playlists' && x.value === 1), 'Navidrome playlist count');
  r = await call(`/api/proxy/${byName['Navidrome'].id}${byName['Navidrome'].nowPlaying[0].art}`);
  ok(r.status === 200 && /^image\//.test(r.headers.get('content-type') || ''), 'Navidrome cover art proxied with signed auth');
  ok(byName['Nextcloud']?.stats?.some((x) => x.label === 'Files' && x.value === 154320), 'Nextcloud files count');
  ok(byName['Nextcloud']?.stats?.some((x) => x.label === 'CPU load' && x.value === '0.40'), 'Nextcloud CPU load parsed');
  ok(byName['Nextcloud']?.stats?.some((x) => x.label === 'RAM' && x.value === '50%'), 'Nextcloud RAM parsed');
  ok(byName['Nextcloud']?.stats?.some((x) => x.label === 'Free space' && /GB$/.test(String(x.value))), 'Nextcloud free space parsed');
  ok(byName['Pi-hole v6']?.stats?.some((x) => x.label === 'Queries today' && x.value === 12345), 'Pi-hole v6 summary');
  ok((byName['Pi-hole v6']?.charts?.pihole?.series || []).length > 0, 'Pi-hole v6 24h graph');
  ok((byName['Pi-hole v6']?.charts?.pihole?.series || []).some((p) => p.queries > 0), 'Pi-hole v6 graph carries query values (flat history fields)');
  ok(byName['Pi-hole v5']?.stats?.some((x) => x.label === 'Queries today' && x.value === 8123), 'Pi-hole v5 summary');
  ok((byName['Pi-hole v5']?.charts?.pihole?.series || []).length === 144, 'Pi-hole v5 overTime graph');
  ok(byName['Immich']?.stats?.some((x) => x.label === 'Photos' && x.value === 24500), 'Immich photos');
  ok(byName['Komga']?.stats?.some((x) => x.label === 'Books' && x.value === 4120), 'Komga books');
  ok(byName['Pingvin']?.stats?.some((x) => x.label === 'Active shares' && x.value === 1), 'Pingvin active shares');
  ok(byName['Stash']?.stats?.some((x) => x.label === 'Scenes' && x.value === 1234), 'Stash scenes (camelCase query)');
  ok(byName['Tachidesk']?.stats?.some((x) => x.label === 'Unread' && x.value === 312), 'Tachidesk unread');
  ok(byName['Vaultwarden']?.stats?.some((x) => x.label === 'Users' && x.value === 3), 'Vaultwarden users via admin token');
  ok(byName['NZBHydra']?.stats?.some((x) => x.label === 'Searches' && x.value === 234), 'NZBHydra searches total (External API v1)');
  ok(byName['NZBHydra']?.stats?.some((x) => x.label === 'Downloads' && x.value === 42), 'NZBHydra downloads total');
  ok(byName['NZBHydra']?.stats?.some((x) => x.label === 'Indexers' && x.value === 2), 'NZBHydra indexer statuses (legacy POST + body key)');
  ok((byName['NZBHydra']?.charts?.bars || []).length === 2, 'NZBHydra success-rate bars');
  ok(byName['Router']?.online === true, 'generic connector online');
  ok(byName['Unraid']?.online === true, `Unraid online (${byName['Unraid']?.error || ''})`);
  ok(byName['Host']?.stats?.some((x) => x.label === 'RAM' && x.value === '50%'), 'host widget RAM from /proc/meminfo');
  ok(byName['Host']?.stats?.some((x) => x.label === 'Temp' && String(x.value).includes('45')), 'host widget temperature from /sys');
  ok(byName['Host']?.stats?.some((x) => x.label === 'Uptime' && x.value === '1d 10h'), 'host widget uptime');
  ok((byName['Host']?.charts?.host?.cpu || []).length >= 1, 'host widget sparkline samples');
  ok((byName['Host']?.hints || []).length === 0, 'host widget has no fallback warnings with /proc + /sys mounted');
  ok(byName['Wake PC']?.stats?.some((x) => x.label === 'MAC' && x.value === 'AA:BB:CC:DD:EE:FF'), 'WoL service exposes its MAC');
  r = await call(`/api/services/${ids['Wake PC']}/action`, { method: 'POST', body: { action: 'wake' } });
  ok(r.status === 200 && r.json?.ok === true, 'WoL magic packet action accepted');
  r = await call(`/api/services/${ids['Sonarr']}/action`, { method: 'POST', body: { action: 'missing_search' } });
  ok(r.status === 200 && r.json?.ok === true, 'Sonarr missing-media search action');
  r = await call(`/api/services/${ids['Radarr']}/action`, { method: 'POST', body: { action: 'refresh' } });
  ok(r.status === 200 && r.json?.ok === true, 'Radarr library refresh action');
  r = await call(`/api/history?serviceId=${ids['Host']}&metric=ram&range=24h`);
  ok(r.status === 200 && (r.json?.points || []).some((p) => Math.abs(p.v - 50) < 1), 'history API returns host RAM buckets');
  r = await call('/api/uptime?range=24h');
  const hostUptime = (r.json?.services || []).find((s) => s.name === 'Host');
  ok(hostUptime?.pct === 100, 'uptime summary reports host 100%');
  r = await call('/api/history?serviceId=99999&metric=ram&range=24h');
  ok(r.status === 404, 'history rejects an unknown service');
  ok(byName['Unraid']?.stats?.some((x) => x.label === 'Array' && x.value === 'STARTED'), 'Unraid array state');
  ok(byName['Unraid']?.stats?.some((x) => x.label === 'Uptime' && /^1d /.test(String(x.value))), `Unraid uptime from boot ISO (${byName['Unraid']?.stats?.find((x) => x.label === 'Uptime')?.value})`);
  ok(byName['Unraid']?.stats?.some((x) => x.label === 'Containers' && x.value === '5/6'), 'Unraid containers via docker.containers (UPPERCASE states)');
  ok(byName['Unraid']?.stats?.some((x) => x.label === 'Parity' && x.value === '43%'), 'Unraid parity progress surfaced');
  ok(byName['Unraid']?.containers?.find((c) => c.name === 'sonarr')?.update === true, 'Unraid container update flag surfaced');
  ok(byName['Unraid']?.containers?.find((c) => c.name === 'sonarr')?.icon === '/icons/sonarr.webp', 'container icon falls back to bundled dashboardicons');
  ok(byName['Unraid']?.containers?.find((c) => c.name === 'jellyfin')?.icon === 'https://cdn.example.test/jellyfin.webp', 'container icon uses the Unraid iconUrl');
  ok(byName['Unraid']?.containers?.find((c) => c.name === 'jellyfin')?.iconFallback === '/icons/jellyfin.webp', 'container icon exposes a bundled fallback for dead URLs');
  ok(byName['Unraid']?.containers?.find((c) => c.name === 'pihole')?.icon === 'http://127.0.0.1:9000/icons/pihole.webp', 'relative Unraid icon resolved against the server');
  ok(byName['Unraid']?.containers?.find((c) => c.name === 'Stirling-PDF')?.icon === '/icons/stirling-pdf.webp', 'host-path icon falls back to the bundled Stirling PDF icon');
  ok(byName['Unraid']?.containers?.find((c) => c.name === 'HomeDeck')?.icon === '/icons/homedeck.webp', 'HomeDeck container uses its own bundled icon');
  ok(byName['Seerr']?.iconUrl === '/icons/seerr.webp', 'summary exposes service icon URLs for the Android app');
  r = await call(`/api/services/${ids['Unraid']}/action`, { method: 'POST', body: { action: 'update', value: 'test-container' } });
  ok(r.status === 200 && r.json?.ok === true, 'Unraid container update action accepted');
  r = await call(`/api/services/${ids['Unraid']}/action`, { method: 'POST', body: { action: 'restart', value: 'c-sonarr' } });
  ok(r.status === 200 && r.json?.ok === true, 'Unraid container restart accepted');
  r = await call(`/api/services/${ids['Unraid']}/action`, { method: 'POST', body: { action: 'stop', value: 'c-sonarr' } });
  ok(r.status === 200 && r.json?.ok === true, 'Unraid container stop accepted');
  r = await call(`/api/services/${ids['Unraid']}/action`, { method: 'POST', body: { action: 'update', value: 'fail-container' } });
  ok(r.status === 502 && /container update failed/.test(r.json?.error || ''), 'container update errors are surfaced to the UI');
  ok(byName['Unraid']?.containers?.find((c) => c.name === 'jellyfin')?.url === 'http://192.168.1.10:8096', 'container WebUI from Unraid webUiUrl');
  ok(byName['Unraid']?.containers?.find((c) => c.name === 'sonarr')?.url === 'http://127.0.0.1:8989', 'container WebUI derived from published port');
  ok(byName['Unraid']?.containers?.find((c) => c.name === 'pihole')?.url === 'http://192.168.1.10:8081', 'container WebUI from lanIpPorts');
  ok(!byName['Unraid']?.containers?.find((c) => c.name === 'old-thing')?.url, 'container without template gets no WebUI link');
  ok(byName['Unraid']?.stats?.some((x) => x.label === 'CPU now' && x.value === '23%'), 'Unraid live CPU metrics');
  ok(byName['Unraid']?.stats?.some((x) => x.label === 'RAM now' && x.value === '50%'), 'Unraid RAM via available (not cache-inflated 99%)');
  ok((byName['Unraid']?.disks || []).some((d) => d.label === 'cache/cache' && d.temp === 41), 'Unraid cache disks listed');
  ok((byName['Unraid']?.disks || []).some((d) => d.label === 'parity' && d.size === '16.0 TB'), 'Unraid disk sizes are decimal kilobytes → 16.0 TB');
  ok((byName['Unraid']?.disks || []).some((d) => d.label === 'disk1' && d.used === '353.0 GB' && d.free === '15.6 TB'), 'Unraid per-disk used/free from fs* fields');
  ok(byName['Unraid']?.charts?.disks?.[0]?.totalGB === 108000, 'Unraid array total is 108 TB (decimal)');
  ok(byName['Unraid']?.charts?.disks?.[0]?.freeGB === 13000, 'Unraid array free space derived correctly (13 TB)');
  ok(byName['Unraid']?.stats?.some((x) => x.label === 'Array free' && x.value === '13.0 TB'), 'Unraid shows remaining (free) capacity');
  ok((byName['Jellyfin']?.nowPlaying?.[0]?.transcoding || {}).video === 'transcode → h264', 'Jellyfin transcode details (video)');
  ok(byName['Jellyfin']?.nowPlaying?.[0]?.transcoding?.audio === 'direct', 'Jellyfin transcode details (audio direct)');
  ok((byName['Sonarr']?.calendar || []).some((c) => c.title === 'Series 1'), 'Sonarr calendar title is the series name (not "Episode")');
  ok((byName['Sonarr']?.calendar || []).some((c) => /S02E07/.test(c.subtitle || '')), 'Sonarr calendar subtitle keeps season/episode + episode title');
  ok((byName['Sonarr']?.calendar || []).some((c) => (c.image || '') === '/api/v3/mediacover/1/poster.jpg'), 'Sonarr calendar uses the authenticated mediacover endpoint');
  ok((byName['Radarr']?.calendar || []).some((c) => (c.image || '') === '/api/v3/mediacover/5/poster.jpg'), 'Radarr calendar uses the authenticated mediacover endpoint');
  ok((byName['Lidarr']?.calendar || []).some((c) => (c.image || '') === '/api/v1/mediacover/2/cover.jpg'), 'Lidarr calendar uses the authenticated mediacover endpoint');

  console.log('\n— SABnzbd pause/resume actions');
  r = await call(`/api/services/${ids['SABnzbd']}/action`, { method: 'POST', body: { action: 'pause' } });
  ok(r.json?.ok === true, 'SAB pause action accepted');
  await wait(2500); // action triggers immediate re-poll
  r = await call('/api/summary');
  ok(r.json?.services?.find((s) => s.name === 'SABnzbd')?.charts?.downloads?.paused === true, 'SAB shows paused after action');
  r = await call(`/api/services/${ids['SABnzbd']}/action`, { method: 'POST', body: { action: 'slot_pause', value: 'a1' } });
  ok(r.json?.ok === true, 'SAB slot_pause accepted');
  await wait(2000);
  r = await call('/api/summary');
  ok(r.json?.services?.find((s) => s.name === 'SABnzbd')?.activity?.some((a) => a.paused === true), 'SAB slot shows paused');
  r = await call(`/api/services/${ids['SABnzbd']}/action`, { method: 'POST', body: { action: 'resume' } });
  ok(r.json?.ok === true, 'SAB resume action accepted');
  r = await call('/api/summary');
  ok(r.json?.services?.find((s) => s.name === 'SABnzbd')?.charts?.downloads?.paused === false, 'SAB shows running after resume');

  console.log('\n— Pi-hole v6 session reuse');
  const dbg = await fetch('http://127.0.0.1:9000/pihole/_debug').then((x) => x.json());
  ok(dbg.logins >= 1 && dbg.logins <= 2, `Pi-hole logged in ${dbg.logins}× only (session reused across polls)`);

  console.log('\n— image proxy');
  r = await fetch(`${BASE}/api/proxy/${byName['Jellyfin'].id}/Items/m123/Images/Primary?tag=tag1`, { headers: { Cookie: jars.get('admin') } });
  const imgBuf = Buffer.from(await r.arrayBuffer());
  ok(r.status === 200 && r.headers.get('content-type') === 'image/png', 'proxy streams Jellyfin art');
  ok(imgBuf.length > 8 && imgBuf[0] === 0x89 && imgBuf[1] === 0x50 && imgBuf[2] === 0x4e && imgBuf[3] === 0x47,
    `proxy bytes intact (PNG magic, ${imgBuf.length} bytes) — no UTF-8 corruption`);
  r = await fetch(`${BASE}/api/proxy/${byName['Jellyfin'].id}/Items/svg/Images/Primary`, { headers: { Cookie: jars.get('admin') } });
  ok(r.status === 502, 'proxy rejects SVG/active image types');
  r = await fetch(`${BASE}/api/proxy/${byName['Sonarr'].id}/api/v3/mediacover/1/poster.jpg`, { headers: { Cookie: jars.get('admin') } });
  ok(r.status === 200 && (r.headers.get('content-type') || '').startsWith('image/'), 'proxy streams Sonarr calendar poster (API key forwarded)');
  r = await fetch(`${BASE}/api/proxy/99999/x`, { headers: { Cookie: jars.get('admin') } });
  ok(r.status === 404, 'proxy rejects unknown service');
  r = await fetch(`${BASE}/api/proxy/${byName['Jellyfin'].id}/Items/m123/Images/Primary`);
  ok(r.status === 401, 'proxy requires auth');

  console.log('\n— SSE stream');
  const es = await fetch(`${BASE}/api/stream`, { headers: { Cookie: jars.get('admin') } });
  ok(es.status === 200 && es.headers.get('content-type')?.includes('event-stream'), 'SSE headers');
  ok(!es.headers.get('content-encoding'), 'SSE stream is not compressed');
  const reader = es.body.getReader();
  const dec = new TextDecoder();
  let got = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 12000 && !got.includes('event: service')) {
    const { value, done } = await reader.read();
    if (done) break;
    got += dec.decode(value);
  }
  ok(got.includes('event: service'), 'SSE pushes service events');
  await reader.cancel().catch(() => {});

  console.log('\n— user management & groups');
  r = await call('/api/users', { method: 'POST', body: { username: 'kid', password: 'kidspass1234', role: 'user', groupName: 'fam' } });
  ok(r.status === 200, 'create user');
  const kidId = r.json?.user?.id;
  r = await call(`/api/services/${ids['Vaultwarden']}`, { method: 'PUT', body: { allowed_groups: ['fam'] } });
  ok(r.status === 200, 'restrict service to group fam');
  r = await call('/api/login', { method: 'POST', as: 'kid', body: { username: 'kid', password: 'kidspass1234' } });
  ok(r.status === 200, 'kid login');
  r = await call(`/api/services/${ids['Jellyfin']}/action`, { method: 'POST', as: 'kid', body: { action: 'stop', value: 'test-session' } });
  ok(r.status === 200 && r.json?.ok === true, 'non-admin can stop a Jellyfin playback session');
  r = await call(`/api/services/${ids['Seerr']}/action`, { method: 'POST', as: 'kid', body: { action: 'approve_request', value: 5 } });
  ok(r.status === 403, 'non-admin cannot approve Seerr requests');
  r = await call('/api/summary', { as: 'kid' });
  const kidNames = (r.json?.services || []).map((s) => s.name);
  ok(kidNames.includes('Vaultwarden'), 'kid (group fam) sees restricted service');
  r = await call(`/api/services/${ids['Vaultwarden']}`, { method: 'PUT', body: { allowed_groups: ['adults'] } });
  r = await call('/api/summary', { as: 'kid' });
  ok(!(r.json?.services || []).some((s) => s.name === 'Vaultwarden'), 'kid no longer sees restricted service');

  // The SSE stream must apply the same group ACL as /api/summary.
  const kidEs = await fetch(`${BASE}/api/stream`, { headers: { Cookie: jars.get('kid') } });
  ok(kidEs.status === 200 && kidEs.headers.get('content-type')?.includes('event-stream'), 'kid SSE connects');
  const kidReader = kidEs.body.getReader();
  let kidGot = '';
  const kidT0 = Date.now();
  while (Date.now() - kidT0 < 5000 && !kidGot.includes('event: service')) {
    const { value, done } = await kidReader.read();
    if (done) break;
    kidGot += dec.decode(value);
  }
  ok(kidGot.includes('event: service'), 'kid SSE receives visible service events');
  ok(!kidGot.includes('"name":"Vaultwarden"'), 'kid SSE does not leak restricted services');
  await kidReader.cancel().catch(() => {});

  console.log('\n— groups');
  r = await call('/api/groups');
  ok((r.json?.groups || []).some((g) => g.name === 'fam' && g.users === 1), 'group list shows fam');
  r = await call('/api/groups', { method: 'POST', body: { name: 'testgroup' } });
  ok(r.status === 200, 'group created');
  r = await call('/api/groups/rename', { method: 'POST', body: { from: 'testgroup', to: 'testgroup2' } });
  ok(r.status === 200, 'group renamed');
  r = await call('/api/groups');
  ok((r.json?.groups || []).some((g) => g.name === 'testgroup2'), 'renamed group listed');
  r = await call('/api/groups/rename', { method: 'POST', body: { from: 'fam', to: 'family' } });
  r = await call('/api/users');
  ok((r.json?.users || []).find((u) => u.username === 'kid')?.groupName === 'family', 'group rename updates users');
  await call('/api/groups/rename', { method: 'POST', body: { from: 'family', to: 'fam' } });
  r = await call('/api/groups/testgroup2', { method: 'DELETE' });
  ok(r.status === 200, 'group deleted');
  r = await call('/api/groups');
  ok(!(r.json?.groups || []).some((g) => g.name === 'testgroup2'), 'deleted group gone');
  r = await call('/api/services', { as: 'kid' });
  ok(r.status === 403, 'non-admin blocked from service CRUD');
  r = await call('/api/users', { as: 'kid' });
  ok(r.status === 403, 'non-admin blocked from user list');
  r = await call('/api/settings', { as: 'kid' });
  ok(r.status === 200 && r.json.sso === undefined, 'non-admin settings omit sso');

  console.log('\n— TOTP');
  r = await call('/api/me/totp/setup', { method: 'POST', body: { password: 'supersecret1' } });
  ok(r.status === 200 && r.json?.secret && r.json?.qr?.startsWith('data:image/png;base64,'), 'totp setup returns secret + QR');
  const secret = r.json.secret;
  r = await call('/api/me/totp/enable', { method: 'POST', body: { code: '000000' } });
  ok(r.status === 401, 'wrong code rejected on enable');
  r = await call('/api/me/totp/enable', { method: 'POST', body: { code: totpCode(secret) } });
  ok(r.status === 200 && Array.isArray(r.json?.recoveryCodes) && r.json.recoveryCodes.length === 10, 'valid code enables totp + 10 recovery codes');
  const recoveryCodes = r.json.recoveryCodes;
  r = await call('/api/logout', { method: 'POST' });
  r = await call('/api/login', { method: 'POST', body: { username: 'boss', password: 'supersecret1' } });
  ok(r.json?.totpRequired === true && r.json?.ticket, 'login asks for TOTP');
  const totpTicket = r.json.ticket;
  r = await call('/api/login/recovery', { method: 'POST', body: { ticket: totpTicket, code: recoveryCodes[0] } });
  ok(r.status === 200 && r.json?.recoveryRemaining === 9, 'recovery code login works (single use)');
  // the same code must not work twice
  r = await call('/api/logout', { method: 'POST' });
  r = await call('/api/login', { method: 'POST', body: { username: 'boss', password: 'supersecret1' } });
  r = await call('/api/login/recovery', { method: 'POST', body: { ticket: r.json.ticket, code: recoveryCodes[0] } });
  ok(r.status === 401, 'used recovery code is rejected');
  r = await call('/api/login', { method: 'POST', body: { username: 'boss', password: 'supersecret1' } });
  r = await call('/api/login/totp', { method: 'POST', body: { ticket: r.json.ticket, code: totpCode(secret) } });
  ok(r.status === 200, 'TOTP login succeeds');
  // disable again for cleanliness
  r = await call('/api/me/totp/disable', { method: 'POST', body: { password: 'supersecret1', code: totpCode(secret) } });
  ok(r.status === 200, 'totp disable works');

  console.log('\n— sessions & audit');
  r = await call('/api/login', { as: 'other', method: 'POST', body: { username: 'boss', password: 'supersecret1' } });
  ok(r.status === 200, 'a second device signs in');
  r = await call('/api/me/sessions');
  const sessions = r.json?.sessions || [];
  const otherSession = sessions.find((s) => !s.current);
  ok(sessions.some((s) => s.current) && !!otherSession, 'sessions listed with the current device marked');
  r = await call(`/api/me/sessions/${otherSession.id}`, { method: 'DELETE' });
  ok(r.status === 200, 'session revoke accepted');
  r = await call('/api/summary', { as: 'other' });
  ok(r.status === 401, 'revoked session is rejected');
  r = await call('/api/audit');
  const auditEntries = r.json?.entries || [];
  ok(r.status === 200 && auditEntries.some((e) => e.action === 'session_revoked'), 'audit log records the revoke');
  ok(auditEntries.some((e) => e.action === 'login'), 'audit log records sign-ins');

  console.log('\n— settings');
  r = await call('/api/settings/appearance', { method: 'PUT', body: { accent: '#ff8800', bgMode: 'solid', bgSolid: '#101010' } });
  ok(r.json?.appearance?.accent === '#ff8800', 'appearance saved (deep-merged)');
  r = await call('/api/settings');
  ok(r.json?.appearance?.bgSolid === '#101010', 'settings readable with defaults merged');
  r = await call('/api/settings/sso', { as: 'kid', method: 'PUT', body: { enabled: true } });
  ok(r.status === 403, 'non-admin cannot change sso');
  r = await call('/api/settings/sso', { method: 'PUT', body: { clientSecret: 'test-client-secret' } });
  ok(r.status === 200 && !r.json?.sso?.clientSecret && r.json?.sso?.hasClientSecret === true, 'SSO client secret is never returned in the update response');
  r = await call('/api/settings');
  ok(!r.json?.sso?.clientSecret && r.json?.sso?.hasClientSecret === true, 'SSO client secret is masked in settings');
  r = await call('/api/alerts/test', { method: 'POST' });
  ok(r.status === 400, 'alerts test requires a webhook URL');
  r = await call('/api/settings/alerts', { method: 'PUT', body: { enabled: true, url: 'http://127.0.0.1:9000/webhook', diskPct: 90, onDown: true, onUp: true, onDisk: true } });
  ok(r.status === 200 && r.json?.alerts?.enabled === true, 'alerts settings saved');
  r = await call('/api/alerts/test', { method: 'POST' });
  ok(r.status === 200, 'alerts test posts to the webhook');
  await call('/api/settings/alerts', { method: 'PUT', body: { enabled: false } });

  console.log('\n— uploads & export');
  r = await call('/api/upload/background?filename=x.png', { method: 'POST', as: 'kid', raw: true, body: Buffer.from(PNG) });
  ok(r.status === 403, 'non-admin cannot upload background');
  r = await call('/api/upload/background', { method: 'POST', raw: true, body: Buffer.from('not-an-image-at-all-xxxxxxxxxxxx') });
  ok(r.status === 400, 'non-image upload rejected');
  r = await call('/api/upload/background', { method: 'POST', raw: true, body: PNG });
  ok(r.status === 200 && r.json?.url?.startsWith('/uploads/bg-'), 'background upload ok');
  const bgUrl = r.json?.url;
  r = await fetch(BASE + bgUrl);
  ok(r.status === 200 && r.headers.get('content-type') === 'image/png', 'uploaded background served');
  r = await call('/api/settings/export');
  ok(r.status === 200 && r.json?.services?.length > 0 && JSON.stringify(r.json).includes('clientSecret') === false, 'export works and omits sso secret');
  ok(r.json.services.find((s) => s.name === 'Sonarr')?.fallback_url === 'https://sonarr.example.com', 'export includes fallback URLs');
  r = await call('/api/settings/import', { method: 'POST', body: { services: [{ type: 'sonarr', name: 'Imported Sonarr', url: 'http://127.0.0.1:9000/sonarr', fallback_url: 'https://imported.example.com', auto_switch: false }] } });
  ok(r.json?.created === 1, 'import creates service without secrets');
  r = await call('/api/services');
  ok(r.json.services.find((s) => s.name === 'Imported Sonarr')?.fallback_url === 'https://imported.example.com', 'import keeps fallback URLs');

  console.log('\n— misc security');
  r = await fetch(BASE + '/api/summary');
  ok(r.status === 401, 'unauthenticated summary blocked');
  r = await fetch(BASE + '/api/summary', { method: 'GET', headers: { Cookie: jars.get('admin') } });
  ok(r.status === 200, 'authenticated summary ok');
  r = await fetch(BASE + '/api/health');
  const health = await r.json();
  ok(r.status === 200 && health.db === 'ok' && health.services > 0, 'health endpoint reports db + poller state');
  r = await call('/api/weather/refresh', { method: 'POST' });
  ok(r.status === 400 && /not configured/i.test(r.json?.error || ''), 'weather refresh reports missing location');
  r = await fetch(BASE + '/api/weather/refresh', { method: 'POST', headers: { 'X-HD-CSRF': '1' } });
  ok(r.status === 401, 'weather refresh requires auth');

  console.log('\n— security hardening');
  r = await fetch(BASE + '/');
  ok(r.headers.get('cross-origin-opener-policy') === 'same-origin' && r.headers.get('x-frame-options') === 'DENY', 'security headers present');
  ok(/default-src 'self'/.test(r.headers.get('content-security-policy') || ''), 'CSP present');
  r = await fetch(BASE + '/icons/sonarr.webp');
  ok(/immutable/.test(r.headers.get('cache-control') || ''), 'bundled icons cached immutably');
  r = await fetch(BASE + '/css/app.css');
  ok(/br|gzip/.test(r.headers.get('content-encoding') || ''), 'static assets are compressed (br/gzip)');
  r = await call('/api/summary');
  ok(/br|gzip/.test(r.headers.get('content-encoding') || ''), 'API JSON is compressed (br/gzip)');
  // image proxy must reject traversal (raw, non-normalized request targets)
  const jelly = byName['Jellyfin'].id;
  r = await rawGet(`/api/proxy/${jelly}/../../../etc/passwd`, jars.get('admin'));
  ok(r.status === 400, 'proxy rejects ".." traversal');
  r = await rawGet(`/api/proxy/${jelly}/%2e%2e/%2e%2e/api/summary`, jars.get('admin'));
  ok(r.status === 400, 'proxy rejects percent-encoded traversal');
  r = await rawGet(`/api/proxy/${jelly}/Items/m123/Images/Primary`, jars.get('admin'));
  ok(r.status === 200, 'proxy still serves a normal path');

  // poll-interval sanitisation
  const { clampPollMs } = await import(pathToFileURL(path.join(ROOT, 'server', 'core', 'util.js')).href);
  ok(clampPollMs('not-a-number') === null, 'poll interval: non-numeric rejected');
  ok(clampPollMs(1) === 5000, 'poll interval: below minimum clamped');
  ok(clampPollMs(999_999_999_999) === 24 * 3600 * 1000, 'poll interval: above maximum clamped');
  ok(clampPollMs(15000) === 15000, 'poll interval: valid value preserved');

  // SSO account resolution must not let a username claim hijack a local account.
  // Use a throwaway temp data dir so this in-process import doesn't touch the live DB.
  const UNIT_DATA = path.join(os.tmpdir(), `homedeck-smoke-unit-${process.pid}`);
  fs.rmSync(UNIT_DATA, { recursive: true, force: true });
  process.env.DATA_DIR = UNIT_DATA;
  const { resolveSsoUser } = await import(pathToFileURL(path.join(ROOT, 'server', 'auth', 'oauth.js')).href);
  let threw = false;
  try {
    await resolveSsoUser({}, { sub: 'attacker', preferred_username: 'boss' }, {
      createUser: async () => { throw new Error('must not create'); },
      findUserByName: () => ({ id: 1, oauth_sub: '', pass_hash: 'scrypt:x', role: 'admin', username: 'boss' }),
      findUserByOauth: () => null,
      linkOauth: () => {},
    });
  } catch { threw = true; }
  ok(threw, 'SSO refuses to auto-link an existing password account');

  let nameLookedUp = false;
  const ssoUser = await resolveSsoUser({}, { sub: 'sub-7', preferred_username: 'ghost' }, {
    createUser: async () => { throw new Error('must not create'); },
    findUserByName: () => { nameLookedUp = true; return null; },
    findUserByOauth: (p, s) => (p === 'sso' && s === 'sub-7' ? { id: 7, oauth_sub: 'sub-7', pass_hash: '', role: 'user', username: 'ghost' } : null),
    linkOauth: () => {},
  });
  ok(ssoUser?.id === 7 && !nameLookedUp, 'SSO matches by (provider, sub) without a username lookup');

  let conflicted = false;
  try {
    await resolveSsoUser({}, { sub: 'sub-new', preferred_username: 'boss' }, {
      createUser: async () => { throw new Error('must not create'); },
      findUserByName: () => ({ id: 1, oauth_sub: 'different-sub', pass_hash: '', role: 'user', username: 'boss' }),
      findUserByOauth: () => null,
      linkOauth: () => {},
    });
  } catch { conflicted = true; }
  ok(conflicted, 'SSO refuses a username already linked to another SSO account');

  let provisioned = null;
  const freshUser = await resolveSsoUser({}, { sub: 'sub-new2', preferred_username: 'newbie' }, {
    createUser: async (info) => { provisioned = info; return { id: 9, oauth_sub: 'sub-new2', pass_hash: '', role: 'user', username: info.username }; },
    findUserByName: () => null,
    findUserByOauth: () => null,
    linkOauth: () => {},
  });
  ok(provisioned?.username === 'newbie' && freshUser?.id === 9, 'SSO auto-provisions a brand-new user');

  console.log('\n— encrypted backup');
  r = await call('/api/settings/backup', { method: 'POST', body: { passphrase: 'test-passphrase' } });
  ok(r.status === 200 && r.json?.format === 'homedeck-backup' && !!r.json?.data, 'encrypted backup created');
  const backupFile = r.json;
  r = await call('/api/settings/restore', { method: 'POST', body: { passphrase: 'wrong-passphrase', backup: backupFile } });
  ok(r.status === 400, 'wrong backup passphrase rejected');
  const beforeCount = (await call('/api/services')).json.services.length;
  r = await call('/api/settings/restore', { method: 'POST', body: { passphrase: 'test-passphrase', backup: backupFile } });
  ok(r.status === 200 && r.json?.services === beforeCount, 'backup restored with all services');
  r = await call('/api/services');
  ok(r.json.services.some((s) => s.name === 'Sonarr' && s.has_api_key), 'restored services keep their secrets');
  ok(r.json.services.find((s) => s.name === 'Sonarr')?.fallback_url === 'https://sonarr.example.com', 'backup restores fallback URLs');

  console.log(`\n==== RESULTS: ${passed} passed, ${failed} failed ====`);
  if (failedNames.length) console.log(`FAILED: ${failedNames.join(' | ')}`);
  if (failed > 0 && serverOut) {
    console.log('---- server log tail ----');
    console.log(serverOut.split('\n').slice(-30).join('\n'));
  }
}

main()
  .catch((err) => { console.error('SMOKE CRASH:', err); failed++; })
  .finally(() => {
    for (const c of children) { try { c.kill(); } catch { /* ignore */ } }
    setTimeout(() => {
      try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(path.join(os.tmpdir(), `homedeck-smoke-unit-${process.pid}`), { recursive: true, force: true }); } catch { /* ignore */ }
      process.exit(failed ? 1 : 0);
    }, 400);
  });
