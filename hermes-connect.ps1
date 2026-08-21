# Hermes V6 Daily Connector
# Reads profile from setup-client.ps1 and starts the local TCP proxy.
# Uses cloudflared access curl (avoids PowerShell Invoke-RestMethod / Windows curl alias issues).

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
& $CloudflaredPath access login $accessAppUrl 2> $null
if ($LASTEXITCODE -ne 0) {
    Write-Error "cloudflared access login failed."
    exit 1
}
Write-Host "Access authentication successful."

# ---------------------------------------------------------------------------
# 4. Wake sandbox (idempotent — no-op if already awake)
# ---------------------------------------------------------------------------
Write-Host "Waking sandbox..."
$wakeJson = & $CloudflaredPath access curl -s -X POST "$workerUrl/api/wake" 2> $null
if ($LASTEXITCODE -eq 0 -and $wakeJson) {
    try {
        $wakeRes = $wakeJson | ConvertFrom-Json
        Write-Host "Sandbox: $($wakeRes.status)"
    } catch {
        Write-Warning "Non-JSON wake response: $wakeJson"
    }
} else {
    Write-Warning "Wake call failed (may be cold starting or Access token expired)."
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
