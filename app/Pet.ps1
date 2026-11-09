#requires -Version 5.1
<#
  AI Personal Secretary · 桌宠客户端（WPF 叠加层）
  - 分层伪 Live2D 角色（呼吸/摇摆/点头/眨眼/表情/特效）
  - 与本地规划服务（127.0.0.1 随机端口 + token）通信
  - 开机登录邀请、任务提醒、喝水/休息提醒、专注模式
  - 服务不可用时降级：角色照常显示，读本地缓存，明确提示 AI 不可用

  注意：PowerShell 事件回调不会捕获函数局部变量，凡回调里要用的东西一律放 $script:。
#>
param(
    [string]$Root = 'D:\AI-Secretary',
    [double]$Height = 0,
    [string]$SessionId = ''
)

$ErrorActionPreference = 'Stop'
$appDir = Join-Path $Root 'app'
$dataDir = Join-Path $Root 'data'
$logDir = Join-Path $Root 'logs'
foreach ($d in @($dataDir, $logDir)) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null } }
$logFile = Join-Path $logDir 'pet.log'

function Log([string]$msg) {
    try { "$([DateTime]::Now.ToString('HH:mm:ss'))  $msg" | Out-File -FilePath $logFile -Append -Encoding utf8 } catch { }
}

function Get-Field($o, [string]$n, $d = $null) {
    if ($null -eq $o) { return $d }
    $p = $o.PSObject.Properties[$n]
    if ($null -eq $p -or $null -eq $p.Value) { return $d }
    return $p.Value
}

