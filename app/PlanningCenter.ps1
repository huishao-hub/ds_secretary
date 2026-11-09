﻿﻿﻿#requires -Version 5.1
<#
  AI Personal Secretary · 时间规划中心
  三栏：左（长期目标 / 待安排池 / 搜索） 中（多尺度时间轴 + 甘特） 右（AI 对话 / 建议 / 冲突）
  全部数据来自本地规划服务；服务不可用时只读缓存并明确提示。
#>
param(
    [string]$Root = 'D:\AI-Secretary'
)

$ErrorActionPreference = 'Stop'
$appDir = Join-Path $Root 'app'
$dataDir = Join-Path $Root 'data'
$logDir = Join-Path $Root 'logs'
foreach ($d in @($dataDir, $logDir)) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null } }
$logFile = Join-Path $logDir 'planner.log'
function Log([string]$m) { try { "$([DateTime]::Now.ToString('HH:mm:ss'))  $m" | Out-File -FilePath $logFile -Append -Encoding utf8 } catch { } }

$COL = @{
    Bg = '#12161F'; Panel = '#191F2C'; Panel2 = '#1F2736'; Edge = '#2C364B'
    Text = '#E6ECF7'; Sub = '#93A2BB'; Accent = '#6FA8FF'; AccentDim = '#2B4670'
    Ok = '#5FD08A'; Warn = '#FFC46B'; Bad = '#FF7A85'; Milestone = '#C08BFF'
    Grid = '#232C3D'; GridStrong = '#31405A'
}
$PRIO_COLORS = @{ 0 = '#5C6B85'; 1 = '#4E86C9'; 2 = '#6FA8FF'; 3 = '#FFB84D'; 4 = '#FF7A85' }

function Brush([string]$hex) { return [System.Windows.Media.BrushConverter]::new().ConvertFromString($hex) }

