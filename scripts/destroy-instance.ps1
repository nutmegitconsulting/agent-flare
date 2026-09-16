# Hermes V6 Admin: Destroy Sandbox Instance by userId
# Requires: cloudflared CLI (authenticated)
# Usage: .\scripts\destroy-instance.ps1 -userId "<your-user-id>"
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

Write-Host "Authenticating with Cloudflare Access..."
& $CloudflaredPath access login $WorkerUrl 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "cloudflared access login failed (exit code $LASTEXITCODE)."
    exit 1
}
Write-Host "Access authentication successful."

Write-Host "Sending destroy command for user: $userId ..."

$proc = Start-Process -FilePath $CloudflaredPath `
    -ArgumentList @("access", "curl", "$WorkerUrl/api/admin/destroy?userId=$userId", "-s", "-X", "POST") `
    -RedirectStandardOutput "destroy-out.txt" `
    -RedirectStandardError  "destroy-err.txt" `
    -Wait -PassThru -NoNewWindow

$out = Get-Content "destroy-out.txt" -Raw -ErrorAction SilentlyContinue
$err = Get-Content "destroy-err.txt"  -Raw -ErrorAction SilentlyContinue
Remove-Item "destroy-out.txt", "destroy-err.txt" -ErrorAction SilentlyContinue

if ($proc.ExitCode -ne 0) {
    Write-Error "Destroy call failed (exit code $($proc.ExitCode)).`nSTDERR:`n$err"
    exit 1
}

try {
    $res = $out | ConvertFrom-Json
    if ($res.error) {
        Write-Error "Worker returned error: $($res.error)"
        exit 1
    }
    Write-Host "Instance destroyed successfully:"
    Write-Host "  userId: $($res.userId)"
    Write-Host "  status: $($res.status)"
} catch {
    Write-Host "Response: $out"
}
