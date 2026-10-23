# HomeDeck

A self-hosted dashboard ("landing page") for your Docker home lab — with live stats, graphs,
now-playing info and deep API integrations for the \*arr suite and everything else you run.

**No build step, no CDN dependencies, fully offline-capable frontend.** Node.js backend with
SQLite storage, encrypted service credentials, user management, TOTP two-factor and
OAuth2/OIDC single sign-on.

---

## Quick start

### Docker (recommended)

```bash
docker build --pull -t homedeck-usenet:latest .
docker run -d --name homedeck --restart unless-stopped \
  -p 8753:8000 \
  -v /mnt/user/appdata/homedeck:/data \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -e UID=99 -e GID=100 -e UMASK=022 -e TZ=Europe/Berlin \
  homedeck-usenet:latest
```

Or use `docker compose build --pull && docker compose up -d`. The image is pinned to
**Node.js 24.22.1** (the patched baseline from the 2026-10-21 security release). The
container listens on **8000** internally and stores all persistent data in **`/data`**
(SQLite DB, uploads, encryption key). `UID`/`GID` (numeric) drop the process privileges
so files on the mounted volume are owned by that
user instead of root; `UMASK` and `TZ` work as usual. See `install.sh` for a one-command
build+run on any Docker host (defaults: host port 8753, image `homedeck-usenet:latest`).

> The compose file mounts `/var/run/docker.sock` so the **Docker widget** can show container
> states. Remove that line if you don't want to expose the socket.

### Bare Node

Requires **Node.js 22.23.4+, 24.22.1+ or 26.12.1+** in the respective release line
(patched baselines from the 2026-10-21 security release; uses the built-in `node:sqlite`).

```bash
npm install
npm start          # listens on :8080, data stored in ./data
```

### Configuration (environment)

| Variable                   | Default            | Meaning                                        |
| -------------------------- | ------------------ | ---------------------------------------------- |
| `PORT`                     | `8080`             | HTTP port (Docker image default: `8000`)       |
| `HOST`                     | `0.0.0.0`          | Bind address                                   |
| `DATA_DIR`                 | `./data`           | SQLite DB, uploads, encryption key (Docker image default: `/data`) |
| `UID` / `GID` (or `PUID`/`PGID`) | `0` / `0`    | Run as this numeric user/group (Docker entrypoint only) |
| `UMASK`                    | `022`              | File mode mask for created files (Docker entrypoint only) |
| `TZ`                       | system             | Timezone (Docker entrypoint passes through to Node) |
| `TRUST_PROXY`              | `0`                | Set `1` behind a reverse proxy (OAuth, IPs)    |
| `PUBLIC_URL`               | _(derived)_        | Canonical base URL for OAuth redirects, e.g. `https://deck.example.com` (recommended in production) |
| `SECURE_COOKIES`           | `0`                | Set `1` when serving via HTTPS                 |
| `SESSION_TTL_HOURS`        | `168`              | Session lifetime                               |
| `SESSION_TTL_REMEMBER_HOURS` | `720`            | "Remember me" session lifetime                 |

---

## Supported services (native API integrations)

| Service | What the dashboard shows |
| --- | --- |
| **Sonarr / Radarr / Lidarr** | library counts, monitored/missing, **library size on disk** (summed from the *arr API), live queue with progress, disk space, 7-day media calendar, health issues |
| **Prowlarr** | enabled indexers, query & grab statistics, per-indexer bars |
| **NZBHydra 2** | indexer status (enabled/disabled/errors), aggregate API stats |
| **SABnzbd** | live queue with per-item progress, speed + sparkline, history, ETA |
| **Jellyfin** | library counts, **live "now playing"** with artwork, users, progress and **remote pause/resume/stop** |
| **Audiobookshelf** | libraries, users, **currently open listening sessions** with artwork & progress (no remote pause API) |
| **Navidrome** | live sessions from **Feishin**, Symfonium, the web player, etc., song/artist/album/playlist stats and cover art (Subsonic API, admin account recommended) |
| **Nextcloud** | storage, files, users, shares, CPU & RAM (serverinfo API) |
| **Pi-hole** | queries today, blocked %, clients, blocklist, **interactive 24h graph** (**v5 & v6**) |
| **Immich** | photos, videos, storage usage, users |
| **Komga** | libraries, series, books (API key or username/password) |
| **Pingvin Share** | active shares, views |
| **Stash** | scenes, images, galleries, performers, play stats |
| **Tachidesk / Suwayomi** | library size, categories, unread, downloads |
| **Vaultwarden** | status, user count (with admin token) |
| **Docker** | running/stopped/unhealthy containers via the Docker socket or Unraid — **container icons** (Unraid template icon, else bundled dashboardicons), click to open the WebUI, one-click **update / restart / stop / start** |
| **Generic** | any other app — up/down check + response time |

