# Reproducible Docker setup for the Instagram bridge - the exact, repeatable steps to put your
# Instagram credentials on Jarvis. Run from anywhere:
#   .\insta-sidecar\setup.ps1          # fresh login from IG_USERNAME / IG_PASSWORD in .env
#   .\insta-sidecar\setup.ps1 -Seed    # reuse the local Phase-1 session (same device, no challenge)
param([switch]$Seed)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

# 1) Require the key .env values.
$envFile = Join-Path $root ".env"
if (-not (Test-Path $envFile)) {
    Write-Error "No .env at $root. Copy .env.example to .env and fill it in."; exit 1
}
$envText = Get-Content $envFile -Raw
foreach ($k in @("OWNER_JID", "INSTAGRAM_SIDECAR_URL", "INSTAGRAM_SIDECAR_TOKEN", "IG_USERNAME")) {
    if ($envText -notmatch "(?m)^\s*$([regex]::Escape($k))\s*=\s*\S") {
        Write-Error "Set $k in .env before running this."; exit 1
    }
}
Write-Host "[1/4] .env looks complete."

Push-Location $root
try {
    # 2) Build + start. The sidecar auto-logs-in on boot and persists the session in the volume.
    Write-Host "[2/4] docker compose --profile instagram up -d --build ..."
    docker compose --profile instagram up -d --build

    # 3) Optional: reuse the Phase-1 session (same device, avoids a login challenge).
    if ($Seed) {
        Write-Host "[3/4] Seeding the local Phase-1 session ..."
        & (Join-Path $PSScriptRoot "seed-session.ps1")
        docker compose --profile instagram restart insta-sidecar
    } else {
        Write-Host "[3/4] Fresh login from IG_USERNAME / IG_PASSWORD (use -Seed to reuse a Phase-1 session)."
    }

    # 4) Wait for the Instagram login (healthy), or report that a code is needed.
    Write-Host "[4/4] Waiting for the Instagram login (up to ~2 min) ..."
    $cid = docker compose --profile instagram ps -q insta-sidecar
    if ($cid) { $cid = $cid.Trim() }
    for ($i = 0; $i -lt 24; $i++) {
        Start-Sleep -Seconds 5
        $h = ""
        if ($cid) { try { $h = (docker inspect --format '{{.State.Health.Status}}' $cid 2>$null).Trim() } catch {} }
        Write-Host "    health: $h"
        if ($h -eq "healthy") {
            Write-Host "`nDONE - logged in to Instagram. In WhatsApp:"
            Write-Host "  jarvis ig                 (status)"
            Write-Host "  jarvis ig read <user>     (read a conversation)"
            Write-Host "  jarvis ig <user> <msg>    (send a DM)"
            exit 0
        }
    }
    Write-Host "`nNot logged in yet. In WhatsApp run 'jarvis ig':"
    Write-Host "  - 'challenge_required' -> 'jarvis ig code <the code Instagram sent>'"
    Write-Host "  - otherwise check logs: docker compose logs -f insta-sidecar"
} finally {
    Pop-Location
}
