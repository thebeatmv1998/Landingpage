# HomeDeck for Android

A native Android client for HomeDeck. It pairs with a one-time QR code, stores a
revocable device token in the Android Keystore and shows the same live services as
the web dashboard.

## Features

- **QR pairing** — scan the one-time code from *My settings → Mobile app* in the web UI.
- **Live dashboard** — services grouped by category, online/offline state, stats,
  weather in the header, auto-refresh (15/30/60 s) and manual refresh.
- **Control from your phone** — Docker/Unraid container **start, stop, restart and
  update** (including update-all), SABnzbd queue and per-download pause/resume,
  Jellyfin **pause/resume/stop**, and Seerr **approve/decline** for pending
  requests. Container updates show a **non-blocking progress card with elapsed
  time and a clear completion/failure confirmation**. Admin-only controls are
  hidden for regular users; the server enforces the same rules.
- **Interactive insights** — full-width Pi-hole 24 h chart with a drag-to-inspect
  crosshair (time, queries, blocked, block rate), series toggles and an animated
  reveal; now-playing mini player with live progress; upcoming media, download
  queue, storage and Docker donuts; plus a tappable service-health strip.
- **Service detail screen** — interactive charts, queue progress, recent history,
  now-playing with artwork and a live playback clock (Jellyfin, Audiobookshelf,
  Navidrome/Feishin), containers, Unraid disks, calendar and technical info.
- **Local ↔ external server addresses** — add your public HomeDeck domain in Settings;
  the app probes the local address and falls back automatically. Auto / Local / External
  can be selected manually.
- **Local ↔ public service failover** — if a service has a fallback URL, the app probes the
  local address and opens the public domain when the LAN is unreachable (globe badge).
- **Offline cache** — the last summary is shown when the server cannot be reached.
- **Customizable** — system/dark/light theme, six accent colours, compact cards,
  category grouping, hide offline services and refresh interval.
- **Secure** — 256-bit device token encrypted with an Android Keystore AES-GCM key,
  one-time pairing codes (5 min, single use), per-device revocation, no analytics.

## Pairing

1. Open the HomeDeck web UI and go to **My settings → Mobile app**.
2. Enter the address your phone can reach (your public HTTPS domain when outside
   the LAN, e.g. `https://deck.example.com`).
3. Tap **Show pairing QR**.
4. In the app, tap **Scan QR code** and scan it.

The QR contains a one-time code that expires after **5 minutes** and can only be
used once. The app never stores your HomeDeck password. Each paired phone appears
under **Paired devices** and can be revoked there or in **Sessions**.

### Local and external server addresses

After pairing, open **Settings → Connection** in the app. The address from the QR
is the local/primary address. Add your public HomeDeck domain as the **external
address** (e.g. `https://deck.example.com`) and choose:

- **Auto** — probes `/api/ping` on the local address and uses the external address
  when it is unreachable (retries the other address if a request fails).
- **Local** / **External** — force one address.

The same device token works on both addresses. The dashboard shows the active route
next to the server host. Nothing needs to be changed in the web UI.

## Build

Requirements: JDK 17 and the Android SDK (platform 35, build-tools 35). Android
Studio Ladybug or newer can import the `android/` folder directly.

A release-signed APK is attached to the latest GitHub Release and included in the
release tarball at `public/download/homedeck.apk`:

```
homedeck.apk   (version matches the release tag, Android 8.0+, ~3.0 MB, release-signed)
SHA-256: see the notes of the matching GitHub release
```

Place it in `public/download/homedeck.apk` on the server to enable the
**Download APK** button under **My settings → Mobile app**. Enable “Install unknown
apps” for the browser when sideloading. The debug and release certificates are
different, so uninstall an older debug build before installing this release.

Release build (keystore must be kept outside the repository):

```bash
cd android
export HOMEDECK_KEYSTORE=/secure/path/homedeck-release.jks
export HOMEDECK_KEYSTORE_PASSWORD='…'
export HOMEDECK_KEY_ALIAS=homedeck
export HOMEDECK_KEY_PASSWORD='…'
./gradlew assembleRelease
# APK: app/build/outputs/apk/release/app-release.apk
```

For local development, `assembleDebug` still works and produces a debug-signed APK.

Windows:

```powershell
cd android
$env:HOMEDECK_KEYSTORE = 'C:\secure\homedeck-release.jks'
$env:HOMEDECK_KEYSTORE_PASSWORD = '…'
$env:HOMEDECK_KEY_ALIAS = 'homedeck'
$env:HOMEDECK_KEY_PASSWORD = '…'
.\gradlew.bat assembleRelease
```

Back up the keystore and its password separately from the repository. Losing them
means future releases cannot update an installed app.

The Gradle wrapper is included. If your SDK is not in the default location, create
`android/local.properties`:

```properties
sdk.dir=C\:\\Users\\you\\AppData\\Local\\Android\\Sdk
```

For a release APK, configure a signing keystore in `app/build.gradle.kts` and run
`./gradlew assembleRelease`.

## Security notes

- The raw device token (`hd_…`) is only returned once to the app and is stored
  hashed (SHA-256) on the server. Locally it is encrypted with a non-exportable
  Android Keystore key (AES-256-GCM).
- `android:allowBackup="false"` — the token is not included in device backups.
- Changing your HomeDeck password, changing the username (admin) or an admin
  password reset revokes all app tokens. Revoke individual devices any time.
- HTTPS is strongly recommended. Cleartext HTTP is allowed because many home
  installs use `http://192.168.x.x`; the app shows a warning when the server URL
  is not HTTPS. Use a reverse proxy with a valid certificate outside your LAN.
- The app talks only to the configured HomeDeck server and the services you open;
  there are no analytics, ads or third-party SDKs.

## Project layout

```
app/src/main/java/com/homedeck/app/
  MainActivity.kt      dashboard, polling, insight widgets, live now-playing
  ChartViews.kt        interactive Pi-hole chart, sparkline, donut
  PairingActivity.kt   QR scanner + manual pairing link
  SettingsActivity.kt  theme, accent, layout and connection settings
  Api.kt               HttpURLConnection client (bearer token)
  SecureStore.kt       Android Keystore AES-GCM token storage
  Prefs.kt             non-secret preferences
  Reachability.kt      local/public URL probing
  Models.kt            JSON models + pairing-link parser
  Ui.kt / UiTheme.kt   programmatic UI helpers and palettes
```

## Deep link

The app handles `homedeck://pair?url=…&code=…`. If a QR scanner outside the app
opens the link, HomeDeck starts the pairing screen automatically.
