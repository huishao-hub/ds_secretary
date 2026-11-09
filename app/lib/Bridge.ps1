# AI-Secretary · 本地服务桥（异步，绝不阻塞 UI 线程）
# 服务由 DSH 插件拉起并写 data\bridge.json；桌宠只读该文件里的 port + token。
Set-StrictMode -Version 2.0

$script:Bridge = @{ Base = $null; Token = $null; Http = $null; Pending = @(); Seq = 0 }

function Get-BridgeFile([string]$DataDir) { Join-Path $DataDir 'bridge.json' }

function Read-BridgeInfo([string]$DataDir) {
    $path = Get-BridgeFile $DataDir
    if (-not (Test-Path $path)) { return $null }
    try {
        $b = Get-Content $path -Raw -Encoding utf8 | ConvertFrom-Json
        if ($b.port -and $b.token) { return $b }
    } catch { }
    return $null
}

function Initialize-Bridge([string]$DataDir) {
    $info = Read-BridgeInfo $DataDir
    if (-not $info) { return $false }
    try {
        # PowerShell 5.1 默认不加载 System.Net.Http
        try { Add-Type -AssemblyName System.Net.Http -ErrorAction Stop } catch { }
        $http = New-Object System.Net.Http.HttpClient
        $http.Timeout = [TimeSpan]::FromSeconds(20)
        [void]$http.DefaultRequestHeaders.TryAddWithoutValidation('Authorization', "Bearer $($info.token)")
        $script:Bridge.Http = $http
        $script:Bridge.Base = "http://127.0.0.1:$($info.port)"
        $script:Bridge.Token = [string]$info.token
        return $true
    } catch {
        $script:BridgeError = $_.Exception.Message
        return $false
    }
}

function Get-BridgeBase { return $script:Bridge.Base }

# 异步发起一个请求；$OnDone 形如 { param($json, $error) }
function Invoke-BridgeAsync {
    param(
        [string]$Path,
        [string]$Method = 'GET',
        $Body = $null,
        [scriptblock]$OnDone = $null,
        [int]$TimeoutSec = 20
    )
    if (-not $script:Bridge.Http) {
        if (-not (Initialize-Bridge $script:DataDir)) {
            if ($OnDone) { & $OnDone $null '本地规划服务未运行（或刚重启过），请重新启动桌宠' }
            return
        }
    }
    $script:Bridge.Seq = [int]$script:Bridge.Seq + 1
    $id = $script:Bridge.Seq
    try {
        $uri = "$($script:Bridge.Base)$Path"
        $method = ([string]$Method).ToUpperInvariant()
        $task = $null
        if ($method -eq 'GET') {
            $task = $script:Bridge.Http.GetAsync($uri)
        } else {
            # 任意方法（POST / PATCH / DELETE / PUT）统一走 HttpRequestMessage，
            # 否则 DELETE 会被当成 POST 发出去，服务端返回 405 method not allowed
            $req = New-Object System.Net.Http.HttpRequestMessage -ArgumentList ([System.Net.Http.HttpMethod]::new($method)), $uri
            if ($null -ne $Body) {
                $json = if ($Body -is [string]) { $Body } else { ($Body | ConvertTo-Json -Depth 12 -Compress) }
                $content = New-Object System.Net.Http.StringContent($json, [System.Text.Encoding]::UTF8, 'application/json')
                $req.Content = $content
            }
            $task = $script:Bridge.Http.SendAsync($req)
        }
        $script:Bridge.Pending += [pscustomobject]@{
            Id = $id; Task = $task; OnDone = $OnDone; Path = $Path
            Started = [Environment]::TickCount
        }
    } catch {
        if ($OnDone) { & $OnDone $null $_.Exception.Message }
    }
}

# 由 UI 定时器调用：收割已完成的任务
function Update-Bridge {
    if ($script:Bridge.Pending.Count -eq 0) { return }
    # 先拍快照再处理：回调里可能又发起新请求（比如"解析完再去对话"），
    # 处理完必须把新加入的保留下来，不能整体覆盖掉。
    $snapshot = @($script:Bridge.Pending)
    $finished = New-Object System.Collections.ArrayList
    foreach ($p in $snapshot) {
        try {
            if (-not $p.Task.IsCompleted) {
                if (([Environment]::TickCount - $p.Started) -gt 20000) {
                    [void]$finished.Add($p.Id)
                    if ($p.OnDone) { & $p.OnDone $null 'timeout' }
                }
                continue
            }
            [void]$finished.Add($p.Id)
            $resp = $p.Task.Result
            $raw = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            if (-not $resp.IsSuccessStatusCode) {
                $msg = "http $([int]$resp.StatusCode)"
                try { $msg = ($raw | ConvertFrom-Json).error } catch { }
                if ($p.OnDone) { & $p.OnDone $null $msg }
                continue
            }
            $obj = $null
            if ($raw -and $raw.Trim()) {
                try { $obj = $raw | ConvertFrom-Json } catch { $obj = $raw }
            }
            if ($p.OnDone) { & $p.OnDone $obj $null }
        } catch {
            [void]$finished.Add($p.Id)
            # 连接失败常见于"服务重启换了端口"：清掉缓存，下一次调用会重新读 bridge.json
            $script:Bridge.Http = $null
            $script:Bridge.Base = $null
            if ($p.OnDone) { & $p.OnDone $null $_.Exception.Message }
        }
    }
    if ($finished.Count -gt 0) {
        $script:Bridge.Pending = @($script:Bridge.Pending | Where-Object { -not ($finished -contains $_.Id) })
    }
}

# 定时对账：服务重启会换 port/token，这里发现不一致就把连接重建
function Sync-Bridge {
    param([string]$DataDir)
    if (-not $DataDir) { $DataDir = $script:DataDir }
    if (-not $DataDir) { return $false }
    try {
        $info = Read-BridgeInfo $DataDir
        if (-not $info) { return $false }
        $base = "http://127.0.0.1:$($info.port)"
        if ($script:Bridge.Base -eq $base -and $script:Bridge.Http) { return $false }
        try { if ($script:Bridge.Http) { $script:Bridge.Http.Dispose() } } catch { }
        $script:Bridge.Http = $null
        $script:Bridge.Base = $null
        $ok = Initialize-Bridge $DataDir
        return $ok
    } catch { return $false }
}

function Close-Bridge {
    try { if ($script:Bridge.Http) { $script:Bridge.Http.Dispose() } } catch { }
    $script:Bridge.Http = $null
    $script:Bridge.Pending = @()
}

# 同步取本地缓存（服务不可用时兜底显示），由调用方保证离线可用
function Read-CacheJson([string]$Path, $Fallback) {
    try {
        if (Test-Path $Path) { return (Get-Content $Path -Raw -Encoding utf8 | ConvertFrom-Json) }
    } catch { }
    return $Fallback
}

function Write-CacheJson([string]$Path, $Value) {
    try {
        $dir = Split-Path -Parent $Path
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        ($Value | ConvertTo-Json -Depth 12) | Out-File -FilePath $Path -Encoding utf8
    } catch { }
}