All service credentials (API keys, passwords) are stored **AES-256-GCM encrypted** in the
database and are never sent to the browser. All API calls go through the backend (no CORS,
no leaked keys), with per-service response caching so your apps aren't hammered.

### Automatic local ↔ public address switching

Every service can have a **public / fallback URL** in addition to its local URL
(Admin → Services → edit). When the dashboard is opened from outside your LAN, the browser
cannot reach `http://192.168.…`; HomeDeck probes the local address (no-CORS, 2.5 s timeout)
and automatically links to the configured public URL instead. A small globe badge marks
services that currently use their fallback, and the service menu offers **Open public/local
address** and **Recheck connection**. Results are cached for two minutes and refreshed on
reconnect, when the tab regains focus, or on demand. Auto-switching can be disabled per service.

### Android app

A native Android client lives in `android/`. Pair it from **My settings → Mobile app**:
the web UI shows a one-time QR code (valid for 5 minutes, single use) containing the
server URL and a pairing code. The app exchanges it for a per-device bearer token,
stores it encrypted with the Android Keystore and can be revoked from the same
settings page. The dashboard shows services with live stats, supports the same
local/public URL failover, keeps an offline cache and offers themes, accent colours,
compact cards, grouping and a refresh interval. See `android/README.md` for build
instructions (JDK 17 + Android SDK 35).

A prebuilt **debug-signed APK** (`homedeck.apk`, v1.1.2, Android 8.0+) is attached to
the latest **GitHub Release** and also included in `homedeck-usenet.tar.gz` at
`public/download/homedeck.apk`. Building the Docker image from that tarball enables the
download button in **My settings → Mobile app**. The app includes charts/detail screens
and supports separate local and external HomeDeck server addresses with automatic
failover.

A plain source checkout does not contain the APK; place it in
`public/download/homedeck.apk` if you build from source.

Tokens are stored hashed at rest (`device_tokens`), are sent only as
`Authorization: Bearer hd_…` and are revoked by password/username changes and
per-device from the web UI.

**Easy to expand:** the *Generic* connector covers any HTTP service out of the box. Adding a
native connector means dropping one small file into `server/services/connectors/` and one
entry into `server/services/registry.js` — the admin UI, forms and dashboard pick it up
automatically.

---

## Features

- **Live updates** — a server-sent-events stream pushes queue progress, playback sessions,
  Pi-hole counters and container states as they change. No refresh needed.
- **Widgets**: Services grid · Now Playing (with **Jellyfin pause/resume/stop**) · Downloads (merged queues + speed chart) ·
  Media Calendar (click-through to the service) · DNS/Ad-blocking with 24h graph ·
  Docker states with WebUI links, update badges and **one-click updates** (per container + update all) · Unraid ·
  **Nextcloud** (files, users, shares, CPU load, RAM, free space) · Disk Space · Indexer stats ·
  Service health · Weather (multi-city, current + 5-day, °C/°F) · Clock.
  Each widget can be moved freely, resized in **width and height** (drag the bottom-right corner; double-click it for automatic height), hidden and restored - per user.
- **Visually configurable** — dark/light theme, accent colors, background (presets, solid,
  URL or uploaded image with blur & dim), card opacity/blur, corner radius, fonts, column
  count, icon shape, compact mode. Global defaults set by the admin, personal overrides per
  user, live preview.
- **User management** — admin/user roles, **groups editor** (create/rename/delete; renaming updates
  users and service access), per-user dashboard layout, password changes, TOTP reset by admin.
- **Security** — scrypt password hashing, HttpOnly session cookies, CSRF protection,
  login rate limiting, TOTP (RFC 6238) with QR provisioning **and single-use recovery codes**,
  generic OAuth2/OIDC SSO (Authentik, Authelia, Keycloak, Pocket ID, …) with optional
  auto-provisioning, **session/device management** (list + revoke) and an **audit log**.
