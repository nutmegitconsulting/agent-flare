# Hermes V6 Daily Connector
# Reads profile from setup-client.ps1 and starts the local TCP proxy.

param(
  [string]$ProfilePath = (Join-Path $env:USERPROFILE ".hermes-cloudflare-v6\profile.json"),
  [string]$CloudflaredPath = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
)

# ---------------------------------------------------------------------------
# 1. Load profile
# ---------------------------------------------------------------------------
if (-not (Test-Path $ProfilePath)) {
  Write-Error "Profile not found at $ProfilePath. Run setup-client.ps1 first."
  exit 1
}

$profile = Get-Content $ProfilePath | ConvertFrom-Json

# ---------------------------------------------------------------------------
# 2. Verify cloudflared
# ---------------------------------------------------------------------------
if (-not $CloudflaredPath) {
  Write-Error "cloudflared not found. Install: winget install --id Cloudflare.cloudflared"
  exit 1
}

# ---------------------------------------------------------------------------
# 3. Get fresh Cloudflare Access JWT
# ---------------------------------------------------------------------------
Write-Host "Getting Cloudflare Access token..."
$jwt = & $CloudflaredPath access token -app=$profile.accessAppUrl 2> $null

if (-not $jwt) {
  Write-Host "Not authenticated. Opening browser for Cloudflare Access login..."
  Start-Process $profile.accessAppUrl
  Read-Host "Sign in, then press Enter to continue"

  $jwt = & $CloudflaredPath access token -app=$profile.accessAppUrl 2> $null
  if (-not $jwt) {
    Write-Error "Failed to get Access JWT."
    exit 1
  }
}

# ---------------------------------------------------------------------------
# 4. Wake sandbox (idempotent — no-op if already awake)
# ---------------------------------------------------------------------------
Write-Host "Waking sandbox..."
try {
  $wakeRes = Invoke-RestMethod -Uri "$($profile.workerUrl)/api/wake" `
    -Method POST `
    -Headers @{ "CF-Access-Jwt-Assertion" = $jwt } `
    -ContentType "application/json"
  Write-Host "Sandbox: $($wakeRes.status)"
} catch {
  Write-Warning "Wake call failed (may be cold starting): $($_.Exception.Message)"
}

# ---------------------------------------------------------------------------
# 5. Start local TCP proxy
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "Starting cloudflared access tcp proxy on localhost:9119..."
Write-Host "Leave this running. Open Hermes Desktop GUI and connect."
Write-Host ""
Write-Host "Ctrl+C to stop."
Write-Host ""

& $CloudflaredPath access tcp --hostname $profile.hostname --url localhost:9119
