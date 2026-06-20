#!/usr/bin/env sh
# Restore the Jarvis data volume from an archive made by backup.sh. This REPLACES the volume's
# contents, so stop the bot first: `docker compose down`.
#
# Usage:   scripts/restore.sh <archive.tar.gz>
# Volume:  override with JARVIS_VOLUME=... if your compose project name is not "jarvis".
set -eu

ARCHIVE="${1:?usage: scripts/restore.sh <archive.tar.gz>}"
[ -f "$ARCHIVE" ] || { echo "no such file: $ARCHIVE" >&2; exit 1; }
VOLUME="${JARVIS_VOLUME:-jarvis_jarvis-data}"
ARCHIVE_DIR="$(cd "$(dirname "$ARCHIVE")" && pwd)"
ARCHIVE_NAME="$(basename "$ARCHIVE")"

docker volume create "$VOLUME" >/dev/null
# Clear the volume, then extract the archive into it.
docker run --rm \
  -v "$VOLUME":/data \
  -v "$ARCHIVE_DIR":/backup:ro \
  busybox sh -c "rm -rf /data/* && tar xzf /backup/$ARCHIVE_NAME -C /data"

echo "Restored $ARCHIVE_NAME -> $VOLUME. Start the bot with: docker compose up -d"
