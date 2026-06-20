# Jarvis

A deterministic WhatsApp bot, built **core-first**: a small, strong runtime exposes
capabilities ("directives") and commands are thin consumers of them.

Being rebuilt from scratch with a clean history. See [`CONTRIBUTING.md`](CONTRIBUTING.md)
for the branch / commit / PR flow.

## Stack

- Node.js 24+ (ESM)
- WhatsApp via Baileys (v7)
- Storage via the built-in `node:sqlite`
- Deployed as a Docker container

## Status

WhatsApp MVP: it connects to a dedicated account, handles `jarvis <command>` (and @mentions),
persists data, and runs unattended in Docker.

## Develop

```bash
npm run cli   # drive the bot from the terminal (no WhatsApp)
npm test      # node:test suite
```

## Run on WhatsApp

```bash
npm start     # connect to WhatsApp; scan the QR shown on first run to pair
```

## Run with Docker

First run - build, start, and pair (the QR is printed in the terminal; scan it with the dedicated
WhatsApp account):

```bash
cp .env.example .env        # optional: set OWNER_JID, LOG_LEVEL, ...
docker compose up --build
```

The WhatsApp session and the databases persist in the `jarvis-data` volume, so later starts
reconnect without a new QR.

### Everyday commands

```bash
docker compose up -d --build   # start in the background (rebuilds if the code changed)
docker compose logs -f         # follow logs (and watch the QR on first pairing)
docker compose restart         # restart the container
docker compose stop            # stop, keep the container and data
docker compose down            # stop and remove the container (the data volume is kept)
```

### Owner commands (in chat)

Sent by the owner as `jarvis <cmd>`; they rely on the `restart: on-failure` policy:

- `jarvis shutdown` - stop the bot (exits cleanly, stays down).
- `jarvis restart` - bounce the bot (exits non-zero, the container comes back).
- `jarvis logout` - forget the session and re-pair (wipes creds, the container comes back with a new QR).

### Storage & reset

All state - the WhatsApp creds plus the SQLite databases - lives in the `jarvis-data` Docker volume
and survives `docker compose down`.

```bash
docker compose down -v                       # forced reset: wipe everything, new QR next start
docker volume inspect jarvis_jarvis-data     # find where the volume lives on disk
```

To re-pair while keeping your notes/data, stop the bot and remove just the auth database:

```bash
docker compose down
docker run --rm -v jarvis_jarvis-data:/data busybox rm -f /data/wa-auth.db
docker compose up -d
```

### Backup & restore

The volume lives on one disk, so it is **not a backup** by itself - losing the disk loses the pairing
(a manual re-scan) and all notes, schedules, access lists, and links. Back it up to a timestamped
archive and copy it **off this machine** (ideally on a schedule - cron or Windows Task Scheduler):

```bash
scripts/backup.sh                  # writes ./backups/jarvis-<timestamp>.tar.gz (then copy it off-machine)
scripts/restore.sh backups/jarvis-20260620-153000.tar.gz   # stop the bot first: docker compose down
```

Both run a throwaway `busybox` container against the volume, so they need only Docker. If your compose
project name is not `jarvis`, set `JARVIS_VOLUME` (see `docker volume ls`). Container logs are capped
(`max-size` / `max-file` in `docker-compose.yml`) so they cannot fill the disk.
