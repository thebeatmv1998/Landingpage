#!/bin/sh
# HomeDeck entrypoint — honors linuxserver-style container conventions:
#   UID   (or PUID) : user id to run as        (default: 99 = nobody)
#   GID   (or PGID) : group id                 (default: 100 = users)
#   UMASK           : umask for created files  (default: 077)
#   TZ              : timezone (Node reads it directly, nothing to do here)
set -e

PUID=${PUID:-$(printenv UID || true)}
PGID=${PGID:-$(printenv GID || true)}
PUID=${PUID:-99}
PGID=${PGID:-100}
UMASK_VAL=${UMASK:-077}

umask "$UMASK_VAL"

# Running the container with an explicit non-root user: do not try to chown.
if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

if [ "$PUID" = "0" ]; then
  # explicit root opt-in; nothing to prepare
  exec "$@"
fi

mkdir -p /data
chown -R "$PUID:$PGID" /data
chmod 700 /data

if [ -S /var/run/docker.sock ]; then
  if su-exec "$PUID:$PGID" test -r /var/run/docker.sock 2>/dev/null; then
    echo "[entrypoint] Docker socket readable — Docker widget enabled"
  else
    echo "[entrypoint] WARN: /var/run/docker.sock is not readable by UID ${PUID} —"
    echo "[entrypoint] WARN: the Docker widget will show offline (socket mount + permissions)"
  fi
fi

exec su-exec "$PUID:$PGID" "$@"
