# Bring Jarvis up after a host (re)boot. Waits for the Docker daemon, then `docker compose up -d`.
# Register this as a startup task so the bot survives reboots while keeping `restart: on-failure`
# (so the in-chat `jarvis shutdown` still stays down). See the README "Survive a reboot" section.
$ErrorActionPreference = 'Stop'
Set-Location -Path (Join-Path $PSScriptRoot '..')

# Docker Desktop's daemon can take a while to come up at boot; wait for it (up to ~5 min).
for ($i = 0; $i -lt 60; $i++) {
  docker info *> $null
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep -Seconds 5
}
docker compose up -d
Write-Host "Jarvis started (docker compose up -d)."