- **Fast navigation** — press **⌘K / Ctrl-K** anywhere to jump to a page or open any service.
- **Per-user layout** — widget positions/sizes and service order are personal, with admin defaults.
- **Config export/import** as JSON (secrets excluded), plus **passphrase-encrypted full backups**
  (services incl. credentials + settings) and **webhook alerts** for service down/up and disk thresholds.

---

## Architecture

```
server/
  core/       config (env, encryption), SQLite layer, helpers
  auth/       scrypt passwords, TOTP, sessions, OAuth2/OIDC, auth routes
  services/   registry + connectors (one file per service), poller/cacher/SSE runner
  routes/     dashboard API, service CRUD, settings, uploads, image proxy
public/       no-build ES-module frontend (views, widgets, hand-rolled SVG charts)
mock/         mock upstream servers for the end-to-end tests
tests/        smoke test: boots the app + mocks, exercises auth/TOTP/connectors/SSE
```

The backend polls each configured service on its own interval (configurable per service),
caches the normalized result (stats / activity / now-playing / charts / calendar) and
broadcasts changes over SSE. The frontend is static ES modules — every chart (donut, area,
bars, sparkline) is hand-drawn SVG, so nothing is fetched from third-party CDNs.

### Adding a connector

```js
// server/services/connectors/myapp.js
export default {
  async test(ctx) {
    const res = await ctx.api('/api/ping', { headers: { 'X-Api-Key': ctx.apiKey } });
    return { ok: res.json?.ok === true, message: 'Connected' };
  },
  async poll(ctx) {
    const data = await ctx.api('/api/stats', { headers: { 'X-Api-Key': ctx.apiKey } });
    return { stats: [{ label: 'Tasks', value: data.json.tasks }], activity: [], charts: {} };
  },
};
```

…then register it in `server/services/registry.js` (label, category, color, icon, fields,
default poll interval) **and** import it in the `connectors` map in `server/services/runner.js`.
Done — it appears in the admin gallery, the forms and the dashboard.

---

## Development & testing

```bash
npm run mock    # starts mock versions of every service API on :9000
npm run unit    # unit tests for helpers (no network)
npm run smoke   # end-to-end test (boots a fresh instance on :8123 + mocks, 286 assertions)
npm test        # unit + smoke
```

### Multi-arch image

```bash
docker buildx build --pull --platform linux/amd64,linux/arm64 -t homedeck-usenet:latest .
```

The smoke test covers: setup, login, CSRF, rate limiting, TOTP enrolment + login, user &
group access, service CRUD with masked secrets, **every connector against the mocks**,
image proxy, SSE stream, settings, uploads and config export/import.

### Unraid (tar.gz + docker build)

Download `homedeck-usenet.tar.gz` from the latest GitHub Release (the APK is included):

```bash
cd /mnt/user/appdata
mkdir -p homedeck-src
tar -xzf homedeck-usenet.tar.gz -C homedeck-src
cd homedeck-src
docker build --pull -t homedeck-usenet:latest .
```

The bundle can be rebuilt locally with `sh release.sh` (requires the APK at
`public/download/homedeck.apk`).

Then create the container via **Docker → Add Container** (manual fields) — see the
`unraid/` folder for a ready-made template matching those fields.

---

## Notes

- Service logos are bundled locally as WebP files in `public/icons/` (from
  [dashboardicons.com](https://dashboardicons.com)) so nothing loads from a CDN. Any service can
  override its logo with an **Icon URL** in the admin UI.
- Text responses (HTML/CSS/JS/JSON) are served with **Brotli/gzip**; the SSE stream is never compressed.
- The Nextcloud widget reads the **serverinfo** app (Settings → Apps) with an admin account/app
  password. If it's unavailable, the widget/service shows an explanatory error instead of empty tiles.
- Media artwork is streamed through `/api/proxy/<service>/...`, which only forwards to
  services configured in the dashboard and only for logged-in users.
- The Docker connector auto-detects the socket (`/var/run/docker.sock`, or
  `npipe:////./pipe/docker_engine` on Windows); override it in the service settings.
- Weather uses [open-meteo.com](https://open-meteo.com) — no API key. Add one or more cities
  under **Settings → Administration → General** via the built-in **city / postal-code search**
  (postal codes need a country code, e.g. `DE`). The widget shows city tabs, current conditions
  and a **5-day forecast** per city, with °C/°F and a ↻ refresh button. The selected city is
  remembered per user; clear all locations to disable weather.
