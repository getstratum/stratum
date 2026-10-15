# Runs a Stratum gateway on this machine (Docker Desktop), synced with a
# control plane somewhere else. Builds the image from this repository.
#
#   deploy\hybrid\pc\run-gateway.ps1 -CpUrl https://1-2-3-4.sslip.io -InstanceId dp_... -SyncToken dp_sync_...
#   deploy\hybrid\pc\run-gateway.ps1 ... -WithValkey   # also a local Valkey (ADR-0008)
#
# The gateway listens on http://127.0.0.1:20128 (API) and :9090 (metrics),
# only on this machine. Its secrets live in %LOCALAPPDATA%\stratum-gateway.
param(
  [Parameter(Mandatory = $true)][string]$CpUrl,
  [Parameter(Mandatory = $true)][string]$InstanceId,
  [Parameter(Mandatory = $true)][string]$SyncToken,
  [switch]$WithValkey,
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
)
$ErrorActionPreference = 'Stop'

function Run([string]$what) {
  # Native commands do not throw on failure in Windows PowerShell.
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)" }
}

$state = Join-Path $env:LOCALAPPDATA 'stratum-gateway'
New-Item -ItemType Directory -Force -Path $state | Out-Null

# Snapshot encryption key: generated once and kept, so the gateway can read
# its own snapshot after a restart.
$keyFile = Join-Path $state 'snapshot.key'
if (-not (Test-Path $keyFile)) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  (($bytes | ForEach-Object { $_.ToString('x2') }) -join '') | Set-Content -NoNewline -Encoding ascii $keyFile
}
$snapshotKey = (Get-Content -Raw $keyFile).Trim()

$envLines = @(
  "STRATUM_CP_URL=$CpUrl",
  "STRATUM_INSTANCE_ID=$InstanceId",
  "STRATUM_SYNC_TOKEN=$SyncToken",
  "STRATUM_SNAPSHOT_KEY=$snapshotKey",
  "STRATUM_LOG_LEVEL=info"
)
if ($WithValkey) { $envLines += 'STRATUM_VALKEY_URL=redis://stratum-valkey:6379/0' }
$envFile = Join-Path $state 'gateway.env'
$envLines | Set-Content -Encoding ascii $envFile

Write-Host '==> Building the gateway image'
docker build -q -t stratum-gateway:local (Join-Path $RepoRoot 'gateway'); Run 'docker build'

docker network inspect stratum-local *> $null
if ($LASTEXITCODE -ne 0) { docker network create stratum-local | Out-Null; Run 'docker network create' }

if ($WithValkey) {
  Write-Host '==> Valkey (local, with persistence)'
  docker rm -f stratum-valkey *> $null
  docker run -d --name stratum-valkey --network stratum-local --restart unless-stopped `
    -v stratum-valkey-data:/data valkey/valkey:8.1-alpine valkey-server --appendonly yes | Out-Null
  Run 'docker run valkey'
}

Write-Host '==> Gateway'
docker rm -f stratum-gateway *> $null
docker run -d --name stratum-gateway --network stratum-local --restart unless-stopped `
  -p 127.0.0.1:20128:20128 -p 127.0.0.1:9090:9090 `
  -v stratum-gateway-data:/var/lib/stratum `
  --env-file $envFile stratum-gateway:local | Out-Null
Run 'docker run gateway'

Write-Host '==> Waiting until it has a configuration'
for ($i = 0; $i -lt 30; $i++) {
  try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:20128/readyz' -TimeoutSec 3
    Write-Host ("  ready: snapshot version {0}, {1} active keys" -f $r.snapshot_version, $r.active_keys)
    Write-Host ''
    Write-Host 'Logs:     docker logs -f stratum-gateway'
    Write-Host 'Metrics:  http://127.0.0.1:9090/metrics'
    exit 0
  } catch { Start-Sleep -Seconds 2 }
}
Write-Host '  not ready after 60 s. Last log lines:'
docker logs --tail 20 stratum-gateway
exit 1
