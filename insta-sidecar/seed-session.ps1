# Optional: seed the Docker volume with the local Phase-1 Instagram session, so the container reuses
# the SAME login + device fingerprint (no second login challenge, and one fewer "new device" for
# Instagram to flag). Run it once, AFTER you have a working ./ig-session.json from Phase 1 and after
# `docker compose up -d` has created the volume. Then restart the sidecar.
$ErrorActionPreference = "Stop"

$session = Join-Path $PSScriptRoot "ig-session.json"
if (-not (Test-Path $session)) {
    Write-Error "No '$session' - run Phase 1 first (see README) to create the session."
    exit 1
}

$vol = docker volume ls --format "{{.Name}}" |
    Select-String "insta-data" |
    ForEach-Object { $_.ToString().Trim() } |
    Select-Object -First 1
if (-not $vol) {
    Write-Error "No '*insta-data' Docker volume found. Run 'docker compose up -d' once, then re-run this."
    exit 1
}

Write-Host "Seeding the Phase-1 session into volume: $vol"
docker run --rm -v "${vol}:/data" -v "${PSScriptRoot}:/src:ro" busybox cp /src/ig-session.json /data/ig-session.json
Write-Host "Done. Now restart the sidecar:  docker compose restart insta-sidecar"
