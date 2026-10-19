#!/bin/sh
# HomeDeck entrypoint — honors linuxserver-style container conventions:
#   UID   (or PUID) : user id to run as        (default: 0 = root)
#   GID   (or PGID) : group id                 (default: same as PUID)
#   UMASK           : umask for created files  (default: 022)
#   TZ              : timezone (Node reads it directly, nothing to do here)
set -e

PUID=${PUID:-$(printenv UID || true)}
PGID=${PGID:-$(printenv GID || true)}
PUID=${PUID:-0}
PGID=${PGID:-$PUID}
UMASK_VAL=${UMASK:-022}

umask "$UMASK_VAL"

if [ "$PUID" = "0" ]; then
  # run as root, nothing to prepare
  exec "$@"
fi

mkdir -p /data
chown -R "$PUID:$PGID" /data

if [ -S /var/run/docker.sock ]; then
  if su-exec "$PUID:$PGID" test -r /var/run/docker.sock 2>/dev/null; then
    echo "[entrypoint] Docker socket readable — Docker widget enabled"
  else
    echo "[entrypoint] WARN: /var/run/docker.sock is not readable by UID ${PUID} —"
    echo "[entrypoint] WARN: the Docker widget will show offline (socket mount + permissions)"
  fi
fi

exec su-exec "$PUID:$PGID" "$@"
