# =============================================================================
# build-and-push.ps1 — rebuild the Hermes Sandbox image (no cache) and push it
# to the Cloudflare registry.
#
# WHY --no-cache: install.sh | bash is a RUN layer, and Docker's build cache
# reuses it silently — a plain rebuild after a Hermes release ships the OLD
# agent. This script forces a clean install layer, then VERIFIES the installed
# version inside the image BEFORE uploading ~1GB to the registry.
#
# Usage (from the repo root or anywhere):
#   powershell -ExecutionPolicy Bypass -File scripts\build-and-push.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\build-and-push.ps1 -Deploy
#
# Prereqs: Docker Desktop running, npm/npx, wrangler authenticated
# (npx wrangler login).
# =============================================================================
param(
    [switch]$Deploy
)

$ErrorActionPreference = "Stop"

# --- Repo root (script lives in scripts\) ---
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$ImageName = "hermes-cloudflare-v6-hermessandbox"
$ImageTag  = "worker"
$Image     = "$ImageName:$ImageTag"

Write-Host "==> Rebuilding $Image with --no-cache (fresh Hermes install)..."
docker build --no-cache -f Dockerfile -t $Image .
if ($LASTEXITCODE -ne 0) { Write-Error "docker build failed (exit $LASTEXITCODE)."; exit 1 }

Write-Host ""
Write-Host "==> Verifying Hermes version inside the new image..."
$versionOut = docker run --rm --entrypoint /bin/bash $Image -c `
    'su hermes -c "HERMES_HOME=/home/hermes/.hermes /usr/local/bin/hermes --version" 2>&1'
if ($LASTEXITCODE -ne 0) { Write-Error "version check failed to run (exit $LASTEXITCODE)."; exit 1 }
$versionOut | ForEach-Object { Write-Host "    $_" }
# No freshness gate: --no-cache is the freshness guarantee (the install layer
# re-runs every build). Hermes' "Up to date" line is unreliable inside the
# image (network update check as non-root can silently return nothing).

Write-Host ""
Write-Host "==> Pushing to Cloudflare registry..."
# Registry uploads are chunked and can fail transiently ("blob unknown to
# registry"); retry up to 3 times — already-uploaded layers are skipped.
$pushed = $false
for ($attempt = 1; $attempt -le 3 -and -not $pushed; $attempt++) {
    npx wrangler containers push $Image 2>&1 | Select-Object -Last 20 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -eq 0) {
        $pushed = $true
    } else {
        Write-Host "==> Push attempt ${attempt} failed (exit $LASTEXITCODE)."
        if ($attempt -lt 3) { Write-Host "    Retrying in 10s..."; Start-Sleep -Seconds 10 }
    }
}
if (-not $pushed) {
    Write-Error "Push failed after 3 attempts."
    exit 1
}

Write-Host ""
Write-Host "==> Push complete."
Write-Host "    Image: $Image"

if ($Deploy) {
    Write-Host ""
    Write-Host "==> Running wrangler deploy (activates the new image digest)..."
    npx wrangler deploy
    if ($LASTEXITCODE -ne 0) { Write-Error "wrangler deploy failed (exit $LASTEXITCODE)."; exit 1 }
    Write-Host "==> Deploy complete."
} else {
    Write-Host ""
    Write-Host "NOTE: run 'npx wrangler deploy' (or re-run with -Deploy) to point"
    Write-Host "      the Worker at the new image digest."
}
