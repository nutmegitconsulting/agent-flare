# Hermes V6 Daily Connector
# Reads profile from setup-client.ps1 and starts the local TCP proxy.
# Re-authenticates with Cloudflare Access silently if cached, falls back to browser.

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

$workerUrl    = $profile.workerUrl
$hostname     = $profile.hostname
$accessAppUrl = $profile.accessAppUrl
$localPort    = if ($profile.localPort) { $profile.localPort } else { "9119" }

# ---------------------------------------------------------------------------
# 2. Verify cloudflared
# ---------------------------------------------------------------------------
if (-not $CloudflaredPath) {
    Write-Error "cloudflared not found. Install: winget install --id Cloudflare.cloudflared"
    exit 1
}

# ---------------------------------------------------------------------------
# 3. Re-authenticate with Cloudflare Access
# ---------------------------------------------------------------------------
Write-Host "Authenticating with Cloudflare Access..."
$jwt = & $CloudflaredPath access token -app=$accessAppUrl 2> $null

if (-not $jwt) {
    Write-Host "No cached token. Running cloudflared access login..."
    & $CloudflaredPath access login $accessAppUrl 2> $null

    $jwt = & $CloudflaredPath access token -app=$accessAppUrl 2> $null
    if (-not $jwt) {
        Write-Error "Access authentication failed. Complete browser login and retry."
        exit 1
    }
}

Write-Host "Access authentication successful."

# ---------------------------------------------------------------------------
# 4. Wake sandbox (idempotent — no-op if already awake)
# ---------------------------------------------------------------------------
Write-Host "Waking sandbox..."
try {
    $wakeRes = Invoke-RestMethod -Uri "$workerUrl/api/wake" `
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
Write-Host "`nStarting cloudflared access tcp proxy on localhost:$localPort..."
Write-Host "Remote: $hostname"
Write-Host "Leave this running. Open Hermes Desktop GUI and connect."
Write-Host ""
Write-Host "Press Ctrl+C to stop.`n"

& $CloudflaredPath access tcp --hostname $hostname --url localhost:$localPort
