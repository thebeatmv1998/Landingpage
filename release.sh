#!/bin/sh
# Build the Unraid/release bundle. The Android APK is bundled at
# public/download/homedeck.apk so the web UI can offer it after a Docker build.
set -eu
cd "$(dirname "$0")"

APK="public/download/homedeck.apk"
if [ ! -f "$APK" ]; then
  echo "Missing $APK. Build the APK or copy homedeck.apk there first." >&2
  exit 1
fi

OUT=${1:-homedeck-usenet.tar.gz}
tar -czf "$OUT" \
  --exclude=android/app/build \
  --exclude=android/.gradle \
  server public mock tests unraid .github android \
  release.sh package.json package-lock.json Dockerfile README.md LICENSE \
  .editorconfig .env.example docker-compose.yml install.sh entrypoint.sh .dockerignore

# Fail loudly if the APK did not make it into the bundle.
if ! tar -tzf "$OUT" | grep -qx 'public/download/homedeck.apk'; then
  echo "APK missing from $OUT" >&2
  exit 1
fi

echo "Built $OUT ($(wc -c < "$OUT") bytes)"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$OUT"
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$OUT"
fi
