# 冒烟测试：只验证角色骨架能不能正确渲染 + 截图取证
param([int]$Height = 180, [string]$Out = 'D:\AI-Secretary\logs\smoke-rig.png')

$ErrorActionPreference = 'Continue'
$root = 'D:\AI-Secretary'
$logFile = 'D:\AI-Secretary\logs\smoke-rig.log'
function Log([string]$m) { "$([DateTime]::Now.ToString('HH:mm:ss.fff'))  $m" | Out-File -FilePath $logFile -Append -Encoding utf8 }
try { Remove-Item $logFile -ErrorAction SilentlyContinue } catch { }

try {
    Log 'start'
    . (Join-Path $root 'app\lib\Rig.ps1')
    Add-Type -AssemblyName PresentationFramework, System.Drawing, System.Windows.Forms
    Log 'assemblies ok'

    $rig = Load-Rig (Join-Path $root 'assets\character')
    Log "rig loaded parts=$($rig.parts.Count)"
    $vis = New-RigVisual -Rig $rig -Height $Height
    Log "visual built k=$($vis.K)"

    $win = New-Object System.Windows.Window
    $win.WindowStyle = 'None'
    $win.AllowsTransparency = $true
    $win.Background = [System.Windows.Media.Brushes]::Transparent
    $win.Topmost = $true
    $win.ShowInTaskbar = $false
    $win.Width = 320
    $win.Height = $Height + 60
    $win.Left = 120
    $win.Top = 80
    $win.Content = $vis.Stage
    $win.Show()
    Log 'window shown'

    $sw = [Diagnostics.Stopwatch]::StartNew()
    $script:tick = 0
    $script:done = $false

    function Finish {
        if ($script:done) { return }
        $script:done = $true
        try {
            $bmp = New-Object System.Drawing.Bitmap -ArgumentList 320, ($Height + 60)
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            $g.CopyFromScreen(120, 80, 0, 0, (New-Object System.Drawing.Size -ArgumentList 320, ($Height + 60)))
            $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
            $g.Dispose(); $bmp.Dispose()
            Log "saved $Out"
        } catch { Log "capture failed: $($_.Exception.Message)" }
        try { $win.Close() } catch { }
        try { [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown() } catch { }
    }

    $timer = New-Object System.Windows.Threading.DispatcherTimer
    $timer.Interval = [TimeSpan]::FromMilliseconds(33)
    $timer.Add_Tick({
            try {
                $script:tick++
                $t = $sw.Elapsed.TotalSeconds
                $breath = 1.0 + 0.006 * [Math]::Sin(2 * [Math]::PI * $t / 4.2)
                $scaleT = New-Object System.Windows.Media.ScaleTransform -ArgumentList 1.0, $breath
                $vis.Stage.RenderTransform = $scaleT
                $vis.Stage.RenderTransformOrigin = New-Object System.Windows.Point -ArgumentList 0.5, 1.0
                Set-RigHeadPose $vis (0.8 * [Math]::Sin(2 * [Math]::PI * $t / 7.0)) 0 (0.8 * [Math]::Sin(2 * [Math]::PI * $t / 3.7))
                if ($script:tick -eq 20) { Set-RigHead $vis 'blink' 120 }
                if ($script:tick -eq 30) { Set-RigHead $vis 'happy' 160; Set-RigFx $vis @('sparkle') 1.0 }
                Update-RigHead $vis 33
                Update-RigFx $vis 33
                if ($script:tick -eq 46) { $timer.Stop(); Log "final variant=$($vis.Variant)"; Finish }
            } catch { Log "tick error: $($_.Exception.Message)" }
        })
    $timer.Start()

    $guard = New-Object System.Windows.Threading.DispatcherTimer
    $guard.Interval = [TimeSpan]::FromSeconds(8)
    $guard.Add_Tick({ $guard.Stop(); Log 'guard fired'; Finish })
    $guard.Start()

    Log 'dispatcher run'
    [System.Windows.Threading.Dispatcher]::Run()
    Log 'dispatcher exit'
} catch {
    Log "FATAL $($_.Exception.Message) | $($_.ScriptStackTrace)"
    exit 1
}
