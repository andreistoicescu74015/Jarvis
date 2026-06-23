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
persists data, and runs unattended in Docker. With an AI provider configured (`GITHUB_MODELS_TOKEN` -
see `.env.example`) anyone who may use it can also phrase a command in plain language, and the owner
can switch on a chatbot mode for general questions. See [Commands](#commands).

## Commands

Address the bot as `jarvis <command>` or by @mentioning it, in a DM or a group. `jarvis help` lists
what *you* can run where you are; `jarvis man <command>` explains one in detail.

**Anyone**

- `jarvis ping` - check the bot is alive.
- `jarvis help` / `jarvis man <command>` - list commands / detailed help.
- `jarvis note add <text> | list | get <n> | del <n> | clear` - notes scoped to this chat.

**Group admins** (in an active group; the owner too, anywhere)

- `jarvis whitelist ...` / `jarvis blacklist ...` - control who may use a command (or the whole bot, `*`) here; `jarvis whitelist` alone shows the rules.
- `jarvis schedule in <2h> <msg> | at <date> <time> <msg> | every <1d> <msg> | list | cancel <id>` - post a message later.
- `jarvis link | link new | link accept <code> | link remove` - share one data context with another group.

**Owner**

- `jarvis owner | owner claim | owner resign` - who owns the bot; claim or resign.
- `jarvis whoami [<@user|number>]` - show who you are, or look a person up.
- `jarvis groups [activate|deactivate [<id>]]` - list and authorize the groups the bot runs in.
- `jarvis community [activate|deactivate [<id>]]` - show a community, or authorize all its groups at once.
- `jarvis ai [on|off]` - turn chatbot mode on/off for this chat (see below).
- `jarvis ig ...` - read and send Instagram DMs (and groups) from WhatsApp; needs the Instagram bridge (see [Instagram](#instagram-optional)).
- `jarvis reset [all]` - clear this chat's data, or wipe everything.
- `jarvis shutdown` / `jarvis restart` / `jarvis logout` - lifecycle (details under [Owner commands](#owner-commands-in-chat)).

### Natural language

With an AI provider configured (`GITHUB_MODELS_TOKEN`), an addressed message that isn't an exact
command is mapped to one or more commands - for anyone who may use Jarvis there, each still subject to
every permission check. Jarvis echoes what it understood (`Understood: jarvis ...`) and runs it. A
**sensitive** command - one that affects the bot itself (`owner`, `reset`, `shutdown`, `restart`,
`logout`) or destroys data (`note clear`, `schedule clear`, `link remove`, `groups deactivate`) - is
never auto-run from a guess; Jarvis asks you to type it. The owner can turn on a **chatbot mode** per
chat with `jarvis ai on`, so Jarvis also answers general questions when nothing maps to a command.
Without a token, only exact commands work.

## Instagram (optional)

Read and send your Instagram DMs - including group chats - from WhatsApp, so you can keep a
conversation going without opening the Instagram app. A small Python "sidecar" (`insta-sidecar/`) logs
into an Instagram account via the unofficial `instagrapi` library; Jarvis talks to it over the internal
Docker network. It is part of the compose stack, so it starts with the normal `docker compose up`.

> **Unofficial = against Instagram's Terms and at real ban risk. Use a test / dedicated account.**

**Set up (once):**

1. In `.env`, set your owner id and the Instagram values (leave `IG_USERNAME` empty to keep the bridge off):

   ```bash
   OWNER_JID=40712345678@s.whatsapp.net      # run `jarvis whoami` in a DM with the bot to get yours
   INSTAGRAM_SIDECAR_URL=http://insta-sidecar:8099
   INSTAGRAM_SIDECAR_TOKEN=<a long random secret>    # e.g. python -c "import secrets;print(secrets.token_hex(32))"
   IG_USERNAME=your_test_account
   IG_PASSWORD=your_password
   # IG_PROXY=http://user:pass@host:port      # residential/mobile proxy - recommended
   ```

2. Build and start. **`--build` is required** so the image includes the `ig` command (without it,
   Docker reuses an old image and `jarvis ig` is reported as an unknown command):

   ```bash
   docker compose up -d --build
   ```

   The sidecar logs into Instagram on its own; `docker ps` shows `insta-sidecar` as `healthy` once
   logged in. If Instagram asks for a verification code, run `jarvis ig code <value>` in WhatsApp.

**Use (in WhatsApp, as the owner):**

- `jarvis ig` - bridge status (logged in? a code needed? how many sent this hour).
- `jarvis ig read <person> [count]` - show the last messages of a 1:1 (default 10), then reply.
- `jarvis ig <person> <message>` - send a DM.
- `jarvis ig list` then `jarvis ig read <n>` / `jarvis ig to <n> <message>` - read/send a **group** (or DM) by its number.
- `jarvis ig code <value>` - answer a login challenge (2FA / checkpoint).

`jarvis ig` is **owner-only** (you must be the owner - set `OWNER_JID`, or run `jarvis owner claim` in a
DM). The full design, safety posture, and standalone testing steps are in [`insta/`](insta/) and
[`insta-sidecar/README.md`](insta-sidecar/README.md).

**If `jarvis ig` says it is an unknown command**, the running image predates the command - rebuild it:
`docker compose up -d --build`.

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

### Survive a reboot

`restart: on-failure` keeps `jarvis shutdown` working (a clean exit stays down), but it does **not**
bring the container back after a host reboot (e.g. a Windows update). To restore it on boot while
keeping that policy, register `scripts/start.ps1` (it waits for Docker, then `docker compose up -d`)
as a startup task - once, in an elevated PowerShell, adjusting the path:

```powershell
schtasks /Create /SC ONLOGON /TN Jarvis /TR "powershell -NoProfile -ExecutionPolicy Bypass -File \"D:\GitHub\Jarvis\scripts\start.ps1\""
```

(Also enable Docker Desktop's "start when you log in".) If you would rather not run a task, set the
service's `restart` to `unless-stopped` in `docker-compose.yml` - it survives reboots natively, but then
`jarvis shutdown` no longer stays down; stop the bot with `docker compose stop` instead.

### Health

The container reports a **healthcheck**: while connected, the bot stamps a heartbeat that the check
reads, so `docker ps` shows `healthy` / `unhealthy` (unhealthy means the bot is wedged or has been
disconnected too long). Plain Compose does not auto-restart on unhealthy - the connection layer already
exits on unrecoverable states (so `on-failure` recovers those) - but you can pair an autohealer or an
orchestrator that acts on health.

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
