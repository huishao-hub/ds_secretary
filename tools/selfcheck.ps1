#requires -Version 5.1
<#
  AI 秘书 · 一键自检
  用途：DSH 升级后 / 觉得"不对劲"时先跑这一条，检查引擎、桌宠、插件、数据和配置。
  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File D:\AI-Secretary\tools\selfcheck.ps1
  退出码：0 = 全部通过（可能有 WARN）；1 = 有 FAIL。
#>
param(
    [string]$Root = 'D:\AI-Secretary',
    [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
$script:results = @()
function Add-Result([string]$level, [string]$name, [string]$detail) {
    $script:results += [pscustomobject]@{ Level = $level; Name = $name; Detail = $detail }
    if (-not $Quiet) {
        $color = switch ($level) { 'OK' { 'Green' } 'WARN' { 'Yellow' } 'FAIL' { 'Red' } default { 'Gray' } }
        $mark = switch ($level) { 'OK' { '✓' } 'WARN' { '!' } 'FAIL' { '✗' } default { '-' } }
        Write-Host ("  [{0}] {1,-28} {2}" -f $mark, $name, $detail) -ForegroundColor $color
    }
}
function Section([string]$title) { if (-not $Quiet) { Write-Host "`n$title" -ForegroundColor Cyan } }

$dataDir = Join-Path $Root 'data'
$logDir = Join-Path $Root 'logs'
$bridgeFile = Join-Path $dataDir 'bridge.json'
$petPidFile = Join-Path $dataDir 'pet.pid'
$plannerPidFile = Join-Path $dataDir 'planner.pid'
$keyFile = Join-Path $Root 'service\config.local.json'
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'

if (-not $Quiet) {
    Write-Host "AI 秘书自检  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor White
    Write-Host "根目录: $Root"
}

# ---------------------------------------------------------------- 1. 环境
Section '【环境】'
try {
    $nodeV = (& node -v 2>$null)
    if ($nodeV -match 'v(\d+)\.') {
        $major = [int]$Matches[1]
        if ($major -ge 22) { Add-Result 'OK' 'Node' "$nodeV（内置 node:sqlite 可用）" }
        else { Add-Result 'FAIL' 'Node' "$nodeV 太旧，规划引擎需要 >= 22" }
    } else { Add-Result 'FAIL' 'Node' '未找到 node 命令' }
} catch { Add-Result 'FAIL' 'Node' "无法执行 node：$($_.Exception.Message)" }

Add-Result 'OK' 'PowerShell' "$($PSVersionTable.PSVersion)"

# ---------------------------------------------------------------- 2. 规划引擎
Section '【规划引擎】'
$bridge = $null
if (Test-Path $bridgeFile) {
    try { $bridge = Get-Content $bridgeFile -Raw -Encoding utf8 | ConvertFrom-Json } catch { }
}
if (-not $bridge) {
    Add-Result 'FAIL' 'bridge.json' '不存在 —— 引擎没启动，跑 app\launch.ps1'
} else {
    $alive = $false
    try { $null = Get-Process -Id ([int]$bridge.pid) -ErrorAction Stop; $alive = $true } catch { }
    if ($alive) { Add-Result 'OK' '引擎进程' "pid=$($bridge.pid)" }
    else { Add-Result 'FAIL' '引擎进程' "pid=$($bridge.pid) 已退出（bridge.json 是旧的）" }

    if ($alive) {
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:$($bridge.port)/health" -TimeoutSec 5
            $aiMode = if ($h.ai -eq 'api') { '已接大模型' } else { '未配 Key，走本地规则' }
            Add-Result 'OK' '健康检查' "port=$($bridge.port) ai=$($h.ai)（$aiMode）"
        } catch { Add-Result 'FAIL' '健康检查' "127.0.0.1:$($bridge.port) 连不上：$($_.Exception.Message)" }

        try {
            $hdr = @{ Authorization = "Bearer $($bridge.token)" }
            $items = Invoke-RestMethod -Uri "http://127.0.0.1:$($bridge.port)/items?limit=1" -Headers $hdr -TimeoutSec 5
            Add-Result 'OK' '数据库' "可读，计划共 $($items.total) 项"
        } catch { Add-Result 'FAIL' '数据库' "读不到计划：$($_.Exception.Message)" }
    }
}

# ---------------------------------------------------------------- 3. AI Key
Section '【AI 配置】'
if (Test-Path $keyFile) {
    try {
        $k = Get-Content $keyFile -Raw -Encoding utf8 | ConvertFrom-Json
        if ($k.apiKey -and $k.apiKey -match '^sk-\w{10,}') { Add-Result 'OK' 'API Key' '已配置（文件权限应为仅本人可读）' }
        else { Add-Result 'WARN' 'API Key' '文件在但 key 看起来无效' }
    } catch { Add-Result 'WARN' 'API Key' "解析失败：$($_.Exception.Message)" }
} else {
    Add-Result 'WARN' 'API Key' '未配置 service\config.local.json，聊天走本地规则'
}

# ---------------------------------------------------------------- 4. 桌宠 / 规划中心
Section '【桌面程序】'
function Test-PidFile([string]$file, [string]$label) {
    if (-not (Test-Path $file)) { Add-Result 'WARN' $label '未运行'; return }
    $procId = 0
    try { $procId = [int](Get-Content $file -Raw).Trim() } catch { }
    if (-not $procId) { Add-Result 'WARN' $label 'pid 文件损坏'; return }
    try {
        $p = Get-Process -Id $procId -ErrorAction Stop
        Add-Result 'OK' $label "pid=$procId 启动于 $($p.StartTime.ToString('MM-dd HH:mm'))"
    } catch { Add-Result 'WARN' $label "pid=$procId 已退出（重新打开即可）" }
}
Test-PidFile $petPidFile '桌宠'
Test-PidFile $plannerPidFile '规划中心'

# 桌宠日志最近的错误
$petLog = Join-Path $logDir 'pet.log'
if (Test-Path $petLog) {
    $bad = @(Get-Content $petLog -Tail 120 -ErrorAction SilentlyContinue | Select-String -Pattern 'FATAL|UNHANDLED' -SimpleMatch)
    if ($bad.Count -gt 0) { Add-Result 'WARN' '桌宠日志' "最近有 $($bad.Count) 条错误：$($bad[-1].Line.Substring(0, [Math]::Min(60, $bad[-1].Line.Length)))" }
    else { Add-Result 'OK' '桌宠日志' '最近无 FATAL/UNHANDLED' }
}

# ---------------------------------------------------------------- 5. DSH 插件
Section '【DSH 插件】'
$pluginPkg = Join-Path $Root 'plugin\index.js'
if (Test-Path $pluginPkg) { Add-Result 'OK' '插件代码' $pluginPkg } else { Add-Result 'FAIL' '插件代码' 'plugin\index.js 不见了' }

$profilePkg = Join-Path $profileDir 'package.json'
if (Test-Path $profilePkg) {
    try {
        $pj = Get-Content $profilePkg -Raw -Encoding utf8 | ConvertFrom-Json
        $bundles = @($pj.dsh.profile.bundles)
        if ($bundles -contains '@local/dsh-ai-secretary') { Add-Result 'OK' '已装入 profile' '@local/dsh-ai-secretary 在 bundle 列表里' }
        else { Add-Result 'FAIL' '已装入 profile' 'bundle 列表里没有它，需要重新 install_bundle' }

        $oldRefs = @($bundles | Where-Object { $_ -like '*kaguya*' })
        $depNames = @($pj.dependencies.PSObject.Properties.Name | Where-Object { $_ -like '*kaguya*' })
        if ($oldRefs.Count -eq 0 -and $depNames.Count -eq 0) { Add-Result 'OK' '旧桌宠' '海绵宝宝已彻底移除' }
        else { Add-Result 'WARN' '旧桌宠' "profile 里还残留：$(($oldRefs + $depNames) -join ', ')" }
    } catch { Add-Result 'WARN' '已装入 profile' "读不了 profile package.json：$($_.Exception.Message)" }
} else {
    Add-Result 'WARN' '已装入 profile' "找不到 $profilePkg"
}

$pluginLog = Join-Path $logDir 'plugin.log'
if (Test-Path $pluginLog) {
    $tail = Get-Content $pluginLog -Tail 200 -ErrorAction SilentlyContinue
    $lastApplied = @($tail | Select-String -Pattern 'plugin applied' -SimpleMatch)
    $lastUnavailable = @($tail | Select-String -Pattern 'tools service unavailable' -SimpleMatch)
    $lastRegistered = @($tail | Select-String -Pattern 'tools ready' -SimpleMatch)
    if ($lastRegistered.Count -gt 0) { Add-Result 'OK' '工具注册' 'secretary_* 工具已注册（日志有 tools ready）' }
    elseif ($lastUnavailable.Count -gt 0) { Add-Result 'WARN' '工具注册' '日志显示 tools 服务拿不到 —— 打开插件管理器开关一次即可重载' }
    else { Add-Result 'WARN' '工具注册' '日志里没有注册记录（DSH 可能还没启动过插件）' }

    if ($lastApplied.Count -gt 0) { Add-Result 'OK' '插件加载' $lastApplied[-1].Line.Trim() }
}

# ---------------------------------------------------------------- 6. 备份
Section '【数据与备份】'
$db = Join-Path $dataDir 'secretary.db'
if (Test-Path $db) { Add-Result 'OK' '数据库文件' "$([math]::Round((Get-Item $db).Length/1MB,2)) MB" }
else { Add-Result 'WARN' '数据库文件' '还没建库（第一次运行会创建）' }

$bakDir = Join-Path $Root 'backup'
if (Test-Path $bakDir) {
    $zips = @(Get-ChildItem $bakDir -Filter '*.zip' -ErrorAction SilentlyContinue)
    Add-Result 'OK' '备份目录' "$($zips.Count) 个压缩包"
}

# ---------------------------------------------------------------- 汇总
$fail = @($script:results | Where-Object { $_.Level -eq 'FAIL' })
$warn = @($script:results | Where-Object { $_.Level -eq 'WARN' })
if (-not $Quiet) {
    Write-Host ""
    Write-Host ("汇总：OK {0} / WARN {1} / FAIL {2}" -f `
        @($script:results | Where-Object { $_.Level -eq 'OK' }).Count, $warn.Count, $fail.Count) `
        -ForegroundColor $(if ($fail.Count -gt 0) { 'Red' } elseif ($warn.Count -gt 0) { 'Yellow' } else { 'Green' })
    if ($fail.Count -gt 0) {
        Write-Host "需要处理：" -ForegroundColor Red
        $fail | ForEach-Object { Write-Host "  - $($_.Name)：$($_.Detail)" -ForegroundColor Red }
    }
    if ($warn.Count -gt 0) {
        Write-Host "可以留意：" -ForegroundColor Yellow
        $warn | ForEach-Object { Write-Host "  - $($_.Name)：$($_.Detail)" -ForegroundColor Yellow }
    }
    if ($fail.Count -eq 0 -and $warn.Count -eq 0) { Write-Host "一切正常。" -ForegroundColor Green }
}
exit $(if ($fail.Count -gt 0) { 1 } else { 0 })
