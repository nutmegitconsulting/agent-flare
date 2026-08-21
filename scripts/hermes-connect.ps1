# Hermes V6 Daily Connector
# Reads profile from setup-client.ps1 and starts the local TCP proxy.
# Uses cloudflared access curl for HTTP calls (avoids PowerShell Invoke-RestMethod issues).

param(
    [string]$ProfilePath = (Join-Path $env:USERPROFILE ".hermes-cloudflare-v6\profile.json"),
    [string]$CloudflaredPath = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
)

# ---------------------------------------------------------------------------
# 1. Load profile
# ---------------------------------------------------------------------------
if (-not (Test-Path $ProfilePath)) {
    Write-Error "Profile not found at $ProfilePath. Run scripts\setup-client.ps1 first."
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
& $CloudflaredPath access login $accessAppUrl 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "cloudflared access login failed (exit code $LASTEXITCODE)."
    exit 1
}
Write-Host "Access authentication successful."

# ---------------------------------------------------------------------------
# 4. Wake sandbox (idempotent — no-op if already awake)
# ---------------------------------------------------------------------------
Write-Host "Waking sandbox..."

$proc = Start-Process -FilePath $CloudflaredPath `
    -ArgumentList @("access", "curl", "$workerUrl/api/wake", "-s", "-X", "POST") `
    -RedirectStandardOutput "wake-out.txt" `
    -RedirectStandardError  "wake-err.txt" `
    -Wait -PassThru -NoNewWindow

$wakeJson = Get-Content "wake-out.txt" -Raw -ErrorAction SilentlyContinue
$wakeErr  = Get-Content "wake-err.txt"  -Raw -ErrorAction SilentlyContinue
Remove-Item "wake-out.txt", "wake-err.txt" -ErrorAction SilentlyContinue

if ($proc.ExitCode -eq 0 -and $wakeJson) {
    try {
        $wakeRes = $wakeJson | ConvertFrom-Json
        Write-Host "Sandbox: $($wakeRes.status)"
    } catch {
        Write-Warning "Non-JSON wake response: $wakeJson"
    }
} else {
    Write-Warning "Wake call failed (exit code $($proc.ExitCode)).`nSTDERR:`n$wakeErr"
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
