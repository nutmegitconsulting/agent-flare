# Hermes V6 Windows Client Setup
# Run once per machine. Provisions a tunnel, wakes the sandbox, and starts the local TCP proxy.
# Requires: cloudflared CLI (winget install --id Cloudflare.cloudflared)

param(
    [string]$WorkerUrl    = "https://hermes-agent.hermes-test.app",
    [string]$AccessAppUrl = "https://hermes-agent.hermes-test.app",
    [string]$LocalPort    = "9119",
    [string]$CloudflaredPath = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source,
    # V8 (optional): custom domain of your Cloudflare AI Gateway (Access-protected).
    # When set, the script does a second Access login for the gateway, then
    # delivers scripts/reference-providers.json + the gateway Access JWT to the
    # worker, which injects the custom_providers section on wake.
    [string]$GatewayDomain = ""
)

# ---------------------------------------------------------------------------
# 1. Verify cloudflared is installed
# ---------------------------------------------------------------------------
if (-not $CloudflaredPath) {
    Write-Host "cloudflared not found. Install it first:"
    Write-Host "  winget install --id Cloudflare.cloudflared"
    exit 1
}
Write-Host "cloudflared found at: $CloudflaredPath"

# ---------------------------------------------------------------------------
# 2. Authenticate with Cloudflare Access (opens browser once, caches locally)
# ---------------------------------------------------------------------------
Write-Host "`nAuthenticating with Cloudflare Access..."
Write-Host "  App URL: $AccessAppUrl"

& $CloudflaredPath access login $AccessAppUrl 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "cloudflared access login failed (exit code $LASTEXITCODE)."
    exit 1
}
Write-Host "Access authentication successful."

# ---------------------------------------------------------------------------
# 3. Provision tunnel (one-time per user)
# ---------------------------------------------------------------------------
Write-Host "`nProvisioning tunnel via Worker..."

$proc = Start-Process -FilePath $CloudflaredPath `
    -ArgumentList @("access", "curl", "$WorkerUrl/api/client-init", "-s", "-X", "POST") `
    -RedirectStandardOutput "client-init-out.txt" `
    -RedirectStandardError  "client-init-err.txt" `
    -Wait -PassThru -NoNewWindow

$initJson = Get-Content "client-init-out.txt" -Raw -ErrorAction SilentlyContinue
$initErr  = Get-Content "client-init-err.txt"  -Raw -ErrorAction SilentlyContinue
Remove-Item "client-init-out.txt", "client-init-err.txt" -ErrorAction SilentlyContinue

