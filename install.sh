#!/bin/sh
# HomeDeck – Build & Start für Docker-Hosts (z. B. Unraid-Konsole)
# Verwendung:  sh install.sh
# Optional:   PORT=8753 DATA=/mnt/user/appdata/homedeck PUID=99 PGID=100 sh install.sh
#             SOCKET="" sh install.sh          (ohne Docker-Socket-Mount)
set -e

IMAGE=${IMAGE:-homedeck-usenet:latest}
NAME=${NAME:-homedeck}
PORT=${PORT:-8753}                                  # Host-Port (Container lauscht auf 8000)
DATA=${DATA:-/mnt/user/appdata/homedeck}
PUID=${PUID:-99}
PGID=${PGID:-100}
UMASK=${UMASK:-022}
TZ=${TZ:-Europe/Berlin}
SOCKET=${SOCKET:-/var/run/docker.sock}

cd "$(dirname "$0")"

echo "==> Baue Image '$IMAGE' ..."
docker build --pull -t "$IMAGE" .

echo "==> Stoppe alten Container (falls vorhanden) ..."
docker rm -f "$NAME" 2>/dev/null || true

echo "==> Starte Container ..."
set -- \
  -d --name "$NAME" --restart unless-stopped \
  -p "$PORT:8000" \
  -v "$DATA:/data" \
  -e "PUID=$PUID" -e "PGID=$PGID" \
  -e "UMASK=$UMASK" -e "TZ=$TZ"
if [ -n "$SOCKET" ] && [ -S "$SOCKET" ]; then
  set -- "$@" -v "$SOCKET:/var/run/docker.sock:ro"
fi
docker run "$@" "$IMAGE"

echo
echo "==> Fertig! HomeDeck läuft unter:  http://<Server-IP>:$PORT"
echo "    Datenbank/Einstellungen liegen in:  $DATA"
