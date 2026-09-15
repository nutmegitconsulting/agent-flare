# Hermes V6/V7/V8 Windows Client Launcher
# Run once per machine to provision, or daily to resume.
# Usage:
#   .\hermes-client.ps1                    # full setup then supervised tunnel
#   .\hermes-client.ps1 -LaunchDesktop       # same + auto-start Hermes Desktop
#   .\hermes-client.ps1 -LaunchDesktop -AutoConfigure
#                                            # same + writes gui_config.json
#   .\hermes-client.ps1 -TunnelOnly        # supervised tunnel, no desktop
#   .\hermes-client.ps1 -ForceSetup        # ignore saved profile, re-provision

param(
    [string]$WorkerUrl    = "https://hermes-agent.hermes-test.app",
    [string]$AccessAppUrl = "https://hermes-agent.hermes-test.app",
    [string]$LocalPort    = "9119",
    [string]$CloudflaredPath = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source,
    [string]$GatewayDomain = "",
    [switch]$LaunchDesktop,
    [string]$HermesDesktopPath = "",
    [switch]$AutoConfigure,
    [switch]$TunnelOnly,
    [switch]$ForceSetup
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Find-HermesDesktop {
    # -HermesDesktopPath wins if explicitly given; otherwise the Nous
    # Research Windows installer default (per-user, via LOCALAPPDATA).
    if ($HermesDesktopPath -and (Test-Path $HermesDesktopPath)) {
        return $HermesDesktopPath
    }
    $nousDefault = Join-Path $env:LOCALAPPDATA "hermes\hermes-agent\apps\desktop\release\win-unpacked\Hermes.exe"
    if (Test-Path $nousDefault) { return $nousDefault }
    return $null
}

function Invoke-CloudflaredLogin {
    param([string]$AppUrl)
    Write-Host "Authenticating with Cloudflare Access..."
    Write-Host "  App URL: $AppUrl"
    & $CloudflaredPath access login $AppUrl 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "cloudflared access login failed (exit code $LASTEXITCODE)."
        exit 1
    }
    Write-Host "Access authentication successful."
}

function Invoke-SandboxWake {
    param(
        [string]$WorkerUrl,
        [string]$UserId,
        [string]$CloudflaredExe,
        [string]$ProfileDir
    )

    # The tunnel's connector lives INSIDE the sandbox container. If the
    # container idled out, the local proxy starts fine but every origin
    # connection dies with "websocket: bad handshake". Wake first.
    if (-not $UserId) {
        Write-Warning "No userId in profile -- skipping sandbox wake."
        return
    }

    Write-Host ""
    Write-Host "Waking sandbox container (ensures tunnel origin is alive)..."

    $wakeOutFile = Join-Path $ProfileDir "wake-out.txt"
    $wakeErrFile = Join-Path $ProfileDir "wake-err.txt"
    $wakeArgs = @{
        FilePath               = $CloudflaredExe
        ArgumentList           = @("access", "curl", "$WorkerUrl/api/wake", "-s", "-X", "POST")
        RedirectStandardOutput = $wakeOutFile
        RedirectStandardError  = $wakeErrFile
        Wait                   = $true
        PassThru               = $true
        NoNewWindow            = $true
    }
    $wakeProc = Start-Process @wakeArgs
    $wakeJson = Get-Content $wakeOutFile -Raw -ErrorAction SilentlyContinue
    Remove-Item $wakeOutFile, $wakeErrFile -ErrorAction SilentlyContinue

    if ($wakeProc.ExitCode -ne 0 -or -not $wakeJson) {
        Write-Warning "Wake call failed (exit code $($wakeProc.ExitCode)) -- continuing; container may still be booting."
        return
    }

    $state = "unknown"
    try {
        $wakeRes = $wakeJson | ConvertFrom-Json
        if ($wakeRes.state -and $wakeRes.state.status) { $state = $wakeRes.state.status }
        elseif ($wakeRes.status) { $state = $wakeRes.status }
    } catch { }
    Write-Host ("  Sandbox state after wake: {0}" -f $state)

    if ($state -eq "running" -or $state -eq "healthy") { return }

    # Container still booting -- poll up to 120s more, then continue anyway
    Write-Host "  Container booting -- waiting (max 120s)..."
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 5
        $stOutFile = Join-Path $ProfileDir "wake-status.txt"
        $stErrFile = Join-Path $ProfileDir "wake-status-err.txt"
        $stArgs = @{
            FilePath               = $CloudflaredExe
            ArgumentList           = @("access", "curl", "$WorkerUrl/api/admin/status?userId=$UserId", "-s")
            RedirectStandardOutput = $stOutFile
            RedirectStandardError  = $stErrFile
            Wait                   = $true
            PassThru               = $true
            NoNewWindow            = $true
        }
        $stProc = Start-Process @stArgs
        $stJson = Get-Content $stOutFile -Raw -ErrorAction SilentlyContinue
        Remove-Item $stOutFile, $stErrFile -ErrorAction SilentlyContinue
        if ($stProc.ExitCode -eq 0 -and $stJson) {
            try {
                $stRes = $stJson | ConvertFrom-Json
                if ($stRes.state -and $stRes.state.status) {
                    $state = $stRes.state.status
                    Write-Host ("  Sandbox state: {0}" -f $state)
                    if ($state -eq "running" -or $state -eq "healthy") { return }
                }
            } catch { }
        }
    }
    Write-Warning "Container not healthy after 120s -- starting tunnel anyway. First requests may fail until it boots."
}

