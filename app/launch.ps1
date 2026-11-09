# AI-Secretary 启动器：确保本地规划服务在跑，然后拉起桌宠
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File app\launch.ps1 [-NoPet] [-PetOnly]
param(
    [switch]$NoPet,
    [switch]$PetOnly,
    [string]$Root = 'D:\AI-Secretary'
)

$ErrorActionPreference = 'Continue'
$dataDir = Join-Path $Root 'data'
$logDir = Join-Path $Root 'logs'
foreach ($d in @($dataDir, $logDir)) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null } }
$log = Join-Path $logDir 'launcher.log'
function Log([string]$m) { try { "$([DateTime]::Now.ToString('MM-dd HH:mm:ss'))  $m" | Out-File -FilePath $log -Append -Encoding utf8 } catch { } }

Log "--- launch (NoPet=$NoPet PetOnly=$PetOnly) ---"

function Test-ServiceAlive {
    $bf = Join-Path $dataDir 'bridge.json'
    if (-not (Test-Path $bf)) { return $false }
    try {
        $b = Get-Content $bf -Raw -Encoding utf8 | ConvertFrom-Json
        if (-not $b.port) { return $false }
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$($b.port)/health" -TimeoutSec 3 -UseBasicParsing
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Start-ServiceProcess {
    $entry = Join-Path $Root 'service\index.mjs'
    if (-not (Test-Path $entry)) { Log "service missing: $entry"; return $false }
    $out = Join-Path $logDir 'service.out.log'
    $err = Join-Path $logDir 'service.err.log'
    $node = (Get-Command node -ErrorAction SilentlyContinue)
    if (-not $node) { Log 'node not found in PATH'; return $false }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $node.Source
    $psi.Arguments = "`"$entry`" --data-dir `"$dataDir`""
    $psi.WorkingDirectory = $Root
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    # 异步把输出写日志，避免管道阻塞
    $p.add_OutputDataReceived({ param($s, $e) if ($e.Data) { "$([DateTime]::Now.ToString('HH:mm:ss')) $($e.Data)" | Out-File -FilePath $out -Append -Encoding utf8 } })
    $p.add_ErrorDataReceived({ param($s, $e) if ($e.Data) { "$([DateTime]::Now.ToString('HH:mm:ss')) $($e.Data)" | Out-File -FilePath $err -Append -Encoding utf8 } })
    $p.BeginOutputReadLine()
    $p.BeginErrorReadLine()
    Log "service started pid $($p.Id)"
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 250
        if (Test-ServiceAlive) { Log 'service healthy'; return $true }
        if ($p.HasExited) { Log "service exited early code=$($p.ExitCode)"; return $false }
    }
    Log 'service did not become healthy in 10s'
    return (Test-ServiceAlive)
}

if (-not $PetOnly) {
    if (Test-ServiceAlive) { Log 'service already alive' }
    else { [void](Start-ServiceProcess) }
}

if (-not $NoPet) {
    $pidFile = Join-Path $dataDir 'pet.pid'
    $alivePid = 0
    if (Test-Path $pidFile) {
        try { $alivePid = [int](Get-Content $pidFile -Raw).Trim() } catch { $alivePid = 0 }
    }
    $alive = $false
    if ($alivePid -gt 0) {
        try { $null = Get-Process -Id $alivePid -ErrorAction Stop; $alive = $true } catch { $alive = $false }
    }
    if ($alive) {
        Log "pet already running pid $alivePid"
    } else {
        $pet = Join-Path $Root 'app\Pet.ps1'
        Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $pet, '-Root', $Root) -WindowStyle Hidden
        Log 'pet started'
    }
}
Log '--- launch done ---'