if ($proc.ExitCode -ne 0 -or -not $initJson) {
    Write-Error "cloudflared access curl failed (exit code $($proc.ExitCode)).`nSTDERR:`n$initErr"
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
$sessionToken = $initRes.sessionToken

# Sanitize userId for local use (strip domain from email)
$userId = $userId.Split("@")[0]

if (-not $hostname -or -not $userId) {
    Write-Error "Worker response missing hostname or userId."
    exit 1
}

Write-Host "Tunnel provisioned:"
Write-Host "  User ID:  $userId"
Write-Host "  Hostname: $hostname"

# Display session token for Hermes Desktop GUI
if ($sessionToken) {
    Write-Host ""
    Write-Host "========================================"
    Write-Host "  Hermes Dashboard Session Token"
    Write-Host "========================================"
    Write-Host "$sessionToken"
    Write-Host "========================================"
    Write-Host "Copy the token above into your Hermes Desktop GUI."
    Write-Host ""
}

# ---------------------------------------------------------------------------
# 3b. AI Gateway providers (V8, optional)
#     If -GatewayDomain is set: second Access login for the gateway's custom
#     domain, then deliver the provider config (reference-providers.json,
#     edited for your gateway) + the Access JWT to the worker. The worker
#     injects the custom_providers section into config.yaml on the next wake.
# ---------------------------------------------------------------------------
$providersDelivered = $false
if ($GatewayDomain) {
    $gatewayBase = $GatewayDomain.TrimEnd("/")
    Write-Host "`nAuthenticating with AI Gateway Access..."
    Write-Host "  Gateway domain: $gatewayBase"
    $gwLogin = Start-Process -FilePath $CloudflaredPath `
        -ArgumentList @("access", "login", $gatewayBase) `
        -RedirectStandardOutput "gw-login-out.txt" `
        -RedirectStandardError  "gw-login-err.txt" `
        -Wait -PassThru -NoNewWindow
    $gwToken = (Get-Content "gw-login-out.txt" -Raw -ErrorAction SilentlyContinue).Trim()
    Remove-Item "gw-login-out.txt", "gw-login-err.txt" -ErrorAction SilentlyContinue

    if ($gwLogin.ExitCode -ne 0 -or -not $gwToken -or $gwToken -match "^(https?://|Error|error)") {
        Write-Host "Gateway Access login did not return a token. Skipping provider setup."
        Write-Host "  (Finish the browser login and re-run this script.)"
    } else {
        $providersFile = Join-Path $PSScriptRoot "reference-providers.json"
        if (-not (Test-Path $providersFile)) {
            Write-Error "Providers file not found: $providersFile. Edit scripts/reference-providers.json for your gateway first."
            exit 1
        }
        $providersJson = Get-Content $providersFile -Raw

        Write-Host "Delivering provider config to worker..."
        $putProc = Start-Process -FilePath $CloudflaredPath `
            -ArgumentList @("access", "curl", "$WorkerUrl/api/admin/providers?userId=$userId", "-s", "-X", "PUT", "-H", "Content-Type: application/json", "-d", $providersJson) `
            -RedirectStandardOutput "providers-out.txt" `
            -RedirectStandardError  "providers-err.txt" `
            -Wait -PassThru -NoNewWindow
        $putOut = (Get-Content "providers-out.txt" -Raw -ErrorAction SilentlyContinue).Trim()
        Remove-Item "providers-out.txt", "providers-err.txt" -ErrorAction SilentlyContinue
        if ($putProc.ExitCode -ne 0 -or -not $putOut) {
            Write-Warning "Failed to PUT providers (will retry next run): $putOut"
        } else {
            Write-Host "  Providers stored: $putOut"
            $jwtBody = ('{{"jwt":"{0}"}}' -f $gwToken.Replace('\', '\\').Replace('"', '\"'))
            $jwtProc = Start-Process -FilePath $CloudflaredPath `
                -ArgumentList @("access", "curl", "$WorkerUrl/api/admin/gateway-jwt?userId=$userId", "-s", "-X", "POST", "-H", "Content-Type: application/json", "-d", $jwtBody) `
                -RedirectStandardOutput "jwt-out.txt" `
                -RedirectStandardError  "jwt-err.txt" `
                -Wait -PassThru -NoNewWindow
            $jwtOut = (Get-Content "jwt-out.txt" -Raw -ErrorAction SilentlyContinue).Trim()
            Remove-Item "jwt-out.txt", "jwt-err.txt" -ErrorAction SilentlyContinue
            if ($jwtProc.ExitCode -ne 0 -or -not $jwtOut) {
                Write-Warning "Failed to POST gateway JWT (will retry next run): $jwtOut"
            } else {
                Write-Host "  Gateway JWT stored: $jwtOut"
                $providersDelivered = $true
            }
        }
    }
}

# ---------------------------------------------------------------------------
# 4. Wake sandbox container
# ---------------------------------------------------------------------------
Write-Host "`nWaking sandbox container..."

$proc2 = Start-Process -FilePath $CloudflaredPath `
    -ArgumentList @("access", "curl", "$WorkerUrl/api/wake", "-s", "-X", "POST") `
    -RedirectStandardOutput "wake-out.txt" `
    -RedirectStandardError  "wake-err.txt" `
    -Wait -PassThru -NoNewWindow

$wakeJson = Get-Content "wake-out.txt" -Raw -ErrorAction SilentlyContinue
$wakeErr  = Get-Content "wake-err.txt"  -Raw -ErrorAction SilentlyContinue
Remove-Item "wake-out.txt", "wake-err.txt" -ErrorAction SilentlyContinue

if ($proc2.ExitCode -ne 0 -or -not $wakeJson) {
    Write-Error "cloudflared access curl failed (exit code $($proc2.ExitCode)).`nSTDERR:`n$wakeErr"
    exit 1
}

try {
    $wakeRes = $wakeJson | ConvertFrom-Json
} catch {
    Write-Error "Invalid JSON from Worker: $wakeJson"
    exit 1
}

# ---------------------------------------------------------------------------
# 5. Poll container platform status AND startup script progress in real-time
# ---------------------------------------------------------------------------
Write-Host "`nSandbox status: $($wakeRes.status)"
Write-Host "Container is waking - this may take 2-5 minutes on first boot..."

$maxWaitSeconds = 300
$pollIntervalSeconds = 2
$elapsed = 0
$isReady = $false
$startupComplete = $false
$lastStartupStatus = ""
$platformStatus = "unknown"
$lastPlatformStatus = ""

while ($elapsed -lt $maxWaitSeconds) {
    Start-Sleep -Seconds $pollIntervalSeconds
    $elapsed += $pollIntervalSeconds

    # --- A. Poll startup script status ---
    $statusProc = Start-Process -FilePath $CloudflaredPath `
        -ArgumentList @("access", "curl", "$WorkerUrl/api/debug/exec?userId=$userId&cmd=cat%20/home/hermes/.hermes/.startup-status%202%3E%261%20%7C%7C%20echo%20NOT_STARTED", "-s") `
        -RedirectStandardOutput "startup-out.txt" `
        -RedirectStandardError  "startup-err.txt" `
        -Wait -PassThru -NoNewWindow

    $statusText = Get-Content "startup-out.txt" -Raw -ErrorAction SilentlyContinue
    Remove-Item "startup-out.txt", "startup-err.txt" -ErrorAction SilentlyContinue

    $currentStartupStatus = ""
    if ($statusProc.ExitCode -eq 0 -and $statusText) {
        if ($statusText -match '"stdout"\s*:\s*"([^"]*)"') {
            $currentStartupStatus = $Matches[1] -replace '\\n', ''
        } else {
            $currentStartupStatus = $statusText.Trim()
        }
    }

    # Update startup status display if it changed
    if ($currentStartupStatus -and $currentStartupStatus -ne $lastStartupStatus) {
        $lastStartupStatus = $currentStartupStatus
    }

    # V6 wrote "Startup complete."; V7's final status (same point in boot,
    # immediately before `exec hermes serve`) is "Starting hermes serve...".
    if ($currentStartupStatus -eq "Startup complete." -or $currentStartupStatus -eq "Starting hermes serve...") {
        $startupComplete = $true
    }

    # --- B. Poll platform status every ~10 seconds (every 5th iteration) ---
    if ($elapsed % 10 -eq 0 -or -not $lastPlatformStatus) {
        $pollProc = Start-Process -FilePath $CloudflaredPath `
            -ArgumentList @("access", "curl", "$WorkerUrl/api/admin/status?userId=$userId", "-s") `
            -RedirectStandardOutput "status-out.txt" `
            -RedirectStandardError  "status-err.txt" `
            -Wait -PassThru -NoNewWindow

        $pollJson = Get-Content "status-out.txt" -Raw -ErrorAction SilentlyContinue
        Remove-Item "status-out.txt", "status-err.txt" -ErrorAction SilentlyContinue

        if ($pollProc.ExitCode -eq 0 -and $pollJson) {
            try {
                $pollRes = $pollJson | ConvertFrom-Json
                $state = $pollRes.state
                $platformStatus = if ($state.status) { $state.status } else { "unknown" }

                if ($platformStatus -eq "stopped_with_code") {
                    Write-Host "`nSandbox status: stopped_with_code (exit code $($state.exitCode)) - provisioning may have failed."
                    Write-Host "Response: $pollJson"
                    exit 1
                }

                $lastPlatformStatus = $platformStatus
            } catch {
                $lastPlatformStatus = "unknown"
            }
        }
    }

    # --- C. Show single overwritten line ---
    $displayStatus = if ($lastStartupStatus) { $lastStartupStatus } else { "Container booting..." }
    Write-Host "`r  [Startup] $displayStatus (platform: $lastPlatformStatus, ${elapsed}s)" -NoNewline

    # Exit when both startup is complete and platform is running/healthy
    if ($startupComplete -and ($lastPlatformStatus -eq "running" -or $lastPlatformStatus -eq "healthy")) {
        Write-Host ""  # newline
        $isReady = $true
        break
    }
}

if (-not $isReady) {
    Write-Error "`nTimed out waiting for container after $maxWaitSeconds seconds.`nPlatform: $lastPlatformStatus | Startup: $lastStartupStatus"
    exit 1
}

Write-Host "Container is ready!"

# ---------------------------------------------------------------------------
# 7. Save connection profile for daily use
# ---------------------------------------------------------------------------
$profileDir = Join-Path $env:USERPROFILE ".hermes-cloudflare-v6"
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

$profile = @{
    workerUrl    = $WorkerUrl
    hostname     = $hostname
    userId       = $userId
    sessionToken = $sessionToken
    accessAppUrl = $AccessAppUrl
    localPort    = $LocalPort
    createdAt    = (Get-Date -Format "o")
} | ConvertTo-Json -Depth 3

$profilePath = Join-Path $profileDir "profile.json"
Set-Content -Path $profilePath -Value $profile

Write-Host "Profile saved to: $profilePath"

# ---------------------------------------------------------------------------
# 8. Start local TCP proxy
# ---------------------------------------------------------------------------
Write-Host "`nStarting cloudflared access tcp proxy..."
Write-Host "  Remote:  $hostname"
Write-Host "  Local:   localhost:$LocalPort"
Write-Host "`nLeave this running. Point Hermes Desktop GUI to localhost:$LocalPort"
Write-Host "Press Ctrl+C to stop.`n"

& $CloudflaredPath access tcp --hostname $hostname --url localhost:$LocalPort
