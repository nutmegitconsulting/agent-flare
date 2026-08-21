# Hermes V6: Graceful stop sandbox by userId (SIGTERM → triggers onStop + squashfs backup)
# Usage: .\stop-instance.ps1 -userId "user"
param(
    [Parameter(Mandatory = $true)]
    [string]$userId,

    [string]$WorkerUrl = "https://hermes-agent.hermes-test.app",
    [string]$CloudflaredPath = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
)

if (-not $CloudflaredPath) {
    Write-Error "cloudflared not found. Install: winget install --id Cloudflare.cloudflared"
    exit 1
}

Write-Host "Sending SIGTERM to sandbox for user: $userId ..."

$proc = Start-Process -FilePath $CloudflaredPath `
    -ArgumentList @("access", "curl", "$WorkerUrl/api/admin/stop?userId=$userId", "-s", "-X", "POST") `
    -RedirectStandardOutput "stop-out.txt" `
    -RedirectStandardError  "stop-err.txt" `
    -Wait -PassThru -NoNewWindow

$out = Get-Content "stop-out.txt" -Raw -ErrorAction SilentlyContinue
$err = Get-Content "stop-err.txt"  -Raw -ErrorAction SilentlyContinue
Remove-Item "stop-out.txt", "stop-err.txt" -ErrorAction SilentlyContinue

if ($proc.ExitCode -ne 0) {
    Write-Error "cloudflared access curl failed (exit code $($proc.ExitCode)).`nSTDERR:`n$err"
    exit 1
}

Write-Host "Response: $out"
