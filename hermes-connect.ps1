# Hermes V6 Daily Connector
# Reads profile from setup-client.ps1 and starts the local TCP proxy.
# Uses curl.exe (not PowerShell Invoke-RestMethod) to avoid Windows curl alias issues.

param(
    [string]$ProfilePath = (Join-Path $env:USERPROFILE ".hermes-cloudflare-v6\profile.json"),
    [string]$CloudflaredPath = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
)

# ---------------------------------------------------------------------------
# Helper: find real curl.exe (bypass PowerShell curl alias)
# ---------------------------------------------------------------------------
$curlExe = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
if (-not $curlExe) {
    $candidates = @(
        "C:\Windows\System32\curl.exe",
        "C:\Windows\SysWOW64\curl.exe",
        "${env:ProgramFiles}\curl\bin\curl.exe",
        "${env:LOCALAPPDATA}\Microsoft\WindowsApps\curl.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { $curlExe = $c; break }
    }
}
if (-not $curlExe) {
    Write-Error "curl.exe not found. Install curl or add it to PATH."
    exit 1
}

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

$jwt = & $CloudflaredPath access token -app=$accessAppUrl 2> $null
if (-not $jwt) {
    Write-Error "cloudflared access token returned empty."
    exit 1
}
Write-Host "Access token acquired."

# ---------------------------------------------------------------------------
# 4. Wake sandbox (idempotent — no-op if already awake)
# ---------------------------------------------------------------------------
Write-Host "Waking sandbox..."
$wakeJson = & $curlExe -s -X POST "$workerUrl/api/wake" `
    -H "CF-Access-Jwt-Assertion: $jwt" `
    -H "Content-Type: application/json" 2> $null

if ($LASTEXITCODE -eq 0 -and $wakeJson) {
    try {
        $wakeRes = $wakeJson | ConvertFrom-Json
        Write-Host "Sandbox: $($wakeRes.status)"
    } catch {
        Write-Warning "Non-JSON wake response: $wakeJson"
    }
} else {
    Write-Warning "Wake call failed (exit code $LASTEXITCODE). May be cold starting."
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
