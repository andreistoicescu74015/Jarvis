#!/usr/bin/env sh
# Back up the Jarvis data volume (WhatsApp creds + SQLite databases) to a timestamped tar.gz.
# The volume lives on one disk, so it is NOT a backup on its own - run this and copy the archive
# OFF this machine (ideally on a schedule: cron, or Windows Task Scheduler).
#
# Usage:   scripts/backup.sh [output-dir]      (default output dir: ./backups)
# Volume:  override with JARVIS_VOLUME=... if your compose project name is not "jarvis".
set -eu

VOLUME="${JARVIS_VOLUME:-jarvis_jarvis-data}"
OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"
OUT_ABS="$(cd "$OUT_DIR" && pwd)"
ARCHIVE="jarvis-$(date +%Y%m%d-%H%M%S).tar.gz"

# Read-only mount of the volume; tar its contents into the archive via a throwaway busybox.
docker run --rm \
  -v "$VOLUME":/data:ro \
  -v "$OUT_ABS":/backup \
  busybox tar czf "/backup/$ARCHIVE" -C /data .

echo "Backed up $VOLUME -> $OUT_DIR/$ARCHIVE"
echo "Now copy it OFF this machine - a copy on the same disk is not a backup."