try {
    Log '=== planner start ==='


    # 找窗口用的 Win32（PowerShell 宿主进程的 MainWindowHandle 常常是 0，
    # 必须按进程 id 枚举顶层窗口，否则"已运行"时用户面前什么都不会出现）
    try {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class WinEnum {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    public static IntPtr FindVisible(uint target) {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (pid == target && IsWindowVisible(h) && GetWindowTextLength(h) > 0) { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
"@ -ErrorAction SilentlyContinue
    } catch { }

    # 单实例：已经有一个在跑时，先把它叫到前面来（用户点开必须看到东西）；
    # 叫不出来（窗口不可见/被全屏挡住/无法前置）就把它结束掉，自己接管。
    $script:ownPidFile = Join-Path $dataDir 'planner.pid'
    if (Test-Path $script:ownPidFile) {
        $otherPid = 0
        try { $otherPid = [int](Get-Content $script:ownPidFile -Raw).Trim() } catch { }
        if ($otherPid -gt 0 -and $otherPid -ne $PID -and (Get-Process -Id $otherPid -ErrorAction SilentlyContinue)) {
            $focused = $false
            try {
                if ('WinEnum' -as [type]) {
                    $hwnd = [WinEnum]::FindVisible([uint32]$otherPid)
                    if ($hwnd -ne [IntPtr]::Zero) {
                        [void][WinEnum]::ShowWindow($hwnd, 9)      # SW_RESTORE
                        $focused = [WinEnum]::SetForegroundWindow($hwnd)
                        Log "已有窗口 pid $otherPid，尝试前置 focused=$focused"
                    } else {
                        Log "已有进程 pid $otherPid 但没有可见窗口"
                    }
                }
            } catch { Log "前置失败：$($_.Exception.Message)" }
            if ($focused) { return }
            Log "接管：结束旧实例 pid $otherPid"
            try { Stop-Process -Id $otherPid -Force -ErrorAction Stop } catch { }
            Start-Sleep -Milliseconds 600
        }
    }
    try { "$PID" | Out-File -FilePath $script:ownPidFile -Encoding ascii -NoNewline } catch { }
    Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms, System.Drawing
    . (Join-Path $appDir 'lib\Bridge.ps1')
    Set-StrictMode -Off
    $script:DataDir = $dataDir
    $script:Root = $Root

    $script:bridgeOk = Initialize-Bridge $dataDir
    if (-not $script:bridgeOk) { Log 'bridge not available (read-only mode)' }

    $script:items = @()
    $script:conflicts = @()
    $script:proposals = @()
    $script:selectedId = $null
    $script:mode = 'month'
    $script:viewStart = (Get-Date).Date
    $script:viewDays = 31
    $script:chatBusy = $false
    $script:itemsSig = $null
    $script:itemsRendered = $false
    $script:notice = ''
    $script:noticeUntil = 0
    $script:chatSeq = 0
    $script:chatText = ''
    $script:accOps = @()
    $script:accSummary = ''
    $script:accPid = ''

    # ---------------- 数据访问 ----------------
    function Get-Field($o, [string]$n, $d = $null) {
        if ($null -eq $o) { return $d }
        $p = $o.PSObject.Properties[$n]
        if ($null -eq $p -or $null -eq $p.Value) { return $d }
        return $p.Value
    }
    function AsArray($o = $null, [string]$prop = '') {
        if ($null -eq $o) { return @() }
        $v = if ($prop) { Get-Field $o $prop @() } else { $o }
        if ($null -eq $v) { return @() }
        return @($v)
    }

    $script:cacheItems = Join-Path $dataDir 'cache-items.json'
    $script:cacheWindow = Join-Path $dataDir 'cache-window.json'

    function Refresh-Items {
        Invoke-BridgeAsync -Path '/items?limit=800' -OnDone {
            param($json, $err)
            if ($err) { $script:offline = $true; return }
            $script:offline = $false
            $next = @(AsArray $json 'items')
            $sig = (($next | ForEach-Object { "$(Get-Field $_ 'id' '')@$(Get-Field $_ 'updatedAt' '')" }) -join '|')
            if ($sig -eq $script:itemsSig -and $script:itemsRendered) { return }
            if ($script:noticeUntil -gt [Environment]::TickCount) { $script:statusText.Text = $script:notice; $script:statusText.Foreground = Brush $COL.Warn }
            $script:itemsSig = $sig
            $script:items = $next
            $script:itemsRendered = $true
            Write-CacheJson $script:cacheItems @{ items = $script:items }
            Rebuild-LeftPanel
            Render-Timeline
            Log "sync: items=$($script:items.Count)"
        }
    }

    function Refresh-Analysis {
        Invoke-BridgeAsync -Path '/conflicts' -OnDone {
            param($json, $err)
            $script:conflicts = if ($err) { @() } else { @(AsArray $json 'conflicts') }
            Render-Conflicts
        }
        Invoke-BridgeAsync -Path '/proposals?status=draft' -OnDone {
            param($json, $err)
            $script:proposals = if ($err) { @() } else { @(AsArray $json 'proposals') }
            if ($script:proposals.Count -eq 0 -and $json -is [array]) { $script:proposals = @($json) }
            Render-Proposals
        }
    }

    function Refresh-All {
        Invoke-BridgeAsync -Path '/items?limit=800' -OnDone {
            param($json, $err)
            if ($err) { $script:offline = $true; Load-FromCache; return }
            $script:offline = $false
            $next = @(AsArray $json 'items')
            $sig = (($next | ForEach-Object { "$(Get-Field $_ 'id' '')@$(Get-Field $_ 'updatedAt' '')" }) -join '|')
            if ($sig -eq $script:itemsSig -and $script:itemsRendered) {
                $script:statusText.Text = '已同步'
                $script:statusText.Foreground = Brush $COL.Sub
                return
            }
            $script:itemsSig = $sig
            $script:items = $next
            $script:itemsRendered = $true
            Log "refresh: items=$($script:items.Count)"
            Write-CacheJson $script:cacheItems @{ items = $script:items }
            Rebuild-LeftPanel
            Render-Timeline
        }
        Invoke-BridgeAsync -Path '/conflicts' -OnDone {
            param($json, $err)
            $script:conflicts = if ($err) { @() } else { @(AsArray $json 'conflicts') }
            Render-Conflicts
        }
        Invoke-BridgeAsync -Path '/proposals?status=draft' -OnDone {
            param($json, $err)
            $script:proposals = if ($err) { @() } else { @(AsArray $json 'proposals') }
            if ($script:proposals.Count -eq 0 -and $json -is [array]) { $script:proposals = @($json) }
            Render-Proposals
        }
    }

    function Load-FromCache {
        $c = Read-CacheJson $script:cacheItems $null
        if ($c) { $script:items = @(AsArray $c 'items') }
        Rebuild-LeftPanel
        Render-Timeline
        $script:statusText.Text = '服务未连接：当前为本地缓存只读视图'
        $script:statusText.Foreground = Brush $COL.Warn
    }

    function Save-Item($id, $patch, [scriptblock]$after = $null) {
        Invoke-BridgeAsync -Path "/items/$id" -Method 'PATCH' -Body $patch -OnDone {
            param($json, $err)
            if ($err) { $script:statusText.Text = "保存失败：$err"; $script:statusText.Foreground = Brush $COL.Bad; return }
            $script:statusText.Text = '已保存'; $script:statusText.Foreground = Brush $COL.Ok
            if ($after) { & $after }
            Refresh-All
        }
    }

    # ---------------- 窗口 ----------------
    $xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="AI 秘书 · 时间规划中心" Width="1360" Height="860" MinWidth="1020" MinHeight="640"
        WindowStartupLocation="CenterScreen" Background="#12161F"
        FontFamily="Microsoft YaHei UI" FontSize="12">
  <Window.Resources>
    <Style x:Key="TBtn" TargetType="Button">
      <Setter Property="Background" Value="#1F2736"/><Setter Property="Foreground" Value="#E6ECF7"/>
      <Setter Property="BorderThickness" Value="0"/><Setter Property="Padding" Value="12,6"/>
      <Setter Property="Margin" Value="3"/><Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value><ControlTemplate TargetType="Button">
          <Border x:Name="bd" Background="{TemplateBinding Background}" CornerRadius="8" Padding="{TemplateBinding Padding}">
            <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
          </Border>
          <ControlTemplate.Triggers>
            <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="bd" Property="Background" Value="#2A3550"/></Trigger>
            <Trigger Property="IsPressed" Value="True"><Setter TargetName="bd" Property="Opacity" Value="0.7"/></Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate></Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="TBtnAccent" TargetType="Button" BasedOn="{StaticResource TBtn}">
      <Setter Property="Background" Value="#2F5FA8"/>
    </Style>
    <Style TargetType="TextBox">
      <Setter Property="Background" Value="#151B27"/><Setter Property="Foreground" Value="#E6ECF7"/>
      <Setter Property="BorderBrush" Value="#2C364B"/><Setter Property="BorderThickness" Value="1"/>
      <Setter Property="Padding" Value="6,4"/><Setter Property="CaretBrush" Value="#E6ECF7"/>
    </Style>
    <Style TargetType="ListBox">
      <Setter Property="Background" Value="Transparent"/><Setter Property="BorderThickness" Value="0"/>
      <Setter Property="Foreground" Value="#E6ECF7"/>
    </Style>
    <Style TargetType="TreeView">
      <Setter Property="Background" Value="Transparent"/><Setter Property="BorderThickness" Value="0"/>
      <Setter Property="Foreground" Value="#E6ECF7"/>
    </Style>
    <Style TargetType="ComboBox">
      <Setter Property="Background" Value="#1F2736"/><Setter Property="Foreground" Value="#E6ECF7"/>
      <Setter Property="BorderBrush" Value="#2C364B"/>
    </Style>
    <Style TargetType="ScrollBar">
      <Setter Property="Width" Value="10"/>
    </Style>
  </Window.Resources>

  <Grid>
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="*"/>
      <RowDefinition Height="Auto"/>
    </Grid.RowDefinitions>

    <!-- 顶栏 -->
    <Border Grid.Row="0" Background="#191F2C" BorderBrush="#2C364B" BorderThickness="0,0,0,1" Padding="10,8">
      <Grid>
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="Auto"/><ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>
        <StackPanel Grid.Column="0" Orientation="Horizontal">
          <TextBlock Text="时间规划中心" FontSize="15" FontWeight="SemiBold" Foreground="#E6ECF7" VerticalAlignment="Center" Margin="4,0,14,0"/>
          <Button x:Name="BtnToday" Content="今天" Style="{StaticResource TBtn}"/>
          <Button x:Name="BtnPrev" Content="◀" Style="{StaticResource TBtn}"/>
          <Button x:Name="BtnNext" Content="▶" Style="{StaticResource TBtn}"/>
          <Button x:Name="BtnZoomOut" Content="－" Style="{StaticResource TBtn}"/>
          <Button x:Name="BtnZoomIn" Content="＋" Style="{StaticResource TBtn}"/>
        </StackPanel>
        <StackPanel Grid.Column="1" Orientation="Horizontal" Margin="10,0,0,0">
          <Button x:Name="BtnYear" Content="年" Style="{StaticResource TBtn}"/>
          <Button x:Name="BtnQuarter" Content="季" Style="{StaticResource TBtn}"/>
          <Button x:Name="BtnMonth" Content="月" Style="{StaticResource TBtn}"/>
          <Button x:Name="BtnWeek" Content="周" Style="{StaticResource TBtn}"/>
          <Button x:Name="BtnDay" Content="日" Style="{StaticResource TBtn}"/>
          <Button x:Name="BtnGantt" Content="甘特" Style="{StaticResource TBtn}"/>
        </StackPanel>
        <StackPanel Grid.Column="2" Orientation="Horizontal" HorizontalAlignment="Right" Margin="10,0">
          <TextBlock x:Name="RangeLabel" Text="" Foreground="#93A2BB" VerticalAlignment="Center" Margin="0,0,12,0"/>
          <TextBox x:Name="SearchBox" Width="180" Height="26"/>
          <Button x:Name="BtnSearch" Content="搜索" Style="{StaticResource TBtn}"/>
        </StackPanel>
        <StackPanel Grid.Column="3" Orientation="Horizontal">
          <Button x:Name="BtnPlan5" Content="AI 规划五天" Style="{StaticResource TBtnAccent}"/>
          <Button x:Name="BtnNewItem" Content="新建计划" Style="{StaticResource TBtn}"/>
        </StackPanel>
      </Grid>
    </Border>

    <Grid Grid.Row="1">
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="290"/>
        <ColumnDefinition Width="*"/>
        <ColumnDefinition Width="340"/>
      </Grid.ColumnDefinitions>

      <!-- 左栏 -->
      <Border Grid.Column="0" Background="#191F2C" BorderBrush="#2C364B" BorderThickness="0,0,1,0">
        <Grid Margin="8">
          <Grid.RowDefinitions>
            <RowDefinition Height="Auto"/><RowDefinition Height="2*"/>
            <RowDefinition Height="Auto"/><RowDefinition Height="*"/>
          </Grid.RowDefinitions>
          <TextBlock Grid.Row="0" Text="长期目标 / 项目" Foreground="#93A2BB" Margin="4,2,0,6" FontSize="11"/>
          <TreeView x:Name="GoalTree" Grid.Row="1"/>
          <TextBlock Grid.Row="2" Text="待安排计划池" Foreground="#93A2BB" Margin="4,10,0,6" FontSize="11"/>
          <ListBox x:Name="PoolList" Grid.Row="3"/>
        </Grid>
      </Border>

      <!-- 中栏 -->
      <Grid Grid.Column="1">
        <Grid.RowDefinitions>
          <RowDefinition Height="Auto"/><RowDefinition Height="*"/>
        </Grid.RowDefinitions>
        <Border Grid.Row="0" Background="#151B27" Padding="0">
          <ScrollViewer x:Name="HeaderScroll" HorizontalScrollBarVisibility="Hidden" VerticalScrollBarVisibility="Disabled">
            <Canvas x:Name="HeaderCanvas" Height="42"/>
          </ScrollViewer>
        </Border>
        <ScrollViewer Grid.Row="1" x:Name="TimelineScroll" HorizontalScrollBarVisibility="Auto" VerticalScrollBarVisibility="Auto" Background="#12161F">
          <Canvas x:Name="TimelineCanvas"/>
        </ScrollViewer>
      </Grid>

      <!-- 右栏 -->
      <Border Grid.Column="2" Background="#191F2C" BorderBrush="#2C364B" BorderThickness="1,0,0,0">
        <Grid Margin="8">
          <Grid.RowDefinitions>
            <RowDefinition Height="Auto"/><RowDefinition Height="Auto"/>
            <RowDefinition Height="*"/><RowDefinition Height="Auto"/>
          </Grid.RowDefinitions>

          <StackPanel Grid.Row="0">
            <TextBlock Text="冲突与风险" Foreground="#93A2BB" FontSize="11" Margin="4,2,0,4"/>
            <Border Background="#151B27" CornerRadius="8" Padding="6" MaxHeight="130">
              <ScrollViewer VerticalScrollBarVisibility="Auto">
                <StackPanel x:Name="ConflictList"/>
              </ScrollViewer>
            </Border>
          </StackPanel>

          <StackPanel Grid.Row="1" Margin="0,8,0,0">
            <TextBlock Text="AI 规划建议（需你确认）" Foreground="#93A2BB" FontSize="11" Margin="4,0,0,4"/>
            <Border Background="#151B27" CornerRadius="8" Padding="6" MaxHeight="210">
              <ScrollViewer VerticalScrollBarVisibility="Auto">
                <StackPanel x:Name="ProposalList"/>
              </ScrollViewer>
            </Border>
          </StackPanel>

          <Grid Grid.Row="2" Margin="0,8,0,0">
            <Grid.RowDefinitions>
              <RowDefinition Height="Auto"/><RowDefinition Height="*"/>
            </Grid.RowDefinitions>
            <TextBlock Grid.Row="0" Text="和秘书说" Foreground="#93A2BB" FontSize="11" Margin="4,0,0,4"/>
            <Border Grid.Row="1" Background="#151B27" CornerRadius="8" Padding="6">
              <ScrollViewer VerticalScrollBarVisibility="Auto" x:Name="ChatScroll">
                <StackPanel x:Name="ChatStack"/>
              </ScrollViewer>
            </Border>
          </Grid>

          <Grid Grid.Row="3" Margin="0,6,0,0">
            <Grid.ColumnDefinitions>
              <ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/>
            </Grid.ColumnDefinitions>
            <TextBox x:Name="ChatInput" Grid.Column="0" Height="30" VerticalContentAlignment="Center"/>
            <Button x:Name="ChatSend" Grid.Column="1" Content="发送" Style="{StaticResource TBtnAccent}" Height="30" Margin="6,0,0,0"/>
          </Grid>
        </Grid>
      </Border>
    </Grid>

    <Border Grid.Row="2" Background="#191F2C" BorderBrush="#2C364B" BorderThickness="0,1,0,0" Padding="10,5">
      <Grid>
        <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
        <TextBlock x:Name="StatusText" Grid.Column="0" Text="就绪" Foreground="#93A2BB" FontSize="11"/>
        <TextBlock x:Name="CountText" Grid.Column="1" Text="" Foreground="#5C6B85" FontSize="11"/>
      </Grid>
    </Border>
  </Grid>
</Window>
"@

    $win = [System.Windows.Markup.XamlReader]::Parse($xaml)
    $statusText = $win.FindName('StatusText')
    $countText = $win.FindName('CountText')
    $rangeLabel = $win.FindName('RangeLabel')
    $headerCanvas = $win.FindName('HeaderCanvas')
    $timelineCanvas = $win.FindName('TimelineCanvas')
    $timelineScroll = $win.FindName('TimelineScroll')
    $headerScroll = $win.FindName('HeaderScroll')
    $goalTree = $win.FindName('GoalTree')
    $poolList = $win.FindName('PoolList')
    $conflictList = $win.FindName('ConflictList')
    $proposalList = $win.FindName('ProposalList')
    $chatStack = $win.FindName('ChatStack')
    $chatScroll = $win.FindName('ChatScroll')
    $chatInput = $win.FindName('ChatInput')

    $script:statusText = $statusText
    $script:rangeLabel = $rangeLabel
    $script:headerCanvas = $headerCanvas
    $script:timelineCanvas = $timelineCanvas
    $script:timelineScroll = $timelineScroll
    $script:headerScroll = $headerScroll
    $script:goalTree = $goalTree
    $script:poolList = $poolList
    $script:conflictList = $conflictList
    $script:proposalList = $proposalList
    $script:chatStack = $chatStack
    $script:chatScroll = $chatScroll
    $script:chatInput = $chatInput
    $script:win = $win

    # ---------------- 类型 / 精度 的中文标签 ----------------
    $script:KindLabels = [ordered]@{
        'task'      = '任务（具体要做的一件事）'
        'milestone' = '里程碑（某个时间点的成果，画成菱形）'
        'project'   = '项目（一组工作）'
        'phase'     = '阶段（项目里的一段）'
        'goal'      = '长期目标（年/季度方向）'
    }
    $script:PrecLabels = [ordered]@{
        'unscheduled' = '待安排（还没定时间）'
        'day'         = '日（填结束日期=连续多天）'
        'slot'        = '具体时段（会到点提醒）'
        'week'        = '周'
        'month'       = '月'
        'quarter'     = '季'
        'year'        = '年'
    }

    function Get-Label($map, [string]$value) {
        foreach ($k in $map.Keys) { if ($k -eq $value) { return [string]$map[$k] } }
        return ''
    }
    function Get-RawValue($map, [string]$label) {
        foreach ($k in $map.Keys) { if ([string]$map[$k] -eq $label) { return [string]$k } }
        return $label
    }

    # ---------------- 缩放/范围 ----------------
    $script:MODES = @{
        year = @{ days = 365; rowH = 26 }; quarter = @{ days = 92; rowH = 28 }
        month = @{ days = 31; rowH = 30 }; week = @{ days = 7; rowH = 38 }
        day = @{ days = 1; rowH = 26 }; gantt = @{ days = 120; rowH = 26 }
    }

    function Set-Mode([string]$mode) {
        $script:mode = $mode
        $d = $script:MODES[$mode].days
        $script:viewDays = $d
        try {
            $now = (Get-Date).Date
            $y = [int]$now.Year
            $mo = [int]$now.Month
            switch ($mode) {
                'year' { $script:viewStart = [datetime]::new($y, 1, 1) }
                'quarter' {
                    $q = [int][Math]::Floor(($mo - 1) / 3)
                    $script:viewStart = [datetime]::new($y, ($q * 3 + 1), 1)
                }
                'month' { $script:viewStart = [datetime]::new($y, $mo, 1) }
                'week' { $script:viewStart = $now.AddDays(-1) }
                'day' { $script:viewStart = $now }
                'gantt' { $script:viewStart = $now.AddDays(-7) }
            }
        } catch {
            Log "Set-Mode($mode) failed: $($_.Exception.Message)"
            $script:viewStart = (Get-Date).Date.AddDays(-1)
            $script:viewDays = 7
        }
        Render-Timeline
    }

    function Shift-View([int]$dir) {
        $step = [Math]::Max(1, [int]($script:viewDays / 3))
        $script:viewStart = $script:viewStart.AddDays($dir * $step)
        Render-Timeline
    }

    function Zoom-Timeline([double]$factor) {
        $script:viewDays = [int][Math]::Max(1, [Math]::Min(730, [Math]::Round($script:viewDays * $factor)))
        Render-Timeline
    }

    function Get-ItemStart($it) {
        $d = Get-Field $it 'startDate' $null
        if (-not $d) { return $null }
        try { return [DateTime]::ParseExact([string]$d, 'yyyy-MM-dd', $null) } catch { return $null }
    }

    function Get-ItemEnd($it) {
        $d = Get-Field $it 'endDate' $null
        if ($d) { try { return [DateTime]::ParseExact([string]$d, 'yyyy-MM-dd', $null) } catch { } }
        return (Get-ItemStart $it)
    }

    function Test-ItemVisible($it, [DateTime]$from, [DateTime]$to) {
        $s = Get-ItemStart $it
        if (-not $s) { return $false }
        $e = Get-ItemEnd $it
        if (-not $e) { $e = $s }
        return ($e -ge $from -and $s -le $to)
    }

    # ---------------- 时间轴渲染 ----------------
    function Render-Timeline {
        try {
            $canvas = $script:timelineCanvas
            $header = $script:headerCanvas
            $canvas.Children.Clear()
            $header.Children.Clear()

            $from = $script:viewStart
            $to = $from.AddDays($script:viewDays)
            $totalDays = [double]$script:viewDays
            $script:viewFrom = $from
            $script:viewTo = $to

            $dayW = 34.0
            if ($script:viewDays -le 1) { $dayW = 900.0 }
            elseif ($script:viewDays -le 8) { $dayW = 120.0 }
            elseif ($script:viewDays -le 40) { $dayW = 34.0 }
            elseif ($script:viewDays -le 120) { $dayW = 12.0 }
            else { $dayW = 4.0 }
            $script:dayW = $dayW
            $width = [Math]::Max(900, [Math]::Round($totalDays * $dayW, 0))
            $script:canvasWidth = $width

            $script:rangeLabel.Text = "$($from.ToString('yyyy-MM-dd')) → $($to.AddDays(-1).ToString('yyyy-MM-dd'))"

            # 表头：按尺度选刻度
            $header.Width = $width
            $canvas.Width = $width
            $labelStep = 1
            if ($dayW -lt 8) { $labelStep = 7 }
            if ($dayW -lt 5) { $labelStep = 30 }
            for ($i = 0; $i -lt $script:viewDays; $i++) {
                $d = $from.AddDays($i)
                $x = [Math]::Round($i * $dayW, 1)
                $isMonthStart = ($d.Day -eq 1)
                $isMonday = ($d.DayOfWeek -eq 'Monday')
                if ($dayW -ge 8 -or $isMonthStart -or ($i % $labelStep -eq 0)) {
                    $line = New-Object System.Windows.Shapes.Line
                    $line.X1 = $x; $line.X2 = $x; $line.Y1 = 0; $line.Y2 = 42
                    $line.Stroke = Brush $(if ($isMonthStart) { $COL.GridStrong } else { $COL.Grid })
                    $line.StrokeThickness = 1
                    [void]$header.Children.Add($line)
                }
                if ($dayW -ge 60 -or $isMonthStart -or ($dayW -ge 18 -and $i % 1 -eq 0)) {
                    $t = New-Object System.Windows.Controls.TextBlock
                    if ($dayW -lt 18) { $t.Text = if ($isMonthStart) { $d.ToString('M月') } else { '' } }
                    elseif ($dayW -ge 60) { $t.Text = $d.ToString('M月d日') }
                    else { $t.Text = "$($d.Day)" }
                    if ($t.Text) {
                        $t.Foreground = Brush $(if ($isMonthStart -or $dayW -ge 60) { $COL.Text } else { $COL.Sub })
                        $t.FontSize = 11
                        $t.FontWeight = if ($isMonthStart -or $dayW -ge 60) { 'SemiBold' } else { 'Normal' }
                        [System.Windows.Controls.Canvas]::SetLeft($t, $x + 4)
                        [System.Windows.Controls.Canvas]::SetTop($t, 2)
                        [void]$header.Children.Add($t)
                    }
                }
                if ($dayW -ge 60) {
                    $w = New-Object System.Windows.Controls.TextBlock
                    $w.Text = $d.ToString('ddd')
                    $w.Foreground = Brush $(if ($d.DayOfWeek -eq 'Saturday' -or $d.DayOfWeek -eq 'Sunday') { $COL.Bad } else { $COL.Sub })
                    $w.FontSize = 10
                    [System.Windows.Controls.Canvas]::SetLeft($w, $x + 4)
                    [System.Windows.Controls.Canvas]::SetTop($w, 19)
                    [void]$header.Children.Add($w)
                }
            }

            # 行分配：按时间重叠分组
            $visible = @($script:items | Where-Object {
                    $p = [string](Get-Field $_ 'precision' 'unscheduled')
                    $p -ne 'unscheduled' -and (Test-ItemVisible $_ $from $to)
                } | Sort-Object { Get-ItemStart $_ })

            $rowH = [double]$script:MODES[$script:mode].rowH
            $laneEnds = @()
            $placed = @()
            foreach ($it in $visible) {
                $s = Get-ItemStart $it
                $e = Get-ItemEnd $it
                if (-not $e) { $e = $s }
                $lane = 0
                while ($lane -lt $laneEnds.Count -and $laneEnds[$lane] -ge $s) { $lane++ }
                if ($lane -ge $laneEnds.Count) { $laneEnds += $e } else { $laneEnds[$lane] = $e }
                $placed += [pscustomobject]@{ item = $it; start = $s; end = $e; lane = $lane }
            }
            $laneCount = [Math]::Max(1, $laneEnds.Count)
            $canvas.Height = [Math]::Max(400, ($laneCount + 1) * $rowH + 40)

            # 背景网格
            for ($i = 0; $i -le $script:viewDays; $i++) {
                $d = $from.AddDays($i)
                if ($dayW -lt 6 -and -not ($d.Day -eq 1)) { continue }
                $line = New-Object System.Windows.Shapes.Line
                $x = [Math]::Round($i * $dayW, 1)
                $line.X1 = $x; $line.X2 = $x; $line.Y1 = 0; $line.Y2 = $canvas.Height
                $line.Stroke = Brush $(if ($d.Day -eq 1) { $COL.GridStrong } else { $COL.Grid })
                $line.StrokeThickness = 1
                [void]$canvas.Children.Add($line)
            }
            # 周/日视图：小时刻度
            if ($dayW -ge 300) {
                for ($d2 = 0; $d2 -lt $script:viewDays; $d2++) {
                    for ($h = 0; $h -lt 24; $h += 3) {
                        $hx = [Math]::Round($d2 * $dayW + ($h / 24.0) * $dayW, 1)
                        $hl = New-Object System.Windows.Shapes.Line
                        $hl.X1 = $hx; $hl.X2 = $hx; $hl.Y1 = 0; $hl.Y2 = $canvas.Height
                        $hl.Stroke = Brush $COL.Grid; $hl.StrokeThickness = 0.6; $hl.Opacity = 0.55
                        [void]$canvas.Children.Add($hl)
                        $ht = New-Object System.Windows.Controls.TextBlock
                        $ht.Text = "$h"
                        $ht.Foreground = Brush '#4C5A72'
                        $ht.FontSize = 8
                        [System.Windows.Controls.Canvas]::SetLeft($ht, $hx + 1)
                        [System.Windows.Controls.Canvas]::SetTop($ht, 24)
                        [void]$header.Children.Add($ht)
                    }
                }
            }

            # 今天线
            $today = (Get-Date).Date
            $dx = ($today - $from).TotalDays
            if ($dx -ge 0 -and $dx -le $totalDays) {
                $tl = New-Object System.Windows.Shapes.Line
                $tl.X1 = [Math]::Round($dx * $dayW, 1); $tl.X2 = $tl.X1; $tl.Y1 = 0; $tl.Y2 = $canvas.Height
                $tl.Stroke = Brush '#FF7A85'; $tl.StrokeThickness = 1.5; $tl.Opacity = 0.65
                [void]$canvas.Children.Add($tl)
            }
            # 周末底色
            for ($i = 0; $i -lt $script:viewDays; $i++) {
                $d = $from.AddDays($i)
                if ($dayW -lt 12) { break }
                if ($d.DayOfWeek -eq 'Saturday' -or $d.DayOfWeek -eq 'Sunday') {
                    $r = New-Object System.Windows.Shapes.Rectangle
                    $r.Width = $dayW; $r.Height = $canvas.Height
                    $r.Fill = Brush '#0E131C'
                    [System.Windows.Controls.Canvas]::SetLeft($r, [Math]::Round($i * $dayW, 1))
                    [void]$canvas.Children.Add($r)
                }
            }

            # 计划块
            foreach ($p in $placed) {
                $it = $p.item
                $kind = [string](Get-Field $it 'kind' 'task')
                $precision = [string](Get-Field $it 'precision' 'day')
                $dayStart = [Math]::Round((($p.start) - $from).TotalDays * $dayW, 1)
                if ($precision -eq 'slot') {
                    $st = [string](Get-Field $it 'startTime' '')
                    $et = [string](Get-Field $it 'endTime' '')
                    $f0 = 0.0; $f1 = 1.0
                    if ($st -match '^(\d{1,2}):(\d{2})$') { $f0 = ([int]$Matches[1] * 60 + [int]$Matches[2]) / 1440.0 }
                    if ($et -match '^(\d{1,2}):(\d{2})$') { $f1 = ([int]$Matches[1] * 60 + [int]$Matches[2]) / 1440.0 }
                    if ($f1 -le $f0) { $f1 = [Math]::Min(1.0, $f0 + 0.02) }
                    $x0 = $dayStart + [Math]::Round($f0 * $dayW, 1)
                    $x1 = $dayStart + [Math]::Round($f1 * $dayW, 1)
                } else {
                    $x0 = $dayStart
                    $x1 = [Math]::Round(((($p.end).AddDays(1)) - $from).TotalDays * $dayW, 1)
                    if ($precision -eq 'day' -and $p.end -eq $p.start) { $x1 = $x0 + $dayW }
                }
                $minW = if ($dayW -ge 300) { 5 } elseif ($dayW -ge 60) { 54 } else { 8 }
                if ($x1 - $x0 -lt $minW) { $x1 = $x0 + $minW }
                $y = $p.lane * $rowH + 6

                if ($kind -eq 'milestone') {
                    $dia = New-Object System.Windows.Shapes.Polygon
                    $pts = New-Object System.Windows.Media.PointCollection
                    $cxp = $x0 + 6; $cyp = $y + 9
                    $pts.Add([System.Windows.Point]::new($cxp, $cyp - 8))
                    $pts.Add([System.Windows.Point]::new($cxp + 8, $cyp))
                    $pts.Add([System.Windows.Point]::new($cxp, $cyp + 8))
                    $pts.Add([System.Windows.Point]::new($cxp - 8, $cyp))
                    $dia.Points = $pts
                    $dia.Fill = Brush $COL.Milestone
                    $dia.ToolTip = "$(Get-Field $it 'title' '')  （里程碑 $(Get-Field $it 'startDate' '')）"
                    [System.Windows.Controls.Canvas]::SetLeft($dia, 0)
                    [System.Windows.Controls.Canvas]::SetTop($dia, $y)
                    [void]$canvas.Children.Add($dia)

                    $tb = New-Object System.Windows.Controls.TextBlock
                    $tb.Text = "◆ $(Get-Field $it 'title' '')"
                    $tb.Foreground = Brush $COL.Milestone
                    $tb.FontSize = 11
                    [System.Windows.Controls.Canvas]::SetLeft($tb, $cxp + 12)
                    [System.Windows.Controls.Canvas]::SetTop($tb, $y + 2)
                    [void]$canvas.Children.Add($tb)
                    continue
                }

                $prio = [int](Get-Field $it 'priority' 2)
                $baseCol = if (Get-Field $it 'color' $null) { [string](Get-Field $it 'color') } else { $PRIO_COLORS[$prio] }
                $isDone = ([string](Get-Field $it 'status' '')) -eq 'done'
                $locked = [bool](Get-Field $it 'locked' $false)

                $bar = New-Object System.Windows.Controls.Border
                $bar.CornerRadius = [System.Windows.CornerRadius]::new(5)
                $bar.Background = Brush $baseCol
                $bar.Opacity = if ($isDone) { 0.42 } else { 0.92 }
                $bar.BorderThickness = [System.Windows.Thickness]::new(1)
                $bar.BorderBrush = Brush $(if ($locked) { '#FFD98A' } else { '#00000000' })
                $bar.Width = [Math]::Max(6, $x1 - $x0 - 2)
                $bar.Height = $rowH - 10
                $bar.Tag = $it
                $bar.ToolTip = "$(Get-Field $it 'title' '')`n$(Get-Field $it 'precision' '')  $(Get-Field $it 'startDate' '')$(if (Get-Field $it 'startTime' $null) { ' ' + (Get-Field $it 'startTime') } else { '' })"
                if ($bar.Width -gt 46) {
                    $txt = New-Object System.Windows.Controls.TextBlock
                    $txt.Text = [string](Get-Field $it 'title' '')
                    $txt.Foreground = Brush '#0E131C'
                    $txt.FontSize = 11
                    $txt.Margin = [System.Windows.Thickness]::new(6, 0, 4, 0)
                    $txt.VerticalAlignment = 'Center'
                    $txt.TextTrimming = 'CharacterEllipsis'
                    $bar.Child = $txt
                }
                [System.Windows.Controls.Canvas]::SetLeft($bar, $x0 + 1)
                [System.Windows.Controls.Canvas]::SetTop($bar, $y)
                $bar.Add_MouseLeftButtonDown({ param($s, $e) Start-BarDrag $s $e })
                $bar.Add_MouseRightButtonUp({ param($s, $e) Show-ItemMenu $s $e })
                [void]$canvas.Children.Add($bar)
            }

            $script:countText.Text = "共 $($script:items.Count) 项 · 当前视图 $($visible.Count) 项"
            $script:statusText.Text = if ($script:offline) { '服务未连接：本地缓存只读' } else { '就绪' }
            $script:statusText.Foreground = Brush $(if ($script:offline) { $COL.Warn } else { $COL.Sub })
        } catch { Log "render: $($_.Exception.Message)`n$($_.ScriptStackTrace)"; $script:statusText.Text = "渲染失败：$($_.Exception.Message)" }
    }

    # ---------------- 拖动改期 ----------------
    $script:barDrag = $null
    function Start-BarDrag($sender, $e) {
        try {
            $it = $sender.Tag
            $script:selectedId = [string](Get-Field $it 'id' '')
            $script:barDrag = @{
                item = $it; startX = $e.GetPosition($script:timelineCanvas).X
                origStart = (Get-ItemStart $it); origEnd = (Get-ItemEnd $it); moved = $false
            }
            $sender.CaptureMouse()
            $e.Handled = $true
            Show-ItemInfo $it
        } catch { Log "drag start: $($_.Exception.Message)" }
    }

    function End-BarDrag($sender) {
        if (-not $script:barDrag) { return }
        $d = $script:barDrag
        $script:barDrag = $null
        try { $sender.ReleaseMouseCapture() } catch { }
        if (-not $d.moved) { return }
        $deltaDays = [int][Math]::Round(($d.curX - $d.startX) / $script:dayW)
        if ($deltaDays -eq 0) { return }
        $it = $d.item
        $id = [string](Get-Field $it 'id' '')
        $ns = $d.origStart.AddDays($deltaDays)
        $patch = @{ startDate = $ns.ToString('yyyy-MM-dd'); source = 'user' }
        if ($d.origEnd) { $patch.endDate = $d.origEnd.AddDays($deltaDays).ToString('yyyy-MM-dd') }
        Save-Item $id $patch
        $script:statusText.Text = "已移动到 $($ns.ToString('MM-dd'))"
    }

    # 在 Canvas 上用全局鼠标事件跟踪
    $timelineCanvas.Add_MouseMove({
            param($s, $e)
            if (-not $script:barDrag) { return }
            $x = $e.GetPosition($script:timelineCanvas).X
            $script:barDrag.curX = $x
            if ([Math]::Abs($x - $script:barDrag.startX) -gt 4) { $script:barDrag.moved = $true }
        })
    $timelineCanvas.Add_MouseLeftButtonUp({
            param($s, $e)
            if ($script:barDrag) { End-BarDrag $s }
        })

    function Show-ItemInfo($it) {
        $script:statusText.Text = "$(Get-Field $it 'kind' '') · $(Get-Field $it 'title' '') · $(Get-Field $it 'precision' '') $(Get-Field $it 'startDate' '') $(Get-Field $it 'startTime' '') · 进度 $(Get-Field $it 'progress' 0)%"
    }

    # 右键菜单：必须用 MenuItem 对象。
    # 直接 $menu.Items.Add('文字') 加进去的是 string，再 .Add_Click 会抛
    # "[System.String] 不包含名为 Add_Click 的方法"，把整个窗口带崩。
    function New-ItemMenu($it) {
        $locked = [bool](Get-Field $it 'locked' $false)
        $m = New-Object System.Windows.Controls.ContextMenu
        $defs = @(
            @{ Text = '编辑…'; Action = 'edit' }
            @{ Text = $(if ($locked) { '解除锁定' } else { '锁定（AI 不得改动）' }); Action = 'lock' }
            @{ Text = '标记完成'; Action = 'done' }
            @{ Text = '删除…'; Action = 'delete' }
        )
        foreach ($d in $defs) {
            $mi = New-Object System.Windows.Controls.MenuItem
            $mi.Header = [string]$d.Text
            # 每条菜单项自己记住"对谁、做什么"，避免多个菜单共用一份状态互相踩
            $mi.Tag = @{ action = [string]$d.Action; item = $it }
            $mi.Add_Click({ param($s, $e) Invoke-ItemMenuAction ([string]$s.Tag.action) $s.Tag.item })
            [void]$m.Items.Add($mi)
        }
        return $m
    }

    function Invoke-ItemMenuAction([string]$action, $it) {
        if (-not $it) { return }
        $title = [string](Get-Field $it 'title' '')
        switch ($action) {
            'edit' { Open-ItemDialog $it }
            'lock' { Toggle-Lock $it }
            'done' { Complete-Item $it }
            'delete' {
                $answer = [System.Windows.MessageBox]::Show(
                    "确定删除「$title」吗？`n子计划不会被删除，只会脱离父级。",
                    '删除计划', [System.Windows.MessageBoxButton]::YesNo, [System.Windows.MessageBoxImage]::Warning)
                if ($answer -eq [System.Windows.MessageBoxResult]::Yes) { Delete-Item $it }
            }
        }
    }

    function Show-ItemMenu($sender, $e) {
        try {
            $menu = New-ItemMenu $sender.Tag
            $menu.PlacementTarget = $sender
            $menu.IsOpen = $true
        } catch { Log "item menu: $($_.Exception.Message)" }
        $e.Handled = $true
    }

    function Toggle-Lock($it) {
        $id = [string](Get-Field $it 'id' '')
        $newVal = -not [bool](Get-Field $it 'locked' $false)
        $script:statusText.Text = $(if ($newVal) { '已锁定，AI 不会自动改它' } else { '已解除锁定' })
        Invoke-BridgeAsync -Path "/items/$id/lock" -Method 'POST' -Body @{ locked = $newVal; source = 'user' } -OnDone {
            param($json, $err) if ($err) { Log "lock: $err" }; Refresh-All
        }
    }
    function Complete-Item($it) {
        $id = [string](Get-Field $it 'id' '')
        $script:statusText.Text = "已完成「$([string](Get-Field $it 'title' ''))」"
        Invoke-BridgeAsync -Path "/items/$id/progress" -Method 'POST' -Body @{ progress = 100; status = 'done'; source = 'user' } -OnDone {
            param($json, $err) if ($err) { Log "done: $err" }; Refresh-All
        }
    }
    function Delete-Item($it) {
        $id = [string](Get-Field $it 'id' '')
        $title = [string](Get-Field $it 'title' '')
        # 先从本地列表里拿掉，界面立刻反应；随后以服务端返回为准
        $script:items = @($script:items | Where-Object { [string](Get-Field $_ 'id' '') -ne $id })
        $script:itemsSig = $null
        Rebuild-LeftPanel
        Render-Timeline
        $script:statusText.Text = "已删除「$title」"
        Invoke-BridgeAsync -Path "/items/$id" -Method 'DELETE' -OnDone {
            param($json, $err)
            if ($err) { Log "delete: $err"; $script:statusText.Text = "删除失败：$err"; $script:statusText.Foreground = Brush $COL.Bad }
            Refresh-All
        }
    }

    # ---------------- 左栏 ----------------
    function Rebuild-LeftPanel {
        try {
            $script:goalTree.Items.Clear()
            $byParent = @{}
            foreach ($it in $script:items) {
                $p = [string](Get-Field $it 'parentId' '')
                if (-not $byParent.ContainsKey($p)) { $byParent[$p] = @() }
                $byParent[$p] += $it
            }
            function New-Node($it, $depth) {
                $kind = [string](Get-Field $it 'kind' 'task')
                $icon = switch ($kind) { 'goal' { '◎' } 'project' { '▤' } 'phase' { '▸' } 'milestone' { '◆' } default { '·' } }
                $prog = [int](Get-Field $it 'progress' 0)
                $lockMark = if ([bool](Get-Field $it 'locked' $false)) { ' 🔒' } else { '' }
                $item = New-Object System.Windows.Controls.TreeViewItem
                $sp = New-Object System.Windows.Controls.StackPanel
                $sp.Orientation = 'Horizontal'
                $tb = New-Object System.Windows.Controls.TextBlock
                $tb.Text = "$icon $(Get-Field $it 'title' '')$lockMark"
                $tb.Foreground = Brush $(if ($kind -eq 'goal') { $COL.Accent } elseif ($kind -eq 'milestone') { $COL.Milestone } else { $COL.Text })
                $tb.FontSize = 12
                $tb.VerticalAlignment = 'Center'
                [void]$sp.Children.Add($tb)
                if ($prog -gt 0) {
                    $pb = New-Object System.Windows.Controls.ProgressBar
                    $pb.Value = $prog; $pb.Width = 40; $pb.Height = 4; $pb.Margin = [System.Windows.Thickness]::new(8, 0, 0, 0)
                    $pb.Foreground = Brush $COL.Ok; $pb.Background = Brush '#2C364B'; $pb.BorderThickness = [System.Windows.Thickness]::new(0)
                    [void]$sp.Children.Add($pb)
                }
                $item.Header = $sp
                $item.Tag = $it
                $item.IsExpanded = ($depth -lt 1)
                $item.Add_MouseDoubleClick({ param($s, $e) Open-ItemDialog $s.Tag })
                try { $item.ContextMenu = New-ItemMenu $it } catch { }
                $id = [string](Get-Field $it 'id' '')
                if ($byParent.ContainsKey($id)) {
                    foreach ($c in $byParent[$id]) { [void]$item.Items.Add((New-Node $c ($depth + 1))) }
                }
                return $item
            }
            foreach ($root in @($byParent[''])) {
                $kind = [string](Get-Field $root 'kind' 'task')
                if ($kind -eq 'goal' -or $kind -eq 'project' -or $kind -eq 'milestone' -or $kind -eq 'phase') {
                    [void]$script:goalTree.Items.Add((New-Node $root 0))
                }
            }
            # 待安排池
            $script:poolList.Items.Clear()
            $pool = @($script:items | Where-Object { [string](Get-Field $_ 'precision' 'unscheduled') -eq 'unscheduled' })
            foreach ($it in $pool) {
                $li = New-Object System.Windows.Controls.ListBoxItem
                $li.Content = "· $(Get-Field $it 'title' '')  [$(Get-Field $it 'kind' '')]"
                $li.Tag = $it
                $li.Foreground = Brush $COL.Text
                $li.Add_MouseDoubleClick({ param($s, $e) Open-ItemDialog $s.Tag })
                try { $li.ContextMenu = New-ItemMenu $it } catch { }
                [void]$script:poolList.Items.Add($li)
            }
            if ($pool.Count -eq 0) {
                $ph = New-Object System.Windows.Controls.TextBlock
                $ph.Text = '（没有待安排的计划）'
                $ph.Foreground = Brush $COL.Sub
                $ph.FontSize = 11
                $ph.Margin = [System.Windows.Thickness]::new(6, 4, 0, 0)
                [void]$script:poolList.Items.Add($ph)
            }
        } catch { Log "left panel: $($_.Exception.Message)" }
    }

    # ---------------- 右栏：冲突 / 建议 / 聊天 ----------------
    function Render-Conflicts {
        $script:conflictList.Children.Clear()
        if ($script:conflicts.Count -eq 0) {
            $t = New-Object System.Windows.Controls.TextBlock
            $t.Text = '暂时没有检测到冲突。'
            $t.Foreground = Brush $COL.Sub; $t.FontSize = 11; $t.Margin = [System.Windows.Thickness]::new(4, 2, 0, 2)
            [void]$script:conflictList.Children.Add($t)
            return
        }
        foreach ($c in ($script:conflicts | Select-Object -First 12)) {
            $b = New-Object System.Windows.Controls.Border
            $b.CornerRadius = [System.Windows.CornerRadius]::new(6)
            $b.Background = Brush '#1B2231'
            $b.Padding = [System.Windows.Thickness]::new(8, 5, 8, 5)
            $b.Margin = [System.Windows.Thickness]::new(0, 0, 0, 4)
            $sp = New-Object System.Windows.Controls.StackPanel
            $sev = [string](Get-Field $c 'severity' 'low')
            $tag = New-Object System.Windows.Controls.TextBlock
            $tag.Text = switch ([string](Get-Field $c 'type' '')) {
                'overlap' { '时间冲突' } 'due-risk' { '截止风险' } 'dependency' { '依赖冲突' }
                'overload' { '负荷过高' } 'stale-goal' { '目标停滞' } 'no-execution' { '缺少执行' } default { '提醒' }
            }
            $tag.Foreground = Brush $(if ($sev -eq 'high') { $COL.Bad } elseif ($sev -eq 'medium') { $COL.Warn } else { $COL.Sub })
            $tag.FontSize = 10
            $msg = New-Object System.Windows.Controls.TextBlock
            $msg.Text = [string](Get-Field $c 'message' '')
            $msg.Foreground = Brush $COL.Text
            $msg.TextWrapping = 'Wrap'
            $msg.FontSize = 11
            [void]$sp.Children.Add($tag)
            [void]$sp.Children.Add($msg)
            $b.Child = $sp
            [void]$script:conflictList.Children.Add($b)
        }
    }

    function Render-Proposals {
        $script:proposalList.Children.Clear()
        if ($script:proposals.Count -eq 0) {
            $t = New-Object System.Windows.Controls.TextBlock
            $t.Text = '还没有待确认的建议。点右上角「AI 规划五天」。'
            $t.Foreground = Brush $COL.Sub; $t.FontSize = 11; $t.TextWrapping = 'Wrap'
            $t.Margin = [System.Windows.Thickness]::new(4, 2, 0, 2)
            [void]$script:proposalList.Children.Add($t)
            return
        }
        foreach ($p in $script:proposals) {
            $b = New-Object System.Windows.Controls.Border
            $b.CornerRadius = [System.Windows.CornerRadius]::new(8)
            $b.Background = Brush '#1B2231'
            $b.Padding = [System.Windows.Thickness]::new(8, 6, 8, 6)
            $b.Margin = [System.Windows.Thickness]::new(0, 0, 0, 6)
            $sp = New-Object System.Windows.Controls.StackPanel
            $title = New-Object System.Windows.Controls.TextBlock
            $title.Text = [string](Get-Field $p 'title' 'AI 建议')
            $title.Foreground = Brush $COL.Accent; $title.FontWeight = 'SemiBold'; $title.TextWrapping = 'Wrap'
            [void]$sp.Children.Add($title)
            $desc = New-Object System.Windows.Controls.TextBlock
            $fullSummary = [string](Get-Field $p 'summary' '')
            if ($fullSummary.Length -gt 180) { $fullSummary = $fullSummary.Substring(0, 180).TrimEnd() + '…' }
            $desc.Text = $fullSummary
            $desc.Foreground = Brush $COL.Sub; $desc.FontSize = 11; $desc.TextWrapping = 'Wrap'
            $desc.Margin = [System.Windows.Thickness]::new(0, 3, 0, 6)
            $desc.ToolTip = [string](Get-Field $p 'summary' '')
            [void]$sp.Children.Add($desc)
            $row = New-Object System.Windows.Controls.StackPanel
            $row.Orientation = 'Horizontal'
            $ok = New-Object System.Windows.Controls.Button
            $ok.Content = '接受'; $ok.Style = $script:win.Resources['TBtnAccent']; $ok.Tag = [string](Get-Field $p 'id' '')
            $ok.Add_Click({ param($s, $e) Resolve-Proposal ([string]$s.Tag) 'accept' })
            $no = New-Object System.Windows.Controls.Button
            $no.Content = '忽略'; $no.Style = $script:win.Resources['TBtn']; $no.Tag = [string](Get-Field $p 'id' '')
            $no.Add_Click({ param($s, $e) Resolve-Proposal ([string]$s.Tag) 'reject' })
            [void]$row.Children.Add($ok)
            [void]$row.Children.Add($no)
            [void]$sp.Children.Add($row)
            $b.Child = $sp
            [void]$script:proposalList.Children.Add($b)
        }
    }

    function Resolve-Proposal([string]$id, [string]$action) {
        Invoke-BridgeAsync -Path "/proposals/$id/$action" -Method 'POST' -Body @{ source = 'user' } -OnDone {
            param($json, $err)
            if ($err) { $script:statusText.Text = "操作失败：$err"; return }
            $skipped = AsArray $json 'skipped'
            $msg = if ($skipped.Count -gt 0) { "已应用，跳过 $($skipped.Count) 个锁定项" } else { '已应用建议' }
            $script:statusText.Text = $msg
            Refresh-All
        }
    }

    function Add-Chat([string]$who, [string]$text, [string]$color = '') {
        $b = New-Object System.Windows.Controls.Border
        $b.CornerRadius = [System.Windows.CornerRadius]::new(8)
        $b.Background = Brush $(if ($who -eq 'me') { '#22314A' } else { '#1B2231' })
        $b.Padding = [System.Windows.Thickness]::new(8, 5, 8, 5)
        $b.Margin = [System.Windows.Thickness]::new(0, 0, 0, 6)
        $b.HorizontalAlignment = if ($who -eq 'me') { 'Right' } else { 'Left' }
        $b.MaxWidth = 280
        $t = New-Object System.Windows.Controls.TextBlock
        $t.Text = $text
        $t.TextWrapping = 'Wrap'
        $t.Foreground = Brush $(if ($color) { $color } else { $COL.Text })
        $b.Child = $t
        [void]$script:chatStack.Children.Add($b)
        $script:chatScroll.ScrollToEnd()
    }

    function Describe-Ops($ops) {
        $lines = @()
        foreach ($op in @($ops)) {
            $o = [string](Get-Field $op 'op' '')
            if ($o -eq 'delete') {
                $id = [string](Get-Field $op 'id' '')
                $hit = @($script:items | Where-Object { [string](Get-Field $_ 'id' '') -eq $id }) | Select-Object -First 1
                $t = if ($hit) { [string](Get-Field $hit 'title' '') } else { $id }
                $lines += "🗑 删除：$t"
            } elseif ($o -eq 'create') {
                $itm = Get-Field $op 'item' $null
                $p = [string](Get-Field $itm 'precision' '')
                $d = [string](Get-Field $itm 'startDate' '')
                $st = [string](Get-Field $itm 'startTime' '')
                $et = [string](Get-Field $itm 'endTime' '')
                $when = if ($st) { "$d $st-$et" } elseif ($d) { $d } else { '未定时间' }
                $lines += "➕ 新建：$([string](Get-Field $itm 'title' ''))（$p，$when）"
            } elseif ($o -eq 'update') {
                $id = [string](Get-Field $op 'id' '')
                $hit = @($script:items | Where-Object { [string](Get-Field $_ 'id' '') -eq $id }) | Select-Object -First 1
                $t = if ($hit) { [string](Get-Field $hit 'title' '') } else { $id }
                $patch = Get-Field $op 'patch' $null
                $lines += "✏ 修改：$t → $($patch | ConvertTo-Json -Compress)"
            }
        }
        return $lines
    }

    # 在对话里放一张"可执行卡片"：列出要做什么 + 执行/取消
    function Show-ActionCard([string]$title, $ops) {
        try {
            $script:accOps = @($ops)
            $script:accSummary = $title
            $b = New-Object System.Windows.Controls.Border
            $b.CornerRadius = [System.Windows.CornerRadius]::new(8)
            $b.Background = Brush '#22314A'
            $b.Padding = [System.Windows.Thickness]::new(9, 7, 9, 7)
            $b.Margin = [System.Windows.Thickness]::new(0, 0, 0, 6)
            $b.MaxWidth = 280
            $b.HorizontalAlignment = 'Left'

            $sp = New-Object System.Windows.Controls.StackPanel
            $t = New-Object System.Windows.Controls.TextBlock
            $t.Text = $title
            $t.Foreground = Brush $COL.Accent
            $t.FontWeight = 'SemiBold'
            $t.TextWrapping = 'Wrap'
            [void]$sp.Children.Add($t)

            foreach ($line in (Describe-Ops $ops)) {
                $lt = New-Object System.Windows.Controls.TextBlock
                $lt.Text = $line
                $lt.Foreground = Brush $COL.Text
                $lt.FontSize = 11
                $lt.TextWrapping = 'Wrap'
                $lt.Margin = [System.Windows.Thickness]::new(0, 3, 0, 0)
                [void]$sp.Children.Add($lt)
            }

            $row = New-Object System.Windows.Controls.StackPanel
            $row.Orientation = 'Horizontal'
            $row.Margin = [System.Windows.Thickness]::new(0, 7, 0, 0)
            $ok = New-Object System.Windows.Controls.Button
            $ok.Content = '执行'
            $ok.Style = $script:win.Resources['TBtnAccent']
            $ok.Add_Click({ Invoke-ActionCard })
            $no = New-Object System.Windows.Controls.Button
            $no.Content = '取消'
            $no.Style = $script:win.Resources['TBtn']
            $no.Add_Click({ Add-Chat 'ai' '好，这次不改。' $COL.Sub; $script:accOps = @() })
            [void]$row.Children.Add($ok)
            [void]$row.Children.Add($no)
            [void]$sp.Children.Add($row)

            $b.Child = $sp
            [void]$script:chatStack.Children.Add($b)
            $script:chatScroll.ScrollToEnd()
        } catch { Log "action card: $($_.Exception.Message)" }
    }

    function Invoke-ActionCard {
        if (-not $script:accOps -or @($script:accOps).Count -eq 0) { return }
        $ops = $script:accOps
        $script:accOps = @()
        $script:statusText.Text = '正在执行…'
        Invoke-BridgeAsync -Path '/proposals' -Method 'POST' -Body @{
            kind = 'nlq'; title = '来自对话的操作'; summary = $script:accSummary; ops = $ops
        } -OnDone {
            param($json, $err)
            if ($err) { Add-Chat 'ai' "没法执行：$err" $COL.Bad; return }
            $script:accPid = [string](Get-Field $json 'id' '')
            Invoke-BridgeAsync -Path "/proposals/$($script:accPid)/accept" -Method 'POST' -Body @{} -OnDone {
                param($j2, $e2)
                if ($e2) { Add-Chat 'ai' "执行失败：$e2" $COL.Bad; return }
                $n = @(Get-Field $j2 'applied' @()).Count
                $sk = @(Get-Field $j2 'skipped' @()).Count
                $msg = "已执行 $n 项"
                if ($sk -gt 0) { $msg += "，跳过 $sk 项（已锁定）" }
                Add-Chat 'ai' $msg $COL.Ok
                $script:statusText.Text = $msg
                Refresh-All
            }
        }
    }

    function Send-ChatMessage {
        $text = $script:chatInput.Text.Trim()
        if (-not $text) { return }
        $script:chatInput.Text = ''
        Log "chat send: $text"
        Add-Chat 'me' $text
        if (-not (Get-BridgeBase)) { Add-Chat 'ai' '本地服务没连上，先看看已有计划吧。' $COL.Warn; return }

        # 1) 「全部删除 / 清空」直接走结构化确认，不让模型绕圈子
        if ($text -match '(全部|所有|全都|统统).{0,4}(删|清空|清掉)|清空|删光') {
            $targets = @($script:items | Where-Object { [string](Get-Field $_ 'status' '') -notin @('done', 'cancelled') })
            if ($targets.Count -eq 0) { Add-Chat 'ai' '现在没有可删的计划。' $COL.Sub; return }
            $ops = @($targets | ForEach-Object { @{ op = 'delete'; id = [string](Get-Field $_ 'id' '') } })
            Show-ActionCard "准备删除全部 $($targets.Count) 项，确认？" $ops
            return
        }

        # 2) 先做确定性解析：能变成操作就出卡片，含糊就让她反问
        $script:chatSeq++
        $script:chatText = $text
        $script:chatSeqAtSend = $script:chatSeq
        Invoke-BridgeAsync -Path '/ai/parse' -Method 'POST' -Body @{ text = $text } -OnDone {
            param($json, $err)
            Log "parse: err=$err"
            if ($script:chatSeq -ne $script:chatSeqAtSend) { return }
            if (-not $err) {
                $ops = @(Get-Field $json 'ops' @())
                $qs = @(Get-Field $json 'questions' @())
                $intent = [string](Get-Field $json 'intent' '')
                Log "parse: intent=$intent ops=$($ops.Count) qs=$($qs.Count) text=$($script:chatText)"
                if ($ops.Count -gt 0) {
                    Show-ActionCard '我理解你要这样改，确认一下？' $ops
                    return
                }

                # 解析不出可执行操作时，按意图分流，绝不"只回两句反问"就结束
                $looksLikeAdd = ($script:chatText -match '(加|记|写|做|提醒|安排|准备|新建|创建|存)')
                if ($intent -in @('create', 'update', 'delete')) {
                    if ($qs.Count -gt 0) { Add-Chat 'ai' ([string]$qs[0]) $COL.Sub }
                    if ($intent -eq 'create' -or ($looksLikeAdd -and $intent -ne 'delete')) {
                        # 兜底：先记成「待安排」，点一下就能存，之后再排时间
                        $title = $script:chatText -replace '^(帮我|请|麻烦)?\s*(帮我)?(加一个?|新建|创建|添加|记一下|记下|加)\s*', ''
                        $title = $title -replace '^(一个|一条|个|条)?\s*(任务|计划|事情|事)[:：,，]?\s*', ''
                        $title = $title.Trim()
                        if ($title.Length -gt 60) { $title = $title.Substring(0, 60) }
                        if (-not $title) { $title = $script:chatText }
                        Show-ActionCard "没完全听懂时间。要我先记成「待安排」计划吗？（之后可以再排时间）" @(
                            @{ op = 'create'; item = @{ kind = 'task'; title = $title; precision = 'unscheduled'; source = 'ai' } }
                        )
                    }
                    return
                }

                # query / 闲聊：交给模型正常对话
            }
            # 3) 普通聊天才交给模型
            Invoke-BridgeAsync -Path '/ai/chat' -Method 'POST' -Body @{ text = $script:chatText; context = 'planner' } -OnDone {
                param($j, $e)
                if ($e) { Log "chat reply err: $e"; Add-Chat 'ai' "出错了：$e" $COL.Bad; return }
                $reply = [string](Get-Field $j 'reply' '……')
                Log "chat reply: $($reply.Substring(0, [Math]::Min(30, $reply.Length)))"
                Add-Chat 'ai' $reply
            }
        }
    }

    # 建完/改完把视图挪到它的日期，否则"建了却看不见"
    function Set-Notice([string]$text, [string]$color = '') {
        $script:notice = $text
        $script:noticeUntil = [Environment]::TickCount + 8000
        $script:statusText.Text = $text
        $script:statusText.Foreground = Brush $(if ($color) { $color } else { $COL.Ok })
    }

    function Jump-ToItemDate($item) {
        try {
            $d = [string](Get-Field $item 'startDate' '')
            if (-not $d) {
                $script:statusText.Text += '（没有日期，在左下「待安排计划池」里）'
                return
            }
            $dt = [datetime]::ParseExact($d, 'yyyy-MM-dd', $null)
            $today = (Get-Date).Date
            $past = ($dt -lt $today)
            $script:mode = 'week'
            $script:viewDays = 7
            $script:viewStart = $dt.AddDays(-1)
            Render-Timeline
            try { $script:timelineScroll.ScrollToHorizontalOffset([Math]::Max(0, $script:dayW * 0.6)) } catch { }
            if ($past) { Set-Notice "已建在 $d —— 这是过去的日期，所以我跳到那天给你看" $COL.Warn }
        } catch { Log "jump failed: $($_.Exception.Message)" }
    }

    # ---------------- 新建/编辑对话框 ----------------
    function Open-ItemDialog($it = $null, [switch]$Preview) {
        try {
            $isNew = ($null -eq $it)
            $script:editItem = $it
            $d = New-Object System.Windows.Window
            $d.Title = if ($isNew) { '新建计划' } else { '编辑计划' }
            $d.Width = 470; $d.Height = 520
            $d.Background = Brush $COL.Panel
            $d.WindowStartupLocation = 'CenterOwner'
            $d.Owner = $script:win
            $d.FontFamily = [System.Windows.Media.FontFamily]::new('Microsoft YaHei UI')
            $script:editDlg = $d

            $g = New-Object System.Windows.Controls.Grid
            $g.Margin = [System.Windows.Thickness]::new(16)
            for ($i = 0; $i -lt 9; $i++) { $g.RowDefinitions.Add((New-Object System.Windows.Controls.RowDefinition)) }
            $g.ColumnDefinitions.Add((New-Object System.Windows.Controls.ColumnDefinition))
            $g.ColumnDefinitions.Add((New-Object System.Windows.Controls.ColumnDefinition))
            $g.ColumnDefinitions[1].Width = [System.Windows.GridLength]::new(300)

            function Add-Row($label, $ctrl, $row) {
                $lb = New-Object System.Windows.Controls.TextBlock
                $lb.Text = $label
                $lb.Foreground = Brush $COL.Sub
                $lb.VerticalAlignment = 'Center'
                $lb.Margin = [System.Windows.Thickness]::new(0, 4, 8, 4)
                [System.Windows.Controls.Grid]::SetRow($lb, $row)
                [System.Windows.Controls.Grid]::SetColumn($lb, 0)
                [void]$g.Children.Add($lb)
                [System.Windows.Controls.Grid]::SetRow($ctrl, $row)
                [System.Windows.Controls.Grid]::SetColumn($ctrl, 1)
                [void]$g.Children.Add($ctrl)
            }

            $script:eTitle = New-Object System.Windows.Controls.TextBox
            $script:eTitle.Height = 28
            $script:eTitle.Text = [string](Get-Field $it 'title' '')
            Add-Row '标题' $script:eTitle 0

            $script:eKind = New-Object System.Windows.Controls.ComboBox
            $script:eKind.Height = 26
            foreach ($k in $script:KindLabels.Keys) { [void]$script:eKind.Items.Add([string]$script:KindLabels[$k]) }
            $kindLabel = Get-Label $script:KindLabels ([string](Get-Field $it 'kind' 'task'))
            $script:eKind.SelectedItem = $kindLabel
            if ($null -eq $script:eKind.SelectedItem) { $script:eKind.SelectedIndex = 0 }
            Add-Row '类型' $script:eKind 1

            $script:ePrecision = New-Object System.Windows.Controls.ComboBox
            $script:ePrecision.Height = 26
            foreach ($k in $script:PrecLabels.Keys) { [void]$script:ePrecision.Items.Add([string]$script:PrecLabels[$k]) }
            $precLabel = Get-Label $script:PrecLabels ([string](Get-Field $it 'precision' 'unscheduled'))
            $script:ePrecision.SelectedItem = $precLabel
            if ($null -eq $script:ePrecision.SelectedItem) { $script:ePrecision.SelectedIndex = 0 }
            Add-Row '时间精度' $script:ePrecision 2

            $script:eStart = New-Object System.Windows.Controls.TextBox
            $script:eStart.Text = [string](Get-Field $it 'startDate' '')
            $script:eStart.ToolTip = 'YYYY-MM-DD；年/季/月计划填区间起点'
            Add-Row '开始日期' $script:eStart 3

            $script:eEnd = New-Object System.Windows.Controls.TextBox
            $script:eEnd.Text = [string](Get-Field $it 'endDate' '')
            $script:eEnd.ToolTip = '区间终点；slot 精度可留空'
            Add-Row '结束日期' $script:eEnd 4

            $script:eTime = New-Object System.Windows.Controls.TextBox
            $script:eTime.Text = "$(Get-Field $it 'startTime' '')"
            $script:eTime.ToolTip = 'HH:mm（仅 slot 精度需要）'
            Add-Row '开始时刻' $script:eTime 5

            $script:eTimeEnd = New-Object System.Windows.Controls.TextBox
            $script:eTimeEnd.Text = "$(Get-Field $it 'endTime' '')"
            Add-Row '结束时刻' $script:eTimeEnd 6

            $script:ePrio = New-Object System.Windows.Controls.ComboBox
            foreach ($k in 0..4) { [void]$script:ePrio.Items.Add($k) }
            $script:ePrio.SelectedItem = [int](Get-Field $it 'priority' 2)
            Add-Row '优先级 0-4' $script:ePrio 7

            # 上级（可选）：只能挂到 goal / project / phase / milestone 下面
            $g.RowDefinitions.Add((New-Object System.Windows.Controls.RowDefinition))
            $script:eParent = New-Object System.Windows.Controls.ComboBox
            $script:eParent.Height = 26
            $script:parentMap = @{ '（无）' = $null }
            [void]$script:eParent.Items.Add('（无）')
            $selfId = [string](Get-Field $it 'id' '')
            foreach ($cand in $script:items) {
                $ck = [string](Get-Field $cand 'kind' 'task')
                if ($ck -eq 'task') { continue }
                $cid = [string](Get-Field $cand 'id' '')
                if ($cid -and $cid -eq $selfId) { continue }
                $label = "$([string](Get-Field $cand 'title' ''))  [$ck]"
                [void]$script:eParent.Items.Add($label)
                $script:parentMap[$label] = $cid
            }
            $curParent = [string](Get-Field $it 'parentId' '')
            $curLabel = '（无）'
            if ($curParent) {
                foreach ($k in $script:parentMap.Keys) { if ($script:parentMap[$k] -eq $curParent) { $curLabel = $k } }
            }
            $script:eParent.SelectedItem = $curLabel
            if ($null -eq $script:eParent.SelectedItem) { $script:eParent.SelectedIndex = 0 }
            Add-Row '上级（可选）' $script:eParent 8

            $script:eLock = New-Object System.Windows.Controls.CheckBox
            $script:eLock.Content = '锁定（AI 不得自动修改）'
            $script:eLock.Foreground = Brush $COL.Text
            $script:eLock.IsChecked = [bool](Get-Field $it 'locked' $false)
            [System.Windows.Controls.Grid]::SetRow($script:eLock, 9)
            [System.Windows.Controls.Grid]::SetColumn($script:eLock, 1)
            [void]$g.Children.Add($script:eLock)

            $btnRow = New-Object System.Windows.Controls.StackPanel
            $btnRow.Orientation = 'Horizontal'
            $btnRow.HorizontalAlignment = 'Right'
            $btnRow.Margin = [System.Windows.Thickness]::new(0, 14, 0, 0)
            $save = New-Object System.Windows.Controls.Button
            $save.Content = '保存'; $save.Width = 88; $save.Height = 30
            $save.Style = $script:win.Resources['TBtnAccent']
            $save.Add_Click({ Save-ItemDialog })
            $cancel = New-Object System.Windows.Controls.Button
            $cancel.Content = '取消'; $cancel.Width = 88; $cancel.Height = 30; $cancel.Margin = [System.Windows.Thickness]::new(8, 0, 0, 0)
            $cancel.Style = $script:win.Resources['TBtn']
            $cancel.Add_Click({ $script:editDlg.Close() })
            [void]$btnRow.Children.Add($save)
            [void]$btnRow.Children.Add($cancel)

            $rootGrid2 = New-Object System.Windows.Controls.Grid
            $rootGrid2.RowDefinitions.Add((New-Object System.Windows.Controls.RowDefinition))
            $rootGrid2.RowDefinitions.Add((New-Object System.Windows.Controls.RowDefinition))
            $rootGrid2.RowDefinitions[0].Height = [System.Windows.GridLength]::new(1, 'Star')
            $rootGrid2.RowDefinitions[1].Height = [System.Windows.GridLength]::Auto
            [void]$rootGrid2.Children.Add($g)
            [System.Windows.Controls.Grid]::SetRow($btnRow, 1)
            [void]$rootGrid2.Children.Add($btnRow)
            $d.Content = $rootGrid2
            if ($Preview) { $d.Show() | Out-Null } else { $d.ShowDialog() | Out-Null }
        } catch { Log "item dialog: $($_.Exception.Message)`n$($_.ScriptStackTrace)" }
    }

    function Save-ItemDialog {
        $body = @{
            title = $script:eTitle.Text.Trim()
            kind = Get-RawValue $script:KindLabels ([string]$script:eKind.SelectedItem)
            precision = Get-RawValue $script:PrecLabels ([string]$script:ePrecision.SelectedItem)
            priority = [int]$script:ePrio.SelectedItem
            locked = [bool]$script:eLock.IsChecked
            source = 'user'
        }
        $selParent = [string]$script:eParent.SelectedItem
        if ($script:parentMap.ContainsKey($selParent)) {
            $body.parentId = $script:parentMap[$selParent]   # 可能是 $null = 移到顶层
        }
        if ($body.title.Length -eq 0) { $script:statusText.Text = '标题不能为空'; return }
        if ($script:eStart.Text.Trim()) { $body.startDate = $script:eStart.Text.Trim() }
        if ($script:eEnd.Text.Trim()) { $body.endDate = $script:eEnd.Text.Trim() }
        if ($script:eTime.Text.Trim()) { $body.startTime = $script:eTime.Text.Trim() }
        if ($script:eTimeEnd.Text.Trim()) { $body.endTime = $script:eTimeEnd.Text.Trim() }
        $id = if ($script:editItem) { [string](Get-Field $script:editItem 'id' '') } else { '' }
        $script:editDlg.Close()
        if ($id) {
            Invoke-BridgeAsync -Path "/items/$id" -Method 'PATCH' -Body $body -OnDone {
                param($json, $err)
                if ($err) { $script:statusText.Text = "保存失败：$err"; $script:statusText.Foreground = Brush $COL.Bad; return }
                $script:statusText.Text = '已保存'
                Jump-ToItemDate $json
                Refresh-All
            }
        } else {
            Invoke-BridgeAsync -Path '/items' -Method 'POST' -Body $body -OnDone {
                param($json, $err)
                if ($err) { $script:statusText.Text = "创建失败：$err"; $script:statusText.Foreground = Brush $COL.Bad; return }
                $script:statusText.Text = "已创建「$([string](Get-Field $json 'title' ''))」"
                Jump-ToItemDate $json
                Refresh-All
            }
        }
    }

    function Invoke-AiPlan {
        if (-not (Get-BridgeBase)) { $script:statusText.Text = '服务未连接'; return }
        $script:statusText.Text = '正在结合长期目标生成未来五天建议…'
        Invoke-BridgeAsync -Path '/ai/plan' -Method 'POST' -Body @{ days = 5 } -OnDone {
            param($json, $err)
            if ($err) { $script:statusText.Text = "AI 规划失败：$err"; return }
            $p = Get-Field $json 'proposal' $null
            if (-not $p) { $p = $json }
            $pid2 = [string](Get-Field $p 'id' '')
            $script:statusText.Text = '已生成建议，右侧确认后才会写入计划。'
            Refresh-All
        }
    }

    # ---------------- 事件绑定 ----------------
    $win.FindName('BtnToday').Add_Click({ Set-Mode $script:mode })
    $win.FindName('BtnPrev').Add_Click({ Shift-View -1 })
    $win.FindName('BtnNext').Add_Click({ Shift-View 1 })
    $win.FindName('BtnZoomOut').Add_Click({ Zoom-Timeline 1.5 })
    $win.FindName('BtnZoomIn').Add_Click({ Zoom-Timeline 0.66 })
    $win.FindName('BtnYear').Add_Click({ Set-Mode 'year' })
    $win.FindName('BtnQuarter').Add_Click({ Set-Mode 'quarter' })
    $win.FindName('BtnMonth').Add_Click({ Set-Mode 'month' })
    $win.FindName('BtnWeek').Add_Click({ Set-Mode 'week' })
    $win.FindName('BtnDay').Add_Click({ Set-Mode 'day' })
    $win.FindName('BtnGantt').Add_Click({ Set-Mode 'gantt' })
    $win.FindName('BtnNewItem').Add_Click({ Open-ItemDialog $null })
    $win.FindName('BtnPlan5').Add_Click({ Invoke-AiPlan })
    $win.FindName('BtnSearch').Add_Click({
            $q = $script:searchBox.Text.Trim()
            if (-not $q) { Refresh-All; return }
            Invoke-BridgeAsync -Path "/items?q=$([uri]::EscapeDataString($q))&limit=200" -OnDone {
                param($json, $err)
                if ($err) { return }
                $script:items = @(AsArray $json 'items')
                Rebuild-LeftPanel; Render-Timeline
                $script:statusText.Text = "搜索「$q」：$($script:items.Count) 项"
            }
        })
    $script:searchBox = $win.FindName('SearchBox')
    $win.FindName('ChatSend').Add_Click({ Send-ChatMessage })
    $win.FindName('ChatInput').Add_KeyDown({
            param($s, $e)
            if ($e.Key -eq [System.Windows.Input.Key]::Enter) { Send-ChatMessage; $e.Handled = $true }
        })

    $timelineScroll.Add_ScrollChanged({
            param($s, $e)
            try { $script:headerScroll.ScrollToHorizontalOffset($e.HorizontalOffset) } catch { }
        })

    # 鼠标滚轮 + Ctrl 缩放
    $timelineScroll.Add_PreviewMouseWheel({
            param($s, $e)
            if ([System.Windows.Input.Keyboard]::Modifiers -band [System.Windows.Input.ModifierKeys]::Control) {
                Zoom-Timeline $(if ($e.Delta -gt 0) { 0.75 } else { 1.33 })
                $e.Handled = $true
            }
        })

    $win.Add_Loaded({
            try {
                try { "$PID" | Out-File -FilePath (Join-Path $dataDir 'planner.pid') -Encoding ascii -NoNewline } catch { }
        Set-Mode 'week'
                Add-Chat 'ai' '我把长期目标、近期安排和冲突都读进来了。想改哪块？'
                Refresh-All
            } catch { Log "loaded: $($_.Exception.Message)" }
        })

    # 桥轮询
    $bridgeTimer = New-Object System.Windows.Threading.DispatcherTimer
    $bridgeTimer.Interval = [TimeSpan]::FromMilliseconds(120)
    $bridgeTimer.Add_Tick({ Update-Bridge })
    $bridgeTimer.Start()

    $refreshTimer = New-Object System.Windows.Threading.DispatcherTimer
    $refreshTimer.Interval = [TimeSpan]::FromSeconds(3)
    $refreshTimer.Add_Tick({
            try { if (Sync-Bridge $dataDir) { Log "bridge reconnected: $(Get-BridgeBase)" } } catch { }
            Refresh-Items
        })
    $refreshTimer.Start()

    $analysisTimer = New-Object System.Windows.Threading.DispatcherTimer
    $analysisTimer.Interval = [TimeSpan]::FromSeconds(15)
    $analysisTimer.Add_Tick({ Refresh-Analysis })
    $analysisTimer.Start()

    # ---- 调试截图钩子：从视觉树渲染，不受遮挡影响 ----
    $script:shotTimer = New-Object System.Windows.Threading.DispatcherTimer
    $script:shotTimer.Interval = [TimeSpan]::FromMilliseconds(800)
    $script:shotTimer.Add_Tick({
            try {
                $flag = Join-Path $dataDir 'capture-planner.flag'
                if (-not (Test-Path $flag)) { return }
                $cmdText = ''
                try { $cmdText = (Get-Content $flag -Raw).Trim() } catch { }
                Remove-Item $flag -ErrorAction SilentlyContinue
                if ($cmdText -like 'chattest:*') {
                    $msg = $cmdText.Substring(9)
                    $script:chatInput.Text = $msg
                    Send-ChatMessage
                    $script:chatTestTimer = New-Object System.Windows.Threading.DispatcherTimer
                    $script:chatTestTimer.Interval = [TimeSpan]::FromMilliseconds(2600)
                    $script:chatTestTimer.Add_Tick({
                            try {
                                $script:chatTestTimer.Stop()
                                Log "chattest: bubbles=$($script:chatStack.Children.Count) pendingOps=$(@($script:accOps).Count) summary=$($script:accSummary)"
                                if (@($script:accOps).Count -gt 0) { Log 'chattest: 卡片已生成，执行中…'; Invoke-ActionCard }
                            } catch { Log "chattest failed: $($_.Exception.Message)" }
                        })
                    $script:chatTestTimer.Start()
                    return
                }
                if ($cmdText -eq 'dialogsave') {
                    try {
                        $sample = [pscustomobject]@{
                            kind = 'task'; title = 'UI保存自检'; precision = 'day'
                            startDate = '2026-09-09'; endDate = '2026-09-09'
                            startTime = $null; endTime = $null; priority = 2; locked = 0; parentId = $null
                        }
                        Open-ItemDialog $sample -Preview
                        $script:saveTestTimer = New-Object System.Windows.Threading.DispatcherTimer
                        $script:saveTestTimer.Interval = [TimeSpan]::FromMilliseconds(900)
                        $script:saveTestTimer.Add_Tick({
                                try {
                                    $script:saveTestTimer.Stop()
                                    if ($script:eParent.Items.Count -gt 1) { $script:eParent.SelectedIndex = 1 }
                                    Log "dialogsave: kindLabel=$($script:eKind.SelectedItem) precLabel=$($script:ePrecision.SelectedItem) parent=$($script:eParent.SelectedItem)"
                                    Save-ItemDialog
                                    $script:jumpCheck = New-Object System.Windows.Threading.DispatcherTimer
                                    $script:jumpCheck.Interval = [TimeSpan]::FromMilliseconds(1500)
                                    $script:jumpCheck.Add_Tick({
                                            $script:jumpCheck.Stop()
                                            Log "dialogsave result: viewStart=$($script:viewStart.ToString('yyyy-MM-dd')) days=$($script:viewDays) mode=$($script:mode) status=$($script:statusText.Text)"
                                            })
                                    $script:jumpCheck.Start()
                                } catch { Log "dialogsave failed: $($_.Exception.Message)" }
                            })
                        $script:saveTestTimer.Start()
                    } catch { Log "dialogsave open failed: $($_.Exception.Message)" }
                    return
                }
                if ($cmdText -eq 'dialogshot') {
                    try {
                        $sample = [pscustomobject]@{
                            kind = 'task'; title = '论文修改（连续四天）'; precision = 'day'
                            startDate = '2026-11-09'; endDate = '2026-11-12'
                            startTime = $null; endTime = $null; priority = 3; locked = 0
                        }
                        $script:dlgShotTimer = New-Object System.Windows.Threading.DispatcherTimer
                        $script:dlgShotTimer.Interval = [TimeSpan]::FromMilliseconds(1400)
                        $script:dlgShotTimer.Add_Tick({
                                try {
                                    $script:dlgShotTimer.Stop()
                                    $dw = [int][Math]::Max(1, $script:editDlg.ActualWidth)
                                    $dh = [int][Math]::Max(1, $script:editDlg.ActualHeight)
                                    $rtb = New-Object System.Windows.Media.Imaging.RenderTargetBitmap($dw, $dh, 96, 96, [System.Windows.Media.PixelFormats]::Pbgra32)
                                    $rtb.Render($script:editDlg)
                                    $enc = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
                                    $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($rtb))
                                    $fs = [System.IO.File]::Create((Join-Path $logDir 'shot-item-dialog.png'))
                                    $enc.Save($fs); $fs.Close()
                                    Log "dialogshot saved ($dw x $dh)"
                                    $script:editDlg.Close()
                                } catch { Log "dialogshot failed: $($_.Exception.Message)" }
                            })
                        $script:dlgShotTimer.Start()
                        Open-ItemDialog $sample -Preview
                    } catch { Log "dialogshot open failed: $($_.Exception.Message)" }
                    return
                }
                if ($cmdText -eq 'deletetest') {
                    try {
                        $info = Get-Content (Join-Path $dataDir 'bridge.json') -Raw | ConvertFrom-Json
                        $hdr = @{ Authorization = "Bearer $($info.token)" }
                        $base = "http://127.0.0.1:$($info.port)"
                        $bodyJson = @{ kind = 'task'; title = '删除自检临时项'; precision = 'unscheduled'; source = 'user' } | ConvertTo-Json -Compress
                        $tmp = Invoke-RestMethod -Uri "$base/items" -Method POST -Headers $hdr -Body ([Text.Encoding]::UTF8.GetBytes($bodyJson)) -ContentType 'application/json; charset=utf-8'
                        Log "deletetest: created $($tmp.id) before=$($script:items.Count)"
                        $script:delTestId = $tmp.id
                        $script:delTestBefore = $script:items.Count
                        $script:delTestTimer = New-Object System.Windows.Threading.DispatcherTimer
                        $script:delTestTimer.Interval = [TimeSpan]::FromMilliseconds(1800)
                        $script:delTestTimer.Add_Tick({
                                try {
                                    $script:delTestTimer.Stop()
                                    $gone = @($script:items | Where-Object { $_.id -eq $script:delTestId }).Count
                                    Log "deletetest: after refresh items=$($script:items.Count) stillHasDeleted=$gone canvasKids=$($script:timelineCanvas.Children.Count)"
                                } catch { Log "deletetest check failed: $($_.Exception.Message)" }
                            })
                        $script:delTestTimer.Start()
                        $obj = [pscustomobject]@{ id = $tmp.id; title = '删除自检临时项' }
                        Delete-Item $obj
                    } catch { Log "deletetest failed: $($_.Exception.Message)" }
                    return
                }
                if ($cmdText -eq 'modes') {
                    foreach ($m in @('year', 'quarter', 'month', 'week', 'day', 'gantt')) {
                        try {
                            Set-Mode $m
                            Log "mode selftest: $m OK start=$($script:viewStart.ToString('yyyy-MM-dd')) days=$($script:viewDays) items=$($script:timelineCanvas.Children.Count)"
                        } catch { Log "mode selftest: $m FAIL $($_.Exception.Message)" }
                    }
                    Set-Mode 'week'
                    return
                }
                if ($cmdText -eq 'menu') {
                    $it = $script:items | Where-Object { [string](Get-Field $_ 'precision' '') -eq 'slot' } | Select-Object -First 1
                    if (-not $it) { $it = $script:items | Select-Object -First 1 }
                    if ($it) {
                        $m = New-ItemMenu $it
                        $first = $m.Items[0]
                        Log "menu selftest: items=$($m.Items.Count) firstType=$($first.GetType().Name) header=$($first.Header)"
                    } else { Log 'menu selftest: no items' }
                    return
                }
                if ($cmdText -eq 'dialog') {
                    $script:dlgTimer = New-Object System.Windows.Threading.DispatcherTimer
                    $script:dlgTimer.Interval = [TimeSpan]::FromMilliseconds(1500)
                    $script:dlgTimer.Add_Tick({
                            try { $script:dlgTimer.Stop(); $script:editDlg.Close(); Log 'dialog selftest: opened and closed ok' } catch { Log "dialog selftest close failed: $($_.Exception.Message)" }
                        })
                    $script:dlgTimer.Start()
                    Open-ItemDialog $null
                    return
                }
                $w = [int][Math]::Max(1, $script:win.ActualWidth)
                $h = [int][Math]::Max(1, $script:win.ActualHeight)
                $rtb = New-Object System.Windows.Media.Imaging.RenderTargetBitmap($w, $h, 96, 96, [System.Windows.Media.PixelFormats]::Pbgra32)
                $rtb.Render($script:win)
                $enc = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
                $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($rtb))
                $out = Join-Path $logDir 'shot-planner.png'
                $fs = [System.IO.File]::Create($out); $enc.Save($fs); $fs.Close()
                Log "planner capture $out ($w x $h) items=$($script:items.Count)"
            } catch { Log "planner capture failed: $($_.Exception.Message)" }
        })
    $script:shotTimer.Start()

    [System.Windows.Threading.Dispatcher]::CurrentDispatcher.add_UnhandledException({
            param($s, $e)
            Log "UNHANDLED: $($e.Exception.Message) @ $($e.Exception.StackTrace)"
            try { $script:statusText.Text = "出错了（已写日志）：$($e.Exception.Message)" } catch { }
            try { $e.Handled = $true } catch { }
        })

    $win.Add_Closing({
            param($s, $e)
            Log "window closing: reason=$($e.CloseReason)"
        })
    $win.Add_Closed({ Log 'window closed' })

    Log 'showing window'
    $win.ShowDialog() | Out-Null
    Log '=== planner exit ==='
}
catch {
    Log "FATAL: $($_.Exception.Message)`n$($_.ScriptStackTrace)"
    throw
}