try {
    Log '=== pet start ==='

    # 单实例：已经有桌宠在跑就直接退出，避免两个进程抢同一份提醒队列
    $script:ownPidFile = Join-Path $dataDir 'pet.pid'
    if (Test-Path $script:ownPidFile) {
        $otherPid = 0
        try { $otherPid = [int](Get-Content $script:ownPidFile -Raw).Trim() } catch { }
        if ($otherPid -gt 0 -and $otherPid -ne $PID) {
            if (Get-Process -Id $otherPid -ErrorAction SilentlyContinue) {
                Log "另一只桌宠已在运行 (pid $otherPid)，本进程退出"
                return
            }
        }
    }
    try { "$PID" | Out-File -FilePath $script:ownPidFile -Encoding ascii -NoNewline } catch { }
    Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms, System.Drawing
    try {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PetNative {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
}
'@ -ErrorAction Stop
        try { [PetNative]::SetProcessDpiAwareness(2) | Out-Null } catch { [PetNative]::SetProcessDPIAware() | Out-Null }
    } catch { Log "dpi: $($_.Exception.Message)" }

    . (Join-Path $appDir 'lib\Theme.ps1')
    . (Join-Path $appDir 'lib\Bridge.ps1')
    . (Join-Path $appDir 'lib\Rig.ps1')
    Set-StrictMode -Off
    $script:DataDir = $dataDir

    # ================= 设置 =================
    $settingsPath = Join-Path $dataDir 'pet-settings.json'
    $script:cfg = @{
        height = 180; left = $null; top = $null; topmost = $true; muted = $false
        theme = 'system'; dndManual = $false; notifySystem = $true; autoStart = $false
        bootGreeting = $true; lastGreetedSession = ''
    }
    if (Test-Path $settingsPath) {
        try {
            $saved = Get-Content $settingsPath -Raw -Encoding utf8 | ConvertFrom-Json
            foreach ($k in @($script:cfg.Keys)) {
                $v = Get-Field $saved $k $null
                if ($null -ne $v) { $script:cfg[$k] = $v }
            }
        } catch { Log "settings load failed: $($_.Exception.Message)" }
    }
    if ($Height -gt 0) { $script:cfg.height = $Height }
    if ($script:cfg.height -lt 60) { $script:cfg.height = 180 }
    if ($script:cfg.height -gt 520) { $script:cfg.height = 400 }
    $script:theme = Get-Theme $script:cfg.theme

    function Get-BootTime {
        # [Environment]::TickCount64 在本机返回空，逐级兜底
        try {
            $ticks = [Environment]::TickCount64
            if ($ticks -and [double]$ticks -gt 60000) { return (Get-Date).AddMilliseconds(-[double]$ticks) }
        } catch { }
        try {
            $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
            if ($os.LastBootUpTime) { return [DateTime]$os.LastBootUpTime }
        } catch { }
        try {
            $p = Get-Process explorer -ErrorAction Stop | Sort-Object StartTime | Select-Object -First 1
            if ($p -and $p.StartTime) { return [DateTime]$p.StartTime }
        } catch { }
        return (Get-Date).Date
    }

    function Get-SessionId {
        $boot = Get-BootTime
        return 's' + $boot.ToString('yyyyMMddHHmm') + '-' + $env:USERNAME
    }

    function Save-Settings {
        try { ($script:cfg | ConvertTo-Json -Depth 6) | Out-File -FilePath $settingsPath -Encoding utf8 } catch { }
    }

    # ================= 服务桥 =================
    $script:bridgeOk = Initialize-Bridge $dataDir
    Log "bridge=$($script:bridgeOk) base=$(Get-BridgeBase)"

    # ================= 角色 =================
    $script:rig = Load-Rig (Join-Path $Root 'assets\character')
    $script:visual = New-RigVisual -Rig $script:rig -Height ([double]$script:cfg.height)
    $script:charW = $script:visual.Stage.Width
    $script:charH = $script:visual.Stage.Height
    Log "rig $($script:charW)x$($script:charH)"

    # ================= 窗口 =================
    $xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="AI Secretary" WindowStartupLocation="Manual"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ShowInTaskbar="False" ResizeMode="NoResize" ShowActivated="False" Opacity="0"
        FontFamily="Microsoft YaHei UI" FontSize="12">
  <Window.Resources>
    <Style x:Key="FlatBtn" TargetType="Button">
      <Setter Property="Background" Value="#EEF3FB"/>
      <Setter Property="Foreground" Value="#2A3A52"/>
      <Setter Property="BorderThickness" Value="0"/>
      <Setter Property="Padding" Value="10,5"/>
      <Setter Property="Margin" Value="3"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="bd" Background="{TemplateBinding Background}" CornerRadius="9" Padding="{TemplateBinding Padding}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="bd" Property="Opacity" Value="0.82"/></Trigger>
              <Trigger Property="IsPressed" Value="True"><Setter TargetName="bd" Property="Opacity" Value="0.65"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>

  <Grid x:Name="RootGrid" Background="{x:Null}">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="*"/>
    </Grid.RowDefinitions>

    <StackPanel x:Name="PanelHost" Grid.Row="0" VerticalAlignment="Bottom" HorizontalAlignment="Center" Margin="0,0,0,2">

      <Border x:Name="Bubble" Visibility="Collapsed" MaxWidth="288" Padding="12,8" CornerRadius="12"
              Background="#FAFFFFFF" BorderBrush="#336FA8FF" BorderThickness="1">
        <Border.Effect><DropShadowEffect BlurRadius="12" ShadowDepth="2" Opacity="0.18"/></Border.Effect>
        <TextBlock x:Name="BubbleText" Text="" TextWrapping="Wrap" Foreground="#1F2A3C" LineHeight="19"/>
      </Border>

      <Border x:Name="ChatPanel" Visibility="Collapsed" Width="288" Margin="0,6,0,0" Padding="10,8" CornerRadius="12"
              Background="#FAFFFFFF" BorderBrush="#336FA8FF" BorderThickness="1">
        <Border.Effect><DropShadowEffect BlurRadius="14" ShadowDepth="2" Opacity="0.20"/></Border.Effect>
        <StackPanel>
          <ScrollViewer x:Name="ChatScroll" MaxHeight="240" VerticalScrollBarVisibility="Auto"
                        HorizontalScrollBarVisibility="Disabled">
            <StackPanel x:Name="ChatStack"/>
          </ScrollViewer>
          <Grid Margin="0,6,0,0">
            <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
            <TextBox x:Name="ChatInput" Grid.Column="0" Height="26" BorderThickness="1" BorderBrush="#3A6FA8FF"
                     Background="#FFFFFFFF" VerticalContentAlignment="Center" MaxLength="300" Padding="6,0"/>
            <Button x:Name="ChatSend" Grid.Column="1" Content="发送" Width="52" Height="26" Margin="6,0,0,0"
                    Style="{StaticResource FlatBtn}" Background="#4C86E8" Foreground="#FFFFFF"/>
          </Grid>
        </StackPanel>
      </Border>

      <Border x:Name="MenuPanel" Visibility="Collapsed" Margin="0,6,0,0" Padding="4" CornerRadius="12"
              Background="#FAFFFFFF" BorderBrush="#336FA8FF" BorderThickness="1">
        <Border.Effect><DropShadowEffect BlurRadius="14" ShadowDepth="2" Opacity="0.20"/></Border.Effect>
        <UniformGrid x:Name="MenuGrid" Columns="2"/>
      </Border>

      <Border x:Name="ReminderPanel" Visibility="Collapsed" Width="288" Margin="0,6,0,0" Padding="12,10" CornerRadius="12"
              Background="#F21E2436" BorderBrush="#3A6FA8FF" BorderThickness="1">
        <Border.Effect><DropShadowEffect BlurRadius="16" ShadowDepth="3" Opacity="0.32"/></Border.Effect>
        <StackPanel>
          <TextBlock x:Name="ReminderTitle" Text="提醒" FontWeight="SemiBold" Foreground="#E8EDF7" FontSize="13"/>
          <TextBlock x:Name="ReminderBody" Text="" TextWrapping="Wrap" Foreground="#C9D4E6" Margin="0,4,0,8" LineHeight="18"/>
          <WrapPanel x:Name="ReminderActions"/>
        </StackPanel>
      </Border>

      <Border x:Name="BootPanel" Visibility="Collapsed" Width="288" Margin="0,6,0,0" Padding="12,10" CornerRadius="12"
              Background="#F7FFFFFF" BorderBrush="#336FA8FF" BorderThickness="1">
        <Border.Effect><DropShadowEffect BlurRadius="16" ShadowDepth="3" Opacity="0.24"/></Border.Effect>
        <StackPanel>
          <TextBlock x:Name="BootTitle" Text="早上好" FontWeight="SemiBold" Foreground="#1F2A3C" FontSize="13" TextWrapping="Wrap"/>
          <TextBlock x:Name="BootText" Text="" TextWrapping="Wrap" Foreground="#5E6E85" Margin="0,4,0,8" LineHeight="18"/>
          <WrapPanel x:Name="BootActions"/>
        </StackPanel>
      </Border>
    </StackPanel>

    <Canvas x:Name="StageHost" Grid.Row="1" HorizontalAlignment="Center" VerticalAlignment="Bottom"/>
  </Grid>
</Window>
"@

    $win = [System.Windows.Markup.XamlReader]::Parse($xaml)
    $win.Topmost = [bool]$script:cfg.topmost
    $rootGrid = $win.FindName('RootGrid')
    $panelHost = $win.FindName('PanelHost')
    $bubble = $win.FindName('Bubble')
    $bubbleText = $win.FindName('BubbleText')
    $chatPanel = $win.FindName('ChatPanel')
    $chatInput = $win.FindName('ChatInput')
    $chatSend = $win.FindName('ChatSend')
    $chatScroll = $win.FindName('ChatScroll')
    $script:chatInputBox = $chatInput
    $chatStack = $win.FindName('ChatStack')
    $menuPanel = $win.FindName('MenuPanel')
    $menuGrid = $win.FindName('MenuGrid')
    $reminderPanel = $win.FindName('ReminderPanel')
    $reminderTitle = $win.FindName('ReminderTitle')
    $reminderBody = $win.FindName('ReminderBody')
    $reminderActions = $win.FindName('ReminderActions')
    $bootPanel = $win.FindName('BootPanel')
    $bootTitle = $win.FindName('BootTitle')
    $bootText = $win.FindName('BootText')
    $bootActions = $win.FindName('BootActions')
    $stageHost = $win.FindName('StageHost')
    [void]$stageHost.Children.Add($script:visual.Stage)
    $stageHost.Width = $script:charW
    $stageHost.Height = $script:charH

    $win.Width = [Math]::Max($script:charW + 24, 300)
    $win.Height = $script:charH + 8

    $script:dpi = 1.0
    try { $script:dpi = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero).DpiX / 96.0 } catch { $script:dpi = 1.0 }
    if ($script:dpi -le 0) { $script:dpi = 1.0 }

    $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $waL = $wa.Left / $script:dpi; $waT = $wa.Top / $script:dpi
    $waR = $wa.Right / $script:dpi; $waB = $wa.Bottom / $script:dpi
    if ($null -ne $script:cfg.left -and $null -ne $script:cfg.top) {
        $win.Left = [double]$script:cfg.left; $win.Top = [double]$script:cfg.top
    } else {
        $win.Left = $waR - $win.Width - 32; $win.Top = $waB - $win.Height - 8
    }
    $win.Left = [Math]::Min([Math]::Max($win.Left, $waL), $waR - $win.Width)
    $win.Top = [Math]::Min([Math]::Max($win.Top, $waT), $waB - $win.Height)
    $script:anchorBottom = $win.Top + $win.Height
    $win.Show()
    $win.Opacity = 1.0
    Log "window $([math]::Round($win.Left)),$([math]::Round($win.Top)) $($win.Width)x$($win.Height) dpi=$([math]::Round($script:dpi,2))"

    function Save-Position {
        try {
            $script:cfg.left = [Math]::Round($win.Left, 1)
            $script:cfg.top = [Math]::Round($win.Top, 1)
            Save-Settings
        } catch { }
    }

    # ================= 状态机 =================
    $script:stateDef = @{
        IDLE      = @{ head = 'idle'; fx = @(); breath = 1.0; sway = 1.0; bob = 1.0; tilt = 0.0; fps = 12 }
        GREETING  = @{ head = 'happy'; fx = @('sparkle'); breath = 1.5; sway = 1.7; bob = 2.1; tilt = 0.0; fps = 30 }
        THINKING  = @{ head = 'idle'; fx = @('think'); breath = 0.75; sway = 0.35; bob = 0.6; tilt = -2.6; fps = 24 }
        TALKING   = @{ head = 'talk'; fx = @(); breath = 1.25; sway = 1.0; bob = 1.5; tilt = 0.0; fps = 30 }
        PLANNING  = @{ head = 'idle'; fx = @('think'); breath = 0.9; sway = 0.6; bob = 0.8; tilt = -1.6; fps = 18 }
        REMINDING = @{ head = 'talk'; fx = @('exclaim'); breath = 1.6; sway = 2.0; bob = 2.6; tilt = 0.0; fps = 30 }
        HAPPY     = @{ head = 'happy'; fx = @('sparkle'); breath = 1.5; sway = 1.8; bob = 2.2; tilt = 0.0; fps = 30 }
        FOCUS     = @{ head = 'idle'; fx = @(); breath = 0.45; sway = 0.22; bob = 0.35; tilt = 0.0; fps = 10 }
        SLEEPING  = @{ head = 'blink'; fx = @('zzz'); breath = 0.3; sway = 0.12; bob = 0.25; tilt = 1.4; fps = 8 }
        ERROR     = @{ head = 'talk'; fx = @('sweat'); breath = 0.85; sway = 0.45; bob = 0.7; tilt = -1.0; fps = 12 }
    }

    $script:state = 'IDLE'
    $script:stateUntil = 0
    $script:lastAnim = 0
    $script:clock = [Diagnostics.Stopwatch]::StartNew()
    $script:blinking = $false
    $script:blinkAt = [Environment]::TickCount + 3200
    $script:blinkCloseUntil = 0
    $script:focusUntil = [DateTime]::MinValue
    $script:panel = 'none'
    $script:pendingReminders = @()
    $script:currentReminder = $null
    $script:bubbleHideAt = 0
    $script:chatReqId = 0
    $script:serviceSettings = $null
    $script:fullscreenActive = $false
    $script:bootSid = ''
    $script:quitting = $false

    $script:animTimer = New-Object System.Windows.Threading.DispatcherTimer
    $script:animInterval = 80
    $script:animTimer.Interval = [TimeSpan]::FromMilliseconds($script:animInterval)
    $script:animTimer.Add_Tick({ Update-Animation })

    function Set-AnimationRate([int]$fps) {
        if ($fps -le 0) { $fps = [int]$script:stateDef[$script:state].fps }
        $ms = [int](1000 / [Math]::Max(4, $fps))
        if ([Math]::Abs($ms - $script:animInterval) -lt 8) { return }
        $script:animInterval = $ms
        $script:animTimer.Interval = [TimeSpan]::FromMilliseconds($ms)
    }

    function Set-State([string]$name, [int]$holdMs = 0) {
        if (-not $script:stateDef.ContainsKey($name)) { return }
        if ($script:state -eq $name) {
            if ($holdMs -gt 0) { $script:stateUntil = [Environment]::TickCount + $holdMs }
            return
        }
        $script:state = $name
        $st = $script:stateDef[$name]
        $script:stateUntil = if ($holdMs -gt 0) { [Environment]::TickCount + $holdMs } else { 0 }
        Set-RigHead $script:visual $st.head 180
        Set-RigFx $script:visual $st.fx 1.0
        Set-AnimationRate $st.fps
        Log "state -> $name ${holdMs}ms"
    }

    function Restore-Idle {
        if ($script:focusUntil -gt [DateTime]::Now) { Set-State 'FOCUS'; return }
        Set-State 'IDLE'
    }

    # ================= 面板 =================
    function Set-PanelHeight {
        try {
            $panelHost.UpdateLayout()
            $h = [Math]::Round($script:charH + $panelHost.ActualHeight + 10, 0)
            if ([Math]::Abs($win.Height - $h) -lt 0.6) { $win.Top = $script:anchorBottom - $win.Height; return }
            $win.Height = $h
            $win.Top = $script:anchorBottom - $h
        } catch { Log "panel height: $($_.Exception.Message)" }
    }

    function Hide-AllPanels {
        foreach ($p in @($bubble, $chatPanel, $menuPanel, $reminderPanel, $bootPanel)) {
            if ($p) { $p.Visibility = 'Collapsed' }
        }
        $script:panel = 'none'
        Set-PanelHeight
    }

    function Show-Panel([string]$which) {
        foreach ($p in @($bubble, $chatPanel, $menuPanel, $reminderPanel, $bootPanel)) {
            if ($p) { $p.Visibility = 'Collapsed' }
        }
        $target = switch ($which) {
            'bubble' { $bubble } 'chat' { $chatPanel } 'menu' { $menuPanel }
            'reminder' { $reminderPanel } 'boot' { $bootPanel } default { $null }
        }
        if ($target) { $target.Visibility = 'Visible' }
        $script:panel = $which
        Set-PanelHeight
        Set-AnimationRate 30
    }

    $script:typeText = ''
    $script:typeAt = 0
    $script:typeTimer = New-Object System.Windows.Threading.DispatcherTimer
    $script:typeTimer.Interval = [TimeSpan]::FromMilliseconds(34)
    $script:typeTimer.Add_Tick({
            try {
                $full = [string]$script:typeText
                if ($script:typeAt -lt $full.Length) {
                    $script:typeAt++
                    $script:bubbleTextHost.Text = $full.Substring(0, $script:typeAt)
                } else { $script:typeTimer.Stop() }
            } catch { $script:typeTimer.Stop() }
        })
    $script:bubbleTextHost = $bubbleText

    function Show-Bubble([string]$text, [int]$holdMs = 3600, [switch]$typewriter) {
        if (-not $text) { return }
        $bubbleText.Text = $text
        $script:bubbleHold = $holdMs
        if ($typewriter) {
            $script:typeText = $text
            $script:typeAt = 0
            $bubbleText.Text = ''
            Show-Panel 'bubble'
            $script:typeTimer.Start()
        } else {
            $script:typeTimer.Stop()
            Show-Panel 'bubble'
        }
        $script:bubbleHideAt = [Environment]::TickCount + $holdMs
    }

    # ================= 提醒 =================
    function Show-SystemNotification([string]$title, [string]$text) {
        if (-not $script:cfg.notifySystem) { return }
        if (-not $script:tray) { return }
        if (Test-DoNotDisturb) { Log 'notify suppressed'; return }
        try {
            $body = if ($text -and $text.Length -gt 240) { $text.Substring(0, 240) } else { $text }
            $script:tray.ShowBalloonTip(8000, $title, $body, [System.Windows.Forms.ToolTipIcon]::None)
        } catch { Log "notify failed: $($_.Exception.Message)" }
    }

    function Test-FullscreenApp {
        try {
            $fg = [PetNative]::GetForegroundWindow()
            if ($fg -eq [IntPtr]::Zero) { return $false }
            $procId = 0
            [void][PetNative]::GetWindowThreadProcessId($fg, [ref]$procId)
            if ($procId -eq $PID) { return $false }
            $r = New-Object PetNative+RECT
            if (-not [PetNative]::GetWindowRect($fg, [ref]$r)) { return $false }
            $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
            if ($w -le 0 -or $h -le 0) { return $false }
            $bounds = [System.Windows.Forms.Screen]::FromHandle($fg).Bounds
            return (($w + 2) -ge $bounds.Width -and ($h + 2) -ge $bounds.Height)
        } catch { return $false }
    }

    function Test-DoNotDisturb {
        if ($script:cfg.dndManual) { return $true }
        if ($script:fullscreenActive) { return $true }
        try {
            $d = Get-Field $script:serviceSettings 'dnd' $null
            if ($d) {
                $from = [string](Get-Field $d 'from' '')
                $to = [string](Get-Field $d 'to' '')
                if ($from -match '^\d{1,2}:\d{2}$' -and $to -match '^\d{1,2}:\d{2}$') {
                    $now = [DateTime]::Now.TimeOfDay
                    $a = [TimeSpan]::Parse($from); $b = [TimeSpan]::Parse($to)
                    if ($a -le $b) { if ($now -ge $a -and $now -lt $b) { return $true } }
                    else { if ($now -ge $a -or $now -lt $b) { return $true } }
                }
            }
        } catch { }
        return $false
    }

    function Show-Reminder($item) {
        $script:pendingReminders = @($script:pendingReminders | Where-Object { $_.id -ne $item.id })
        $script:currentReminder = $item
        $reminderTitle.Text = [string](Get-Field $item 'title' '提醒')
        $reminderBody.Text = [string](Get-Field $item 'body' '')
        $reminderActions.Children.Clear()
        $map = @{
            start = @('开始', '#4C86E8'); done = @('完成', '#2FA35C')
            snooze = @('推迟 30 分钟', '#7C8AA6'); skip = @('跳过', '#7C8AA6')
            open = @('查看计划', '#5C7099'); dismiss = @('知道了', '#7C8AA6')
        }
        $acts = @(Get-Field $item 'actions' @('dismiss'))
        if ($acts.Count -eq 0) { $acts = @('dismiss') }
        foreach ($a in $acts) {
            $def = $map[$a]
            if (-not $def) { continue }
            $btn = New-Object System.Windows.Controls.Button
            $btn.Content = $def[0]
            $btn.Style = $win.Resources['FlatBtn']
            $btn.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString($def[1])
            $btn.Foreground = [System.Windows.Media.Brushes]::White
            $btn.Tag = $a
            $btn.Add_Click({ param($s, $e) Invoke-ReminderAction ([string]$s.Tag) })
            [void]$reminderActions.Children.Add($btn)
        }
        Show-Panel 'reminder'
        Set-State 'REMINDING' 9000
        Show-SystemNotification ([string](Get-Field $item 'title' '秘书提醒')) ([string](Get-Field $item 'body' ''))
        Log "reminder: $($item.id) $([string](Get-Field $item 'kind' ''))"
    }

    function Invoke-ReminderAction([string]$action) {
        $item = $script:currentReminder
        $script:currentReminder = $null
        if ($action -eq 'open') { Hide-AllPanels; Restore-Idle; Open-PlanningCenter; return }
        if ($item -and $item.id) {
            $script:ackId = [string]$item.id
            Invoke-BridgeAsync -Path "/reminders/$($script:ackId)/ack" -Method 'POST' -Body @{ action = $action; snoozeMin = 30 } -OnDone {
                param($json, $err)
                if ($err) { Log "ack failed: $err" }
            }
        }
        Hide-AllPanels
        switch ($action) {
            'done' { Set-State 'HAPPY' 2600; Show-Bubble '做得好，记下了。' 2200 }
            'start' { Set-State 'TALKING' 1500; Show-Bubble '那就开始吧，我先不打扰你。' 2600 }
            'snooze' { Set-State 'TALKING' 1200; Show-Bubble '好，30 分钟后再叫你。' 2200 }
            default { Restore-Idle }
        }
        Show-NextReminder
    }

    function Show-NextReminder {
        if ($script:pendingReminders.Count -gt 0) { Show-Reminder $script:pendingReminders[0] }
        elseif ($script:panel -eq 'none') { Restore-Idle }
    }

    # ================= 聊天 =================
    # 去掉最后一条"……"占位气泡
    function Remove-LastPetChat {
        try {
            if ($chatStack.Children.Count -gt 0) {
                $chatStack.Children.RemoveAt($chatStack.Children.Count - 1)
                Set-PanelHeight
            }
        } catch { }
    }

    function Add-PetChat([string]$who, [string]$text, [string]$color = '') {
        try {
            if (-not $text) { return }
            $b = New-Object System.Windows.Controls.Border
            $b.CornerRadius = [System.Windows.CornerRadius]::new(9)
            $b.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString($(if ($who -eq 'me') { '#DCE9FF' } else { '#F1F4F9' }))
            $b.Padding = [System.Windows.Thickness]::new(8, 5, 8, 5)
            $b.Margin = [System.Windows.Thickness]::new(0, 0, 0, 5)
            $b.MaxWidth = 252
            $b.HorizontalAlignment = $(if ($who -eq 'me') { 'Right' } else { 'Left' })
            $t = New-Object System.Windows.Controls.TextBlock
            $t.Text = $text
            $t.TextWrapping = 'Wrap'
            $t.FontSize = 12
            $t.LineHeight = 18
            $t.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString($(if ($color) { $color } elseif ($who -eq 'me') { '#1F2A3C' } else { '#1F2A3C' }))
            $b.Child = $t
            [void]$chatStack.Children.Add($b)
            Set-PanelHeight
            try { $chatScroll.ScrollToEnd() } catch { }
        } catch { Log "add chat failed: $($_.Exception.Message)" }
    }

    function Open-Chat {
        Show-Panel 'chat'
        if (-not $script:bridgeOk) {
            Add-PetChat 'ai' 'AI 服务暂时不可用（本地规划服务没连上）。计划查看仍然可用。' '#C98A18'
            Set-PanelHeight
        }
        $chatInput.Focus() | Out-Null
        [System.Windows.Input.Keyboard]::Focus($chatInput) | Out-Null
    }

    function Send-Chat {
        $text = $chatInput.Text.Trim()
        if (-not $text) { return }
        if (-not (Get-BridgeBase)) {
            if (-not (Initialize-Bridge $dataDir)) { Show-Bubble '我连不上自己的大脑……服务没起。' 3000; return }
        }
        $chatInput.Text = ''
        Add-PetChat 'me' $text
        $script:thinkingBorder = $null
        Add-PetChat 'ai' '……'
        Set-State 'THINKING' 0
        $script:chatReqId++
        $script:chatSeq = $script:chatReqId
        Invoke-BridgeAsync -Path '/ai/chat' -Method 'POST' -Body @{ text = $text } -OnDone {
            param($json, $err)
            if ($script:chatReqId -ne $script:chatSeq) { return }
            if ($err) {
                Log "chat failed: $err"
                Remove-LastPetChat
                if ($err -like '*no-bridge*' -or $err -like '*服务未运行*' -or $err -like '*refused*' -or $err -like '*拒绝*') {
                    [void](Sync-Bridge $dataDir)
                    Add-PetChat 'ai' '我和大脑断开了（规划服务重启过），已经自动重连，你再发一次试试。' '#C98A18'
                } else {
                    Add-PetChat 'ai' "出错了：$err" '#D0454F'
                }
                Set-State 'ERROR' 2600
                return
            }
            $reply = [string](Get-Field $json 'reply' '')
            if (-not $reply) { $reply = '……我没想好怎么回答。' }
            Remove-LastPetChat
            Add-PetChat 'ai' $reply
            Set-State 'TALKING' ([Math]::Min(6000, 1200 + $reply.Length * 90))
        }
    }

    $chatSend.Add_Click({ Send-Chat })
    $chatInput.Add_KeyDown({
            param($s, $e)
            if ($e.Key -eq [System.Windows.Input.Key]::Enter) { Send-Chat; $e.Handled = $true }
            elseif ($e.Key -eq [System.Windows.Input.Key]::Escape) { $chatInput.Text = ''; Hide-AllPanels; Restore-Idle; $e.Handled = $true }
        })

    # ================= 规划中心 =================
    $script:plannerProc = $null
    function Open-PlanningCenter {
        try {
            if ($script:plannerProc -and -not $script:plannerProc.HasExited) { Log 'planner already open'; return }
            $script:plannerProc = Start-Process -FilePath 'powershell.exe' `
                -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $appDir 'PlanningCenter.ps1'), '-Root', $Root) `
                -WorkingDirectory $Root -PassThru
            Log "planner pid $($script:plannerProc.Id)"
        } catch { Log "open planner failed: $($_.Exception.Message)" }
    }

    # ================= 快捷动作 =================
    function Show-NextTask {
        Invoke-BridgeAsync -Path '/window?days=5' -OnDone {
            param($json, $err)
            if ($err) { Show-Bubble '我还看不到计划……服务没连上。' 3000; return }
            $next = $null
            $now = Get-Date
            foreach ($day in @(Get-Field $json 'days' @())) {
                foreach ($it in @(Get-Field $day 'items' @())) {
                    if ((Get-Field $it 'status' '') -eq 'done') { continue }
                    if ((Get-Field $it 'precision' '') -ne 'slot') { continue }
                    try {
                        $dt = [DateTime]::ParseExact(("{0} {1}" -f (Get-Field $it 'startDate' '1970-01-01'), (Get-Field $it 'startTime' '00:00')), 'yyyy-MM-dd HH:mm', $null)
                    } catch { continue }
                    if ($dt -ge $now -and (-not $next -or $dt -lt $next.at)) { $next = @{ at = $dt; item = $it } }
                }
            }
            if ($next) {
                $mins = [int](($next.at) - $now).TotalMinutes
                $when = if ($mins -lt 60) { "$mins 分钟后" } elseif ($mins -lt 1440) { "$([int]($mins/60)) 小时后" } else { $next.at.ToString('M月d日 HH:mm') }
                Show-Bubble ("下一件：{0}`n{1}" -f $when, (Get-Field $next.item 'title' '')) 5200
                Set-State 'TALKING' 4200
            } else {
                Show-Bubble '接下来五天里还没有排定的具体时段。要不要现在排一下？' 4200
            }
        }
    }

    function Start-Focus([int]$minutes) {
        $script:focusUntil = [DateTime]::Now.AddMinutes($minutes)
        Set-State 'FOCUS'
        Show-Bubble "专注 $minutes 分钟，我安静陪着你。" 3000
        try { $script:tray.Text = "AI 秘书 · 专注 $minutes 分钟" } catch { }
        Invoke-BridgeAsync -Path '/focus' -Method 'POST' -Body @{ active = $true; minutes = $minutes } -OnDone { param($j, $e) }
    }

    function Stop-Focus {
        $script:focusUntil = [DateTime]::MinValue
        Set-State 'IDLE'
        try { $script:tray.Text = 'AI 秘书 · 汐' } catch { }
        Invoke-BridgeAsync -Path '/focus' -Method 'POST' -Body @{ active = $false } -OnDone { param($j, $e) }
    }

    function Invoke-MenuAction([string]$action) {
        switch ($action) {
            'chat' { Hide-AllPanels; Open-Chat; return }
            'plan' { Hide-AllPanels; Restore-Idle; Open-PlanningCenter; return }
            'new' { Hide-AllPanels; Show-Bubble "直接告诉我：「明天下午两点到四点写项目方案」，我来落进计划表。" 5600; Set-State 'TALKING' 4200; return }
            'five' { Hide-AllPanels; Restore-Idle; Open-PlanningCenter; return }
            'next' { Show-NextTask; return }
            'focus' { Hide-AllPanels; Start-Focus 45; return }
        }
        Hide-AllPanels; Restore-Idle
    }

    function Build-ClickMenu {
        $menuGrid.Children.Clear()
        foreach ($it in @(@('聊天', 'chat'), @('近期计划', 'plan'), @('新建任务', 'new'),
                @('规划五天', 'five'), @('下一个任务', 'next'), @('专注模式', 'focus'))) {
            $b = New-Object System.Windows.Controls.Button
            $b.Content = $it[0]
            $b.Style = $win.Resources['FlatBtn']
            $b.MinWidth = 128
            $b.Tag = $it[1]
            $b.Add_Click({ param($s, $e) Invoke-MenuAction ([string]$s.Tag) })
            [void]$menuGrid.Children.Add($b)
        }
    }

    # ================= 托盘 =================
    $script:tray = New-Object System.Windows.Forms.NotifyIcon
    $iconPath = Join-Path $Root 'assets\character\icon.png'
    try {
        if (Test-Path $iconPath) {
            $script:iconBmp = New-Object System.Drawing.Bitmap -ArgumentList $iconPath
            $script:tray.Icon = [System.Drawing.Icon]::FromHandle($script:iconBmp.GetHicon())
        }
    } catch { Log "icon: $($_.Exception.Message)" }
    if (-not $script:tray.Icon) { $script:tray.Icon = [System.Drawing.SystemIcons]::Application }
    $script:tray.Text = 'AI 秘书 · 汐'
    $script:tray.Visible = $true

    function Toggle-Visible {
        if ($win.IsVisible) { $win.Hide() } else { $win.Show(); $win.Activate() | Out-Null }
    }

    $trayMenu = New-Object System.Windows.Forms.ContextMenuStrip
    [void]$trayMenu.Items.Add('显示 / 隐藏').Add_Click({ Toggle-Visible })
    [void]$trayMenu.Items.Add('打开规划中心').Add_Click({ Open-PlanningCenter })
    [void]$trayMenu.Items.Add('和她说话').Add_Click({ $win.Show(); Open-Chat })
    [void]$trayMenu.Items.Add('-')
    [void]$trayMenu.Items.Add('专注 45 分钟').Add_Click({ Start-Focus 45 })
    [void]$trayMenu.Items.Add('免打扰').Add_Click({
            $script:cfg.dndManual = -not $script:cfg.dndManual
            Save-Settings
        })
    [void]$trayMenu.Items.Add('-')
    [void]$trayMenu.Items.Add('退出').Add_Click({ Quit-Pet })
    $script:tray.ContextMenuStrip = $trayMenu
    $script:tray.Add_MouseDoubleClick({ Open-PlanningCenter })
    $script:tray.Add_BalloonTipClicked({ Open-PlanningCenter })

    # ================= 右键菜单 / 设置 / 自启 =================
    $menu = New-Object System.Windows.Controls.ContextMenu
    function Add-Mi([string]$text, [scriptblock]$onClick, [bool]$checkable = $false, $checked = $null) {
        $mi = New-Object System.Windows.Controls.MenuItem
        $mi.Header = $text
        if ($checkable) { $mi.IsCheckable = $true; if ($null -ne $checked) { $mi.IsChecked = [bool]$checked } }
        if ($onClick) { $mi.Add_Click($onClick) }
        [void]$menu.Items.Add($mi)
        return $mi
    }

    $runKey = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
    $runName = 'AISecretaryPet'
    function Test-AutoStart {
        try { return [bool]((Get-ItemProperty -Path $runKey -Name $runName -ErrorAction Stop).$runName) } catch { return $false }
    }
    function Set-AutoStart([bool]$on) {
        try {
            if ($on) {
                $launcher = Join-Path $Root 'app\start-pet.cmd'
                if (-not (Test-Path $launcher)) { Log "launcher missing $launcher"; return }
                Set-ItemProperty -Path $runKey -Name $runName -Value "`"$launcher`"" -Force
                Log 'autostart on'
            } else {
                Remove-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue
                Log 'autostart off'
            }
        } catch { Log "autostart: $($_.Exception.Message)" }
    }

    function Show-SettingsDialog {
        try {
            $script:dlg = New-Object System.Windows.Window
            $script:dlg.Title = 'AI 秘书设置'
            $script:dlg.Width = 430; $script:dlg.Height = 380
            $script:dlg.WindowStartupLocation = 'CenterScreen'
            $script:dlg.Topmost = $true
            $script:dlg.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#F7F9FC')
            $script:dlg.FontFamily = [System.Windows.Media.FontFamily]::new('Microsoft YaHei UI')

            $sp = New-Object System.Windows.Controls.StackPanel
            $sp.Margin = [System.Windows.Thickness]::new(18)
            $t = New-Object System.Windows.Controls.TextBlock
            $t.Text = '桌宠设置'; $t.FontSize = 16; $t.FontWeight = 'SemiBold'
            $t.Margin = [System.Windows.Thickness]::new(0, 0, 0, 12)
            [void]$sp.Children.Add($t)

            $script:chkTop = New-Object System.Windows.Controls.CheckBox
            $script:chkTop.Content = '窗口置顶'
            $script:chkTop.IsChecked = [bool]$script:cfg.topmost
            [void]$sp.Children.Add($script:chkTop)

            $script:chkNotify = New-Object System.Windows.Controls.CheckBox
            $script:chkNotify.Content = '系统通知（任务 / 喝水 / 休息提醒）'
            $script:chkNotify.IsChecked = [bool]$script:cfg.notifySystem
            $script:chkNotify.Margin = [System.Windows.Thickness]::new(0, 8, 0, 0)
            [void]$sp.Children.Add($script:chkNotify)

            $script:chkBoot = New-Object System.Windows.Controls.CheckBox
            $script:chkBoot.Content = '登录后主动邀请规划'
            $script:chkBoot.IsChecked = [bool]$script:cfg.bootGreeting
            $script:chkBoot.Margin = [System.Windows.Thickness]::new(0, 8, 0, 0)
            [void]$sp.Children.Add($script:chkBoot)

            $script:chkAuto = New-Object System.Windows.Controls.CheckBox
            $script:chkAuto.Content = '登录 Windows 时自动启动（当前用户启动项）'
            $script:chkAuto.IsChecked = Test-AutoStart
            $script:chkAuto.Margin = [System.Windows.Thickness]::new(0, 8, 0, 0)
            [void]$sp.Children.Add($script:chkAuto)

            $lbl = New-Object System.Windows.Controls.TextBlock
            $lbl.Text = "数据目录：$dataDir`n角色高度：$([int]$script:cfg.height) px（滚轮可调）"
            $lbl.Foreground = [System.Windows.Media.Brushes]::Gray
            $lbl.FontSize = 11
            $lbl.Margin = [System.Windows.Thickness]::new(0, 14, 0, 0)
            [void]$sp.Children.Add($lbl)

            $row = New-Object System.Windows.Controls.StackPanel
            $row.Orientation = 'Horizontal'
            $row.HorizontalAlignment = 'Right'
            $row.Margin = [System.Windows.Thickness]::new(0, 16, 0, 0)
            $ok = New-Object System.Windows.Controls.Button
            $ok.Content = '保存'; $ok.Width = 80; $ok.Height = 30
            $ok.Style = $win.Resources['FlatBtn']
            $ok.Add_Click({ Apply-SettingsDialog })
            $cancel = New-Object System.Windows.Controls.Button
            $cancel.Content = '关闭'; $cancel.Width = 80; $cancel.Height = 30
            $cancel.Margin = [System.Windows.Thickness]::new(8, 0, 0, 0)
            $cancel.Style = $win.Resources['FlatBtn']
            $cancel.Add_Click({ $script:dlg.Close() })
            [void]$row.Children.Add($ok)
            [void]$row.Children.Add($cancel)
            [void]$sp.Children.Add($row)

            $script:dlg.Content = $sp
            $script:dlg.Add_Closed({ $script:dlg = $null })
            $script:dlg.Show() | Out-Null
        } catch { Log "settings dialog: $($_.Exception.Message)" }
    }

    function Apply-SettingsDialog {
        $script:cfg.topmost = [bool]$script:chkTop.IsChecked
        $win.Topmost = [bool]$script:cfg.topmost
        $script:cfg.notifySystem = [bool]$script:chkNotify.IsChecked
        $script:cfg.bootGreeting = [bool]$script:chkBoot.IsChecked
        if ([bool]$script:chkAuto.IsChecked -ne (Test-AutoStart)) {
            if ([bool]$script:chkAuto.IsChecked) { Set-AutoStart $true } else { Set-AutoStart $false }
        }
        Save-Settings
        $script:dlg.Close()
    }

    function Resize-Pet([double]$newHeight) {
        if ($newHeight -lt 80) { $newHeight = 80 }
        if ($newHeight -gt 520) { $newHeight = 520 }
        $script:cfg.height = $newHeight
        foreach ($c in @($stageHost.Children)) { [void]$stageHost.Children.Remove($c) }
        $script:visual = New-RigVisual -Rig $script:rig -Height $newHeight
        [void]$stageHost.Children.Add($script:visual.Stage)
        $stageHost.Width = $script:visual.Stage.Width
        $stageHost.Height = $script:visual.Stage.Height
        $script:charW = $script:visual.Stage.Width
        $script:charH = $script:visual.Stage.Height
        $win.Width = [Math]::Max($script:charW + 24, 300)
        Set-PanelHeight
        Set-RigHead $script:visual $script:stateDef[$script:state].head 0 $true
        Save-Settings
        Log "resize $newHeight"
    }

    [void](Add-Mi '打开规划中心' { Open-PlanningCenter })
    [void](Add-Mi '和她说话' { $win.Show(); Open-Chat })
    [void](Add-Mi '下一个任务' { Show-NextTask })
    [void]$menu.Items.Add((New-Object System.Windows.Controls.Separator))
    $miTop = Add-Mi '总在最前' { $script:cfg.topmost = $miTop.IsChecked; $win.Topmost = [bool]$script:cfg.topmost; Save-Settings } $true $script:cfg.topmost
    $miDnd = Add-Mi '免打扰' { $script:cfg.dndManual = $miDnd.IsChecked; Save-Settings } $true $script:cfg.dndManual
    [void](Add-Mi '隐藏桌宠' { $win.Hide() })
    [void](Add-Mi '专注 45 分钟' { Start-Focus 45 })
    [void]$menu.Items.Add((New-Object System.Windows.Controls.Separator))
    $sizeMenu = New-Object System.Windows.Controls.MenuItem
    $sizeMenu.Header = '调整大小'
    foreach ($h in @(140, 180, 240, 320, 400)) {
        $mi = New-Object System.Windows.Controls.MenuItem
        $mi.Header = "$h px"
        $mi.Tag = $h
        $mi.Add_Click({ param($s, $e) Resize-Pet ([double]$s.Tag) })
        [void]$sizeMenu.Items.Add($mi)
    }
    [void]$menu.Items.Add($sizeMenu)
    [void](Add-Mi '设置' { Show-SettingsDialog })
    [void](Add-Mi '退出' { Quit-Pet })
    $rootGrid.ContextMenu = $menu

    # ================= 拖拽 / 缩放 =================
    $script:drag = $null
    $rootGrid.Add_MouseLeftButtonDown({
            param($s, $e)
            if ($menuPanel.IsMouseOver -or $chatPanel.IsMouseOver -or $reminderPanel.IsMouseOver -or $bootPanel.IsMouseOver) { return }
            if ($e.OriginalSource -is [System.Windows.Controls.TextBox]) { return }
            if ($e.ClickCount -eq 2) { Hide-AllPanels; Restore-Idle; Open-PlanningCenter; $e.Handled = $true; return }
            $p = $rootGrid.PointToScreen([System.Windows.Input.Mouse]::GetPosition($rootGrid))
            $script:drag = @{ x = $p.X; y = $p.Y; left = $win.Left; top = $win.Top; moved = $false }
            [void]$rootGrid.CaptureMouse()
            $e.Handled = $true
        })

    $rootGrid.Add_MouseMove({
            param($s, $e)
            if (-not $script:drag) { return }
            if ([System.Windows.Input.Mouse]::LeftButton -ne [System.Windows.Input.MouseButtonState]::Pressed) { return }
            $p = $rootGrid.PointToScreen([System.Windows.Input.Mouse]::GetPosition($rootGrid))
            $dx = ($p.X - $script:drag.x) / $script:dpi
            $dy = ($p.Y - $script:drag.y) / $script:dpi
            if ([Math]::Abs($dx) + [Math]::Abs($dy) -gt 3) { $script:drag.moved = $true }
            if ($script:drag.moved) {
                $win.Left = $script:drag.left + $dx
                $win.Top = $script:drag.top + $dy
                $script:anchorBottom = $win.Top + $win.Height
            }
        })

    $rootGrid.Add_MouseLeftButtonUp({
            param($s, $e)
            if (-not $script:drag) { return }
            $wasDrag = $script:drag.moved
            $script:drag = $null
            [void]$rootGrid.ReleaseMouseCapture()
            if ($wasDrag) { Save-Position }
            elseif ($script:panel -eq 'menu') { Hide-AllPanels; Restore-Idle }
            else { Show-Panel 'menu'; Set-State 'TALKING' 1500 }
            $e.Handled = $true
        })

    $rootGrid.Add_MouseWheel({
            param($s, $e)
            $h = [double]$script:cfg.height
            if ($e.Delta -gt 0) { $h += 20 } else { $h -= 20 }
            Resize-Pet $h
            $e.Handled = $true
        })

    foreach ($el in @($bubble, $chatPanel, $menuPanel, $reminderPanel, $bootPanel)) {
        $el.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true })
    }

    Build-ClickMenu

    # ================= 主时钟 =================
    function Update-Animation {
        try {
            $now = [Environment]::TickCount
            $dt = 16
            if ($script:lastAnim -gt 0) { $dt = [Math]::Min(250, $now - $script:lastAnim) }
            $script:lastAnim = $now
            $t = $script:clock.Elapsed.TotalSeconds
            $st = $script:stateDef[$script:state]

            $breathAmp = 0.0055 * [double]$st.breath
            $swayAmp = 0.55 * [double]$st.sway
            $bobAmp = 1.1 * [double]$st.bob
            $sx = 1.0 - $breathAmp * 0.6 * [Math]::Sin(2 * [Math]::PI * $t / 4.2)
            $sy = 1.0 + $breathAmp * [Math]::Sin(2 * [Math]::PI * $t / 4.2)
            $ang = $swayAmp * [Math]::Sin(2 * [Math]::PI * $t / 6.8)
            $bob = $bobAmp * [Math]::Sin(2 * [Math]::PI * $t / 3.6)

            $tg = $script:visual.Stage.RenderTransform
            if ($null -eq $tg -or $tg -isnot [System.Windows.Media.TransformGroup]) {
                $tg = New-Object System.Windows.Media.TransformGroup
                $script:sc = New-Object System.Windows.Media.ScaleTransform -ArgumentList 1.0, 1.0
                $script:rt = New-Object System.Windows.Media.RotateTransform -ArgumentList 0.0
                $script:tt = New-Object System.Windows.Media.TranslateTransform -ArgumentList 0.0, 0.0
                [void]$tg.Children.Add($script:sc)
                [void]$tg.Children.Add($script:rt)
                [void]$tg.Children.Add($script:tt)
                $script:visual.Stage.RenderTransform = $tg
                $script:visual.Stage.RenderTransformOrigin = New-Object System.Windows.Point -ArgumentList 0.5, 1.0
            }
            $script:sc.ScaleX = $sx
            $script:sc.ScaleY = $sy
            $script:rt.Angle = $ang
            $script:tt.Y = $bob

            $nod = 0.7 * [Math]::Sin(2 * [Math]::PI * $t / 5.1)
            $headDY = 0.6 * [Math]::Sin(2 * [Math]::PI * $t / 3.1)
            Set-RigHeadPose $script:visual ([double]$st.tilt + $nod) 0 $headDY
            Update-RigHead $script:visual $dt
            Update-RigFx $script:visual $dt

            if ($now -ge $script:blinkAt -and -not $script:blinking) {
                $headName = [string]$st.head
                if ($headName -eq 'idle' -or $headName -eq 'talk') {
                    $script:blinking = $true
                    $script:blinkCloseUntil = $now + 105
                    Set-RigHead $script:visual 'blink' 55
                } else { $script:blinkAt = $now + 3000 }
            } elseif ($script:blinking -and $now -ge $script:blinkCloseUntil) {
                $script:blinking = $false
                Set-RigHead $script:visual ([string]$st.head) 90
                $script:blinkAt = $now + (Get-Random -Minimum 2600 -Maximum 6800)
            }

            if ($script:stateUntil -gt 0 -and $now -ge $script:stateUntil) {
                $script:stateUntil = 0
                if ($script:state -ne 'FOCUS') { Restore-Idle }
            }

            if ($script:state -eq 'FOCUS' -and $script:focusUntil -gt [DateTime]::MinValue -and [DateTime]::Now -ge $script:focusUntil) {
                $script:focusUntil = [DateTime]::MinValue
                Show-Bubble '专注时间结束，起来走走吧。' 4200
                Set-State 'TALKING' 3000
                Show-SystemNotification '专注结束' '时间到了，休息一下。'
                try { $script:tray.Text = 'AI 秘书 · 汐' } catch { }
            }

            if ($script:panel -eq 'bubble' -and $script:bubbleHideAt -gt 0 -and $now -ge $script:bubbleHideAt -and -not $script:typeTimer.IsEnabled) {
                $script:bubbleHideAt = 0
                Hide-AllPanels
                if ($script:state -eq 'TALKING' -or $script:state -eq 'REMINDING') { Restore-Idle }
            }
        } catch { Log "anim: $($_.Exception.Message)" }
    }
    $script:animTimer.Start()
    Set-AnimationRate -1

    # ================= 轮询 =================
    $script:pollBridge = New-Object System.Windows.Threading.DispatcherTimer
    $script:pollBridge.Interval = [TimeSpan]::FromMilliseconds(120)
    $script:pollBridge.Add_Tick({ Update-Bridge })
    $script:pollBridge.Start()

    # 每 15 秒对一次账：服务重启换了端口就自动重连，不用重启桌宠
    $script:bridgeWatch = New-Object System.Windows.Threading.DispatcherTimer
    $script:bridgeWatch.Interval = [TimeSpan]::FromSeconds(15)
    $script:bridgeWatch.Add_Tick({
            try {
                if (Sync-Bridge $dataDir) {
                    $script:bridgeOk = $true
                    Log "bridge reconnected: $(Get-BridgeBase)"
                }
            } catch { }
        })
    $script:bridgeWatch.Start()

    $script:pollReminders = New-Object System.Windows.Threading.DispatcherTimer
    $script:pollReminders.Interval = [TimeSpan]::FromSeconds(5)
    $script:pollReminders.Add_Tick({
            try {
                # 免打扰/全屏时完全不取队列：提醒仍留在服务端 pending，解除后照常补发，绝不丢
                if (Test-DoNotDisturb) { return }
                if (-not (Get-BridgeBase)) { if (-not (Initialize-Bridge $dataDir)) { return } }
                Invoke-BridgeAsync -Path '/reminders/due' -OnDone {
                    param($json, $err)
                    if ($err) { return }
                    $items = @(Get-Field $json 'items' @())
                    if ($items.Count -eq 0) { return }
                    foreach ($it in $items) { $script:pendingReminders += $it }
                    Log "reminders: $($items.Count)"
                    if ($script:currentReminder) { return }
                    Show-Reminder $script:pendingReminders[0]
                }
            } catch { Log "poll: $($_.Exception.Message)" }
        })
    $script:pollReminders.Start()

    $script:pollFullscreen = New-Object System.Windows.Threading.DispatcherTimer
    $script:pollFullscreen.Interval = [TimeSpan]::FromSeconds(6)
    $script:pollFullscreen.Add_Tick({
            $was = $script:fullscreenActive
            $script:fullscreenActive = Test-FullscreenApp
            if ($was -ne $script:fullscreenActive) { Log "fullscreen=$($script:fullscreenActive)" }
        })
    $script:pollFullscreen.Start()

    function Refresh-ServiceState {
        Invoke-BridgeAsync -Path '/settings' -OnDone {
            param($json, $err)
            if (-not $err) { $script:serviceSettings = $json }
        }
    }

    # ================= 系统事件（锁屏 / 唤醒） =================
    $script:sysKind = ''
    $script:sysReason = ''
    function Handle-SysEvent {
        try {
            if ($script:sysKind -eq 'session') {
                if ($script:sysReason -eq 'SessionLock') { Set-State 'SLEEPING'; Log 'session locked' }
                elseif ($script:sysReason -eq 'SessionUnlock') { Set-State 'IDLE'; Log 'session unlocked'; Refresh-ServiceState }
            } else {
                if ($script:sysReason -eq 'Resume') { Set-State 'IDLE'; Refresh-ServiceState; Log 'system resumed' }
                elseif ($script:sysReason -eq 'Suspend') { Set-State 'SLEEPING'; Log 'system suspend' }
            }
        } catch { Log "sysevent: $($_.Exception.Message)" }
    }
    try {
        $script:sessionHandler = [Microsoft.Win32.SessionSwitchEventHandler]{
            param($s, $e)
            $script:sysKind = 'session'
            $script:sysReason = "$($e.Reason)"
            $win.Dispatcher.InvokeAsync([Action]{ Handle-SysEvent })
        }
        [Microsoft.Win32.SystemEvents]::add_SessionSwitch($script:sessionHandler)
        $script:powerHandler = [Microsoft.Win32.PowerModeChangedEventHandler]{
            param($s, $e)
            $script:sysKind = 'power'
            $script:sysReason = "$($e.Mode)"
            $win.Dispatcher.InvokeAsync([Action]{ Handle-SysEvent })
        }
        [Microsoft.Win32.SystemEvents]::add_PowerModeChanged($script:powerHandler)
        Log 'system events hooked'
    } catch { Log "system events: $($_.Exception.Message)" }

    # ================= 开机问候 =================
    function Invoke-BootGreeting {
        if (-not $script:cfg.bootGreeting) { Log 'boot greeting off'; Set-State 'IDLE'; return }
        if (-not $SessionId) { $script:bootSid = Get-SessionId } else { $script:bootSid = $SessionId }
        if ($script:cfg.lastGreetedSession -eq $script:bootSid) {
            Log "boot hello skipped: session already greeted ($($script:bootSid))"
            Set-State 'IDLE'
            return
        }
        Log "boot hello $($script:bootSid)"
        Invoke-BridgeAsync -Path '/boot/hello' -Method 'POST' -Body @{ sessionId = $script:bootSid; appStartedAt = (Get-Date).ToString('s') } -OnDone {
            param($json, $err)
            if ($err) {
                Log "boot hello failed: $err"
                Set-State 'ERROR' 2500
                Show-Bubble '我起来了，但连不上规划服务……先陪你待着。' 4600
                return
            }
            if (-not [bool](Get-Field $json 'shouldGreet' $false)) { Log 'no greeting'; Set-State 'IDLE'; return }
            $greeting = [string](Get-Field $json 'greeting' '早上好！要不要先规划一下接下来的工作？')
            $summary = Get-Field $json 'summary' $null
            $kind = [string](Get-Field $json 'kind' 'login')
            Set-State 'GREETING' 5000
            $bootTitle.Text = $greeting
            $lines = New-Object System.Collections.ArrayList
            if ($summary) {
                [void]$lines.Add("未来五天已排 $(Get-Field $summary 'planned' 0) 项，待安排 $(Get-Field $summary 'unscheduled' 0) 项")
                $conflicts = [int](Get-Field $summary 'conflicts' 0)
                if ($conflicts -gt 0) { [void]$lines.Add("发现 $conflicts 处时间冲突") }
                $dueSoon = @(Get-Field $summary 'dueSoon' @())
                if ($dueSoon.Count -gt 0) {
                    $names = @()
                    foreach ($d in ($dueSoon | Select-Object -First 2)) { $names += [string](Get-Field $d 'title' '') }
                    [void]$lines.Add("临近截止：$($names -join '、')")
                }
                $first = Get-Field $summary 'firstTask' $null
                if ($first) { [void]$lines.Add("下一件：$(Get-Field $first 'title' '')") }
            }
            if ($kind -ne 'login') { [void]$lines.Add('（这次是重新打开程序，不是新的登录）') }
            $bootText.Text = ($lines -join "`n")
            $bootActions.Children.Clear()
            foreach ($d in @(@('开始规划', 'plan', '#4C86E8'), @('查看已有计划', 'view', '#7C8AA6'), @('稍后提醒', 'later', '#7C8AA6'))) {
                $b = New-Object System.Windows.Controls.Button
                $b.Content = $d[0]; $b.Tag = $d[1]
                $b.Style = $win.Resources['FlatBtn']
                $b.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString($d[2])
                $b.Foreground = [System.Windows.Media.Brushes]::White
                $b.Add_Click({ param($s, $e) Invoke-BootAction ([string]$s.Tag) })
                [void]$bootActions.Children.Add($b)
            }
            Show-Panel 'boot'
            $script:cfg.lastGreetedSession = $script:bootSid
            Save-Settings
            Log "greeting $kind"
        }
    }

    function Invoke-BootAction([string]$action) {
        Invoke-BridgeAsync -Path '/boot/ack' -Method 'POST' -Body @{ sessionId = $script:bootSid; action = $action; snoozeMin = 30 } -OnDone { param($j, $e) }
        Hide-AllPanels
        switch ($action) {
            'plan' { Restore-Idle; Open-PlanningCenter }
            'view' { Restore-Idle; Open-PlanningCenter }
            'later' { Show-Bubble '好，30 分钟后再提醒你。' 2600; Set-State 'TALKING' 2200 }
        }
    }

    # ================= 退出 =================
    function Quit-Pet {
        if ($script:quitting) { return }
        $script:quitting = $true
        Log 'quit'
        try { Save-Position } catch { }
        try { $script:tray.Visible = $false; $script:tray.Dispose() } catch { }
        try { Close-Bridge } catch { }
        try { $win.Close() } catch { }
        try { [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown() } catch { }
        try { Remove-Item (Join-Path $dataDir 'pet.pid') -ErrorAction SilentlyContinue } catch { }
    }

    $win.Add_Closing({
            param($s, $e)
            Save-Position
            try { $script:tray.Visible = $false; $script:tray.Dispose() } catch { }
        })

    # ================= 调试截图钩子（从视觉树直接渲染，不受全屏游戏遮挡影响） =================
    $script:shotSeq = 0
    $script:shotTimer = New-Object System.Windows.Threading.DispatcherTimer
    $script:shotTimer.Interval = [TimeSpan]::FromMilliseconds(700)
    $script:shotTimer.Add_Tick({
            try {
                $flag = Join-Path $dataDir 'capture.flag'
                if (-not (Test-Path $flag)) { return }
                $cmdText = ''
                try { $cmdText = (Get-Content $flag -Raw).Trim() } catch { }
                Remove-Item $flag -ErrorAction SilentlyContinue
                if ($cmdText -like 'chattest:*') {
                    $msg = $cmdText.Substring(9)
                    Show-Panel 'chat'
                    $script:chatInputBox.Text = $msg
                    Send-Chat
                }
                if ($cmdText -eq 'settings') { Show-SettingsDialog }
                if ($cmdText -eq 'reminder') {
                    $fake = [pscustomobject]@{
                        id = 'r_debug'; kind = 'start'; title = '开始：写项目方案'
                        body = '2026-11-09 14:00-16:00，到点了，先开个头。'
                        actions = @('start', 'done', 'snooze', 'skip', 'open')
                    }
                    Show-Reminder $fake
                }
                if ($cmdText -and $cmdText -notin @('pet', '', 'reminder', 'settings')) { return }
                $script:shotSeq++
                $w = [int][Math]::Max(1, $win.ActualWidth)
                $h = [int][Math]::Max(1, $win.ActualHeight)
                $rtb = New-Object System.Windows.Media.Imaging.RenderTargetBitmap($w, $h, 96, 96, [System.Windows.Media.PixelFormats]::Pbgra32)
                $rtb.Render($rootGrid)
                $enc = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
                $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($rtb))
                $out = Join-Path $logDir "shot-pet-$($script:shotSeq).png"
                $fs = [System.IO.File]::Create($out)
                $enc.Save($fs)
                $fs.Close()
                if ($script:dlg) {
                    try {
                        $dw = [int][Math]::Max(1, $script:dlg.ActualWidth)
                        $dh = [int][Math]::Max(1, $script:dlg.ActualHeight)
                        $rtb2 = New-Object System.Windows.Media.Imaging.RenderTargetBitmap($dw, $dh, 96, 96, [System.Windows.Media.PixelFormats]::Pbgra32)
                        $rtb2.Render($script:dlg)
                        $enc2 = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
                        $enc2.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($rtb2))
                        $fs2 = [System.IO.File]::Create((Join-Path $logDir 'shot-settings.png'))
                        $enc2.Save($fs2); $fs2.Close()
                    } catch { Log "settings capture failed: $($_.Exception.Message)" }
                }
                Log "capture saved $out ($w x $h) stage=$($stageHost.ActualWidth)x$($stageHost.ActualHeight) vis=$($script:visual.Stage.ActualWidth)x$($script:visual.Stage.ActualHeight) kids=$($script:visual.Stage.Children.Count) bodySrc=$($null -ne $script:visual.Body.Source) opacity=$($script:visual.Body.Opacity)"
            } catch { Log "capture failed: $($_.Exception.Message)" }
        })
    $script:shotTimer.Start()

    # ================= 启动 =================
    try { "$PID" | Out-File -FilePath (Join-Path $dataDir 'pet.pid') -Encoding ascii -NoNewline } catch { }
    Set-State 'IDLE'
    Invoke-BootGreeting

    $syncTimer = New-Object System.Windows.Threading.DispatcherTimer
    $syncTimer.Interval = [TimeSpan]::FromMinutes(10)
    $syncTimer.Add_Tick({ Refresh-ServiceState })
    $syncTimer.Start()

    [System.Windows.Threading.Dispatcher]::CurrentDispatcher.add_UnhandledException({
            param($s, $e)
            Log "UNHANDLED: $($e.Exception.Message) @ $($e.Exception.StackTrace)"
            try { $e.Handled = $true } catch { }
        })

    try { [GC]::Collect(); [GC]::WaitForPendingFinalizers(); [GC]::Collect() } catch { }
    Log "ready rss=$([math]::Round((Get-Process -Id $PID).WorkingSet64/1MB,1))MB"

    [System.Windows.Threading.Dispatcher]::Run()
    Log '=== pet exit ==='
    try { Close-Bridge } catch { }
}
catch {
    Log "FATAL: $($_.Exception.Message)`n$($_.ScriptStackTrace)"
    throw
}