function Start-HermesSession {
    param(
        [string]$Hostname,
        [string]$SessionToken = ""
    )

    # Optionally pre-configure Hermes Desktop GUI
    if ($AutoConfigure -and $SessionToken) {
        $hermesDir = Join-Path $env:USERPROFILE ".hermes"
        New-Item -ItemType Directory -Force -Path $hermesDir | Out-Null
        $guiConfig = @{
            endpoint      = "http://localhost:$LocalPort"
            session_token = $SessionToken
        } | ConvertTo-Json -Depth 3
        $guiConfigPath = Join-Path $hermesDir "gui_config.json"
        $guiConfig | Set-Content -Path $guiConfigPath
        Write-Host "gui_config.json written: $guiConfigPath"
    }

    # If user asked for desktop but did not give a path, hunt for it once
    $resolvedDesktopPath = $null
    if ($LaunchDesktop -and -not $TunnelOnly) {
        $resolvedDesktopPath = Find-HermesDesktop
        if (-not $resolvedDesktopPath) {
            Write-Warning "Hermes Desktop not found in default locations. Set -HermesDesktopPath explicitly."
        }
    }

    Write-Host ""
    Write-Host "Starting tunnel in the FOREGROUND (this window IS the tunnel)."
    Write-Host "  Remote:  $Hostname"
    Write-Host "  Local:   localhost:$LocalPort"
    Write-Host "Ctrl+C stops the tunnel and ends the session."
    Write-Host ""

    # Launch the desktop app first (it runs in the background and retries
    # its connection), then bind the tunnel a moment later. Launching via
    # explorer.exe gives true double-click semantics: the app inherits no
    # console from us (its stderr cannot flood this window) and no
    # SW_HIDE flag reaches its GUI. (Plain Start-Process attached this
    # console-attached Electron build's stderr to our console;
    # -WindowStyle Hidden suppressed its GUI window entirely.)
    if ($resolvedDesktopPath) {
        Start-Process -FilePath "explorer.exe" -ArgumentList "`"$resolvedDesktopPath`""
        Write-Host "Hermes Desktop launched (detached): $resolvedDesktopPath"
        Start-Sleep -Seconds 3
    }

    try {
        # Foreground native call: live console output, and Ctrl+C kills the
        # tunnel directly (no hidden child to orphan). cloudflared handles
        # edge reconnects itself; the container was already woken upstream.
        & $CloudflaredPath access tcp --hostname $Hostname --url "localhost:$LocalPort"
    } finally {
        Write-Host ""
        Write-Host "Hermes session ended."
    }
}

# ---------------------------------------------------------------------------
# Resume path: daily re-run using saved profile
# ---------------------------------------------------------------------------
$profileDir  = Join-Path $env:USERPROFILE ".hermes-cloudflare-v6"
$profilePath = Join-Path $profileDir "profile.json"

if ((Test-Path $profilePath) -and -not $ForceSetup) {
    Write-Host "Profile found -- resuming session."
    Write-Host ""
    $profile = Get-Content $profilePath -Raw | ConvertFrom-Json

    $WorkerUrl    = $profile.workerUrl
    $hostname     = $profile.hostname
    $userId       = $profile.userId
    $sessionToken = $profile.sessionToken
    $AccessAppUrl = $profile.accessAppUrl
    $LocalPort    = $profile.localPort

    # Refresh Access login
    if (-not $CloudflaredPath) {
        Write-Error "cloudflared not found. Install: winget install --id Cloudflare.cloudflared"
        exit 1
    }
    Invoke-CloudflaredLogin -AppUrl $AccessAppUrl

    # Self-heal: wake the container so the tunnel origin exists before we
    # supervise. Skipped wakes leave the proxy up but the origin dead.
    Invoke-SandboxWake -WorkerUrl $WorkerUrl -UserId $userId -CloudflaredExe $CloudflaredPath -ProfileDir $profileDir

    Start-HermesSession -Hostname $hostname -SessionToken $sessionToken
    exit 0
}

# ---------------------------------------------------------------------------
# Full setup path (one-time per machine, or -ForceSetup)
# ---------------------------------------------------------------------------
if (-not $CloudflaredPath) {
    Write-Host "cloudflared not found. Install it first:"
    Write-Host "  winget install --id Cloudflare.cloudflared"
    exit 1
}
Write-Host "cloudflared found at: $CloudflaredPath"

# Temp capture files for cloudflared access curl calls live here, not CWD
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

# ---------------------------------------------------------------------------
# 1. Authenticate with Cloudflare Access
# ---------------------------------------------------------------------------
Invoke-CloudflaredLogin -AppUrl $AccessAppUrl

# ---------------------------------------------------------------------------
# 2. Provision tunnel (one-time per user)
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "Provisioning tunnel via Worker..."

$initOutFile = Join-Path $profileDir "client-init-out.txt"
$initErrFile = Join-Path $profileDir "client-init-err.txt"
$initSpArgs = @{
    FilePath               = $CloudflaredPath
    ArgumentList           = @("access", "curl", "$WorkerUrl/api/client-init", "-s", "-X", "POST")
    RedirectStandardOutput = $initOutFile
    RedirectStandardError  = $initErrFile
    Wait                   = $true
    PassThru               = $true
    NoNewWindow            = $true
}
$proc = Start-Process @initSpArgs

$initJson = Get-Content $initOutFile -Raw -ErrorAction SilentlyContinue
$initErr  = Get-Content $initErrFile  -Raw -ErrorAction SilentlyContinue
Remove-Item $initOutFile, $initErrFile -ErrorAction SilentlyContinue

if ($proc.ExitCode -ne 0 -or -not $initJson) {
    Write-Error "cloudflared access curl failed (exit code $($proc.ExitCode)).STDERR:$initErr"
    exit 1
}

try {
    $initRes = $initJson | ConvertFrom-Json
} catch {
    Write-Error "Invalid JSON from Worker: $initJson"
    exit 1
}

$hostname     = $initRes.hostname
$userId       = $initRes.userId
$sessionToken = $initRes.sessionToken
$userId       = $userId.Split("@")[0]

if (-not $hostname -or -not $userId) {
    Write-Error "Worker response missing hostname or userId."
    exit 1
}

Write-Host "Tunnel provisioned:"
Write-Host "  User ID:  $userId"
Write-Host "  Hostname: $hostname"

if ($sessionToken) {
    Write-Host ""
    Write-Host "========================================"
    Write-Host "  Hermes Dashboard Session Token"
    Write-Host "========================================"
    Write-Host "$sessionToken"
    Write-Host "========================================"
    Write-Host ""
}

# ---------------------------------------------------------------------------
# 3. AI Gateway providers (V8, optional)
# ---------------------------------------------------------------------------
$providersDelivered = $false
if ($GatewayDomain) {
    $gatewayBase = $GatewayDomain.TrimEnd("/")
    Write-Host ""
    Write-Host "Authenticating with AI Gateway Access..."
    Write-Host "  Gateway domain: $gatewayBase"
    $gwOutFile = Join-Path $profileDir "gw-login-out.txt"
    $gwErrFile = Join-Path $profileDir "gw-login-err.txt"
    $gwSpArgs = @{
        FilePath               = $CloudflaredPath
        ArgumentList           = @("access", "login", $gatewayBase)
        RedirectStandardOutput = $gwOutFile
        RedirectStandardError  = $gwErrFile
        Wait                   = $true
        PassThru               = $true
        NoNewWindow            = $true
    }
    $gwLogin = Start-Process @gwSpArgs
    $gwToken = (Get-Content $gwOutFile -Raw -ErrorAction SilentlyContinue).Trim()
    Remove-Item $gwOutFile, $gwErrFile -ErrorAction SilentlyContinue

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
        $putOutFile = Join-Path $profileDir "providers-out.txt"
        $putErrFile = Join-Path $profileDir "providers-err.txt"
        $putSpArgs = @{
            FilePath               = $CloudflaredPath
            ArgumentList           = @("access", "curl", "$WorkerUrl/api/admin/providers?userId=$userId", "-s", "-X", "PUT", "-H", "Content-Type: application/json", "-d", $providersJson)
            RedirectStandardOutput = $putOutFile
            RedirectStandardError  = $putErrFile
            Wait                   = $true
            PassThru               = $true
            NoNewWindow            = $true
        }
        $putProc = Start-Process @putSpArgs
        $putOut = (Get-Content $putOutFile -Raw -ErrorAction SilentlyContinue).Trim()
        Remove-Item $putOutFile, $putErrFile -ErrorAction SilentlyContinue
        if ($putProc.ExitCode -ne 0 -or -not $putOut) {
            Write-Warning "Failed to PUT providers (will retry next run): $putOut"
        } else {
            Write-Host "  Providers stored: $putOut"
            $safeToken = $gwToken.Replace('\', '\\').Replace('"', '\"')
            $jwtBody = '{"jwt":"' + $safeToken + '"}'
            $jwtOutFile = Join-Path $profileDir "jwt-out.txt"
            $jwtErrFile = Join-Path $profileDir "jwt-err.txt"
            $jwtSpArgs = @{
                FilePath               = $CloudflaredPath
                ArgumentList           = @("access", "curl", "$WorkerUrl/api/admin/gateway-jwt?userId=$userId", "-s", "-X", "POST", "-H", "Content-Type: application/json", "-d", $jwtBody)
                RedirectStandardOutput = $jwtOutFile
                RedirectStandardError  = $jwtErrFile
                Wait                   = $true
                PassThru               = $true
                NoNewWindow            = $true
            }
            $jwtProc = Start-Process @jwtSpArgs
            $jwtOut = (Get-Content $jwtOutFile -Raw -ErrorAction SilentlyContinue).Trim()
            Remove-Item $jwtOutFile, $jwtErrFile -ErrorAction SilentlyContinue
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
Write-Host ""
Write-Host "Waking sandbox container..."

$wakeOutFile = Join-Path $profileDir "wake-out.txt"
$wakeErrFile = Join-Path $profileDir "wake-err.txt"
$wakeSpArgs = @{
    FilePath               = $CloudflaredPath
    ArgumentList           = @("access", "curl", "$WorkerUrl/api/wake", "-s", "-X", "POST")
    RedirectStandardOutput = $wakeOutFile
    RedirectStandardError  = $wakeErrFile
    Wait                   = $true
    PassThru               = $true
    NoNewWindow            = $true
}
$proc2 = Start-Process @wakeSpArgs

$wakeJson = Get-Content $wakeOutFile -Raw -ErrorAction SilentlyContinue
$wakeErr  = Get-Content $wakeErrFile  -Raw -ErrorAction SilentlyContinue
Remove-Item $wakeOutFile, $wakeErrFile -ErrorAction SilentlyContinue

if ($proc2.ExitCode -ne 0 -or -not $wakeJson) {
    Write-Error "cloudflared access curl failed (exit code $($proc2.ExitCode)).STDERR:$wakeErr"
    exit 1
}

try {
    $wakeRes = $wakeJson | ConvertFrom-Json
} catch {
    Write-Error "Invalid JSON from Worker: $wakeJson"
    exit 1
}

# ---------------------------------------------------------------------------
# 5. Poll container platform status AND startup script progress
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host ("Sandbox status: {0}" -f $wakeRes.status)
Write-Host "Container is waking - this may take 2-5 minutes on first boot..."

$maxWaitSeconds      = 300
$pollIntervalSeconds = 2
$elapsed             = 0
$isReady             = $false
$startupComplete     = $false
$lastStartupStatus   = ""
$platformStatus      = "unknown"
$lastPlatformStatus  = ""

while ($elapsed -lt $maxWaitSeconds) {
    Start-Sleep -Seconds $pollIntervalSeconds
    $elapsed += $pollIntervalSeconds

    # A. Poll startup script status
    $catCmd = "cat%20/home/hermes/.hermes/.startup-status%202%3E%261%20%7C%7C%20echo%20NOT_STARTED"
    $startupUrl = "$WorkerUrl/api/debug/exec?userId=$userId&cmd=$catCmd"
    $startupOutFile = Join-Path $profileDir "startup-out.txt"
    $startupErrFile = Join-Path $profileDir "startup-err.txt"
    $startupSpArgs = @{
        FilePath               = $CloudflaredPath
        ArgumentList           = @("access", "curl", $startupUrl, "-s")
        RedirectStandardOutput = $startupOutFile
        RedirectStandardError  = $startupErrFile
        Wait                   = $true
        PassThru               = $true
        NoNewWindow            = $true
    }
    $statusProc = Start-Process @startupSpArgs

    $statusText = Get-Content $startupOutFile -Raw -ErrorAction SilentlyContinue
    Remove-Item $startupOutFile, $startupErrFile -ErrorAction SilentlyContinue

    $currentStartupStatus = ""
    if ($statusProc.ExitCode -eq 0 -and $statusText) {
        if ($statusText -match '"stdout"\s*:\s*"([^"]*)"') {
            $currentStartupStatus = $Matches[1] -replace '\\n', ''
        } else {
            $currentStartupStatus = $statusText.Trim()
        }
    }

    if ($currentStartupStatus -and $currentStartupStatus -ne $lastStartupStatus) {
        $lastStartupStatus = $currentStartupStatus
    }

    if ($currentStartupStatus -eq "Startup complete." -or $currentStartupStatus -eq "Starting hermes serve...") {
        $startupComplete = $true
    }

    # B. Poll platform status every ~10 seconds
    if (($elapsed % 10 -eq 0) -or (-not $lastPlatformStatus)) {
        $adminUrl = "$WorkerUrl/api/admin/status?userId=$userId"
        $pollOutFile = Join-Path $profileDir "status-out.txt"
        $pollErrFile = Join-Path $profileDir "status-err.txt"
        $statusSpArgs = @{
            FilePath               = $CloudflaredPath
            ArgumentList           = @("access", "curl", $adminUrl, "-s")
            RedirectStandardOutput = $pollOutFile
            RedirectStandardError  = $pollErrFile
            Wait                   = $true
            PassThru               = $true
            NoNewWindow            = $true
        }
        $pollProc = Start-Process @statusSpArgs

        $pollJson = Get-Content $pollOutFile -Raw -ErrorAction SilentlyContinue
        Remove-Item $pollOutFile, $pollErrFile -ErrorAction SilentlyContinue

        if ($pollProc.ExitCode -eq 0 -and $pollJson) {
            try {
                $pollRes = $pollJson | ConvertFrom-Json
                $state = $pollRes.state
                $platformStatus = if ($state.status) { $state.status } else { "unknown" }

                if ($platformStatus -eq "stopped_with_code") {
                    Write-Host ""
                    Write-Host ("Sandbox status: stopped_with_code (exit code {0}) - provisioning may have failed." -f $state.exitCode)
                    Write-Host "Response: $pollJson"
                    exit 1
                }

                $lastPlatformStatus = $platformStatus
            } catch {
                $lastPlatformStatus = "unknown"
            }
        }
    }

    # C. Single overwritten line
    $displayStatus = if ($lastStartupStatus) { $lastStartupStatus } else { "Container booting..." }
    Write-Host -NoNewline ("`r  [Startup] {0} (platform: {1}, {2}s)" -f $displayStatus, $lastPlatformStatus, $elapsed)

    if ($startupComplete -and ($lastPlatformStatus -eq "running" -or $lastPlatformStatus -eq "healthy")) {
        Write-Host ""
        $isReady = $true
        break
    }
}

if (-not $isReady) {
    Write-Error ("Timed out waiting for container after {0} seconds. Platform: {1} | Startup: {2}" -f $maxWaitSeconds, $lastPlatformStatus, $lastStartupStatus)
    exit 1
}

Write-Host "Container is ready!"

# ---------------------------------------------------------------------------
# 6. Save connection profile for daily use
# ---------------------------------------------------------------------------
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

Set-Content -Path $profilePath -Value $profile
Write-Host "Profile saved to: $profilePath"

# ---------------------------------------------------------------------------
# 7. Start supervised tunnel session
# ---------------------------------------------------------------------------
Start-HermesSession -Hostname $hostname -SessionToken $sessionToken
