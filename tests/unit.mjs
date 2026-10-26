// Unit tests for pure helpers (no server, no network).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  clampPollMs, fmtBytes, fmtBytesSI, joinUrl, pct, deepMerge, safeJsonParse, timingSafeEqualStr,
} from '../server/core/util.js';
import { bundledIconFor } from '../server/services/registry.js';
import { pickServiceUrl } from '../public/js/net.js';
import { signSubsonic } from '../server/services/subsonic.js';

let passed = 0;
function ok(cond, name) {
  assert.ok(cond, name);
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('— poll interval clamping');
ok(clampPollMs('nope') === null, 'rejects non-numeric');
ok(clampPollMs(null) === null, 'null → null');
ok(clampPollMs(1) === 5000, 'clamps below the 5s floor');
ok(clampPollMs(15_000) === 15_000, 'keeps valid values');
ok(clampPollMs(10 ** 12) === 24 * 3600 * 1000, 'caps at 24h');

console.log('— size formatting');
ok(fmtBytesSI(16e12) === '16.0 TB', 'SI: 16 TB (decimal, like Unraid)');
ok(fmtBytesSI(3.53e11) === '353.0 GB', 'SI: 353 GB');
ok(fmtBytesSI(0) === '0 B', 'SI: zero');
ok(fmtBytesSI(-1) === '–', 'SI: negative guarded');
ok(fmtBytes(1024) === '1.0 KB', 'binary: 1024 B = 1.0 KB');

console.log('— urls & maths');
ok(joinUrl('http://host/', '/a') === 'http://host/a', 'joinUrl trims the trailing slash');
ok(joinUrl('http://host/base', 'x') === 'http://host/base/x', 'joinUrl adds a slash');
ok(pct(1, 4) === 25, 'pct computes a percentage');
ok(pct(5, 0) === 0, 'pct guards divide-by-zero');

console.log('-- per-service URL failover');
const svc = { url: 'http://192.168.1.10:8989', fallbackUrl: 'https://sonarr.example.com', autoSwitch: true };
ok(pickServiceUrl(svc, true) === svc.url, 'prefers the local URL while it is reachable');
ok(pickServiceUrl(svc, false) === svc.fallbackUrl, 'uses the public URL when the local address fails');
ok(pickServiceUrl({ ...svc, autoSwitch: false }, false) === svc.url, 'honours a disabled auto-switch');
ok(pickServiceUrl({ url: '', fallbackUrl: svc.fallbackUrl }, false) === svc.fallbackUrl, 'falls back when only a public URL exists');
ok(pickServiceUrl({ url: svc.url }, false) === svc.url, 'uses the local URL when no fallback is configured');
ok(pickServiceUrl(null, false) === '', 'handles a missing service');

console.log('-- Subsonic token auth');
const signed = new URL('http://x' + signSubsonic('/rest/ping.view', 'naviuser', 'navipass'));
const salt = signed.searchParams.get('s') || '';
ok(signed.pathname === '/rest/ping.view' && signed.searchParams.get('u') === 'naviuser', 'signing keeps the path and username');
ok(/^[a-f0-9]{16}$/.test(salt) && /^[a-f0-9]{32}$/.test(signed.searchParams.get('t') || ''), 'salt and token formats');
ok(signed.searchParams.get('t') === crypto.createHash('md5').update('navipass' + salt).digest('hex'), 'token is md5(password + salt)');
const signedCover = new URL('http://x' + signSubsonic('/rest/getCoverArt.view?id=cover-1', 'u', 'p'));
ok(signedCover.searchParams.get('id') === 'cover-1' && signedCover.searchParams.get('u') === 'u', 'signing keeps existing query parameters');

console.log('— misc');
ok(deepMerge({ a: { b: 1 } }, { a: { c: 2 } }).a.c === 2, 'deepMerge merges nested objects');
ok(JSON.stringify(safeJsonParse('{bad', {})) === '{}', 'safeJsonParse falls back on invalid JSON');
ok(timingSafeEqualStr('abc', 'abc') === true, 'constant-time compare matches');
ok(timingSafeEqualStr('abc', 'abd') === false, 'constant-time compare rejects');
ok(timingSafeEqualStr('abc', 'abcd') === false, 'constant-time compare handles length differences');

console.log('— container icons');
ok(bundledIconFor('sonarr', 'linuxserver/sonarr') === '/icons/sonarr.webp', 'icon by container name');
ok(bundledIconFor('my-jellyfin', '') === '/icons/jellyfin.webp', 'icon by partial name');
ok(bundledIconFor('media', 'lscr.io/linuxserver/radarr') === '/icons/radarr.webp', 'icon by image name');
ok(bundledIconFor('random-app', 'nginx') === '', 'no false icon match');
ok(bundledIconFor('Stirling-PDF', '') === '/icons/stirling-pdf.webp', 'Stirling PDF icon by container name');
ok(bundledIconFor('StirlingPDF', '') === '/icons/stirling-pdf.webp', 'StirlingPDF icon without separator');
ok(bundledIconFor('pdf', 'frooodle/s-pdf:latest') === '/icons/stirling-pdf.webp', 'Stirling PDF icon by s-pdf image');
ok(bundledIconFor('pdf', 'stirlingtools/stirling-pdf:latest') === '/icons/stirling-pdf.webp', 'Stirling PDF icon by stirling-pdf image');

console.log(`\n==== UNIT RESULTS: ${passed} passed, 0 failed ====`);
