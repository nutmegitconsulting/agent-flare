# Hermes V6 Windows Client Setup
# Run once per machine. Provisions a tunnel, wakes the sandbox, and starts the local TCP proxy.
# Requires: cloudflared CLI (winget install --id Cloudflare.cloudflared)

param(
    [string]$WorkerUrl    = "https://hermes-agent.hermes-test.app",
    [string]$AccessAppUrl = "https://hermes-agent.hermes-test.app",
    [string]$LocalPort    = "9119",
    [string]$CloudflaredPath = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
)

# ---------------------------------------------------------------------------
# Helper: find real curl.exe (bypass PowerShell curl alias)
# ---------------------------------------------------------------------------
$curlExe = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
if (-not $curlExe) {
    # Try common locations
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
# 1. Verify cloudflared is installed
# ---------------------------------------------------------------------------
if (-not $CloudflaredPath) {
    Write-Host "cloudflared not found. Install it first:"
    Write-Host "  winget install --id Cloudflare.cloudflared"
    exit 1
}
Write-Host "cloudflared found at: $CloudflaredPath"
Write-Host "curl.exe found at: $curlExe"

# ---------------------------------------------------------------------------
# 2. Authenticate with Cloudflare Access
# ---------------------------------------------------------------------------
Write-Host "`nAuthenticating with Cloudflare Access..."
Write-Host "  App URL: $AccessAppUrl"

# Explicit login first (opens browser, caches token locally)
& $CloudflaredPath access login $AccessAppUrl 2> $null
if ($LASTEXITCODE -ne 0) {
    Write-Error "cloudflared access login failed."
    exit 1
}

# Retrieve cached token (documented command)
$jwt = & $CloudflaredPath access token -app=$AccessAppUrl 2> $null
if (-not $jwt) {
    Write-Error "cloudflared access token returned empty. Complete browser login and retry."
    exit 1
}

Write-Host "Access token acquired."

# ---------------------------------------------------------------------------
# 3. Provision tunnel (one-time per user)
# ---------------------------------------------------------------------------
Write-Host "`nProvisioning tunnel via Worker..."

$initJson = & $curlExe -s -X POST "$WorkerUrl/api/client-init" `
    -H "CF-Access-Jwt-Assertion: $jwt" `
    -H "Content-Type: application/json" 2> $null

if ($LASTEXITCODE -ne 0 -or -not $initJson) {
    Write-Error "HTTP request to /api/client-init failed (curl exit code $LASTEXITCODE, empty response)."
    exit 1
}

try {
    $initRes = $initJson | ConvertFrom-Json
} catch {
    Write-Error "Invalid JSON from Worker: $initJson"
    exit 1
}

$hostname = $initRes.hostname
$userId   = $initRes.userId

if (-not $hostname -or -not $userId) {
    Write-Error "Worker response missing hostname or userId."
    exit 1
}

Write-Host "Tunnel provisioned:"
Write-Host "  User ID:  $userId"
Write-Host "  Hostname: $hostname"

# ---------------------------------------------------------------------------
# 4. Wake sandbox container
# ---------------------------------------------------------------------------
Write-Host "`nWaking sandbox container..."

$wakeJson = & $curlExe -s -X POST "$WorkerUrl/api/wake" `
    -H "CF-Access-Jwt-Assertion: $jwt" `
    -H "Content-Type: application/json" 2> $null

if ($LASTEXITCODE -ne 0 -or -not $wakeJson) {
    Write-Error "HTTP request to /api/wake failed."
    exit 1
}

try {
    $wakeRes = $wakeJson | ConvertFrom-Json
} catch {
    Write-Error "Invalid JSON from Worker: $wakeJson"
    exit 1
}

Write-Host "Sandbox status: $($wakeRes.status)"

# ---------------------------------------------------------------------------
# 5. Save connection profile for daily use
# ---------------------------------------------------------------------------
$profileDir = Join-Path $env:USERPROFILE ".hermes-cloudflare-v6"
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

$profile = @{
    workerUrl    = $WorkerUrl
    hostname     = $hostname
    userId       = $userId
    accessAppUrl = $AccessAppUrl
    localPort    = $LocalPort
    createdAt    = (Get-Date -Format "o")
} | ConvertTo-Json -Depth 3

$profilePath = Join-Path $profileDir "profile.json"
Set-Content -Path $profilePath -Value $profile

Write-Host "`nProfile saved to: $profilePath"

# ---------------------------------------------------------------------------
# 6. Start local TCP proxy
# ---------------------------------------------------------------------------
Write-Host "`nStarting cloudflared access tcp proxy..."
Write-Host "  Remote:  $hostname"
Write-Host "  Local:   localhost:$LocalPort"
Write-Host "`nLeave this running. Point Hermes Desktop GUI to localhost:$LocalPort"
Write-Host "Press Ctrl+C to stop.`n"

& $CloudflaredPath access tcp --hostname $hostname --url localhost:$LocalPort
