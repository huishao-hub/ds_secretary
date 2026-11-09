# AI-Secretary · 角色骨架（分层伪 Live2D）
# 由 assets\character\rig.json 驱动：body + head(多表情变体) + fx 叠加层。
# 连续运动（呼吸/摇摆/浮动/点头）由变换驱动；脸部状态用变体交叉淡入。
Set-StrictMode -Version 2.0

Add-Type -AssemblyName PresentationCore, PresentationFramework, WindowsBase

function Get-RigBitmap([string]$path, [int]$decodeWidth = 0) {
    $bmp = New-Object System.Windows.Media.Imaging.BitmapImage
    $bmp.BeginInit()
    $bmp.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
    if ($decodeWidth -gt 0) { $bmp.DecodePixelWidth = $decodeWidth }
    $bmp.UriSource = New-Object System.Uri($path, [System.UriKind]::Absolute)
    $bmp.EndInit()
    $bmp.Freeze()
    return $bmp
}

function Load-Rig([string]$CharacterDir) {
    $rigPath = Join-Path $CharacterDir 'rig.json'
    if (-not (Test-Path $rigPath)) { throw "找不到 rig.json: $rigPath" }
    $rig = Get-Content $rigPath -Raw -Encoding utf8 | ConvertFrom-Json
    $rig | Add-Member -NotePropertyName Root -NotePropertyValue $CharacterDir -Force
    return $rig
}

# 依据当前显示高度计算缩放；返回 WPF 视觉树
function New-RigVisual {
    param($Rig, [double]$Height)

    $cw = [double]$Rig.canvas.w
    $chh = [double]$Rig.canvas.h
    $k = $Height / $chh
    $decodeW = [int][Math]::Ceiling($cw * $k * 1.7)
    if ($decodeW -lt 200) { $decodeW = 200 }

    $stage = New-Object System.Windows.Controls.Canvas
    $stage.Width = [Math]::Round($cw * $k, 1)
    $stage.Height = [Math]::Round($chh * $k, 1)
    $stage.ClipToBounds = $false
    $stage.Background = $null

    $visual = @{
        Stage = $stage; K = $k; Height = $Height; Rig = $Rig
        Body = $null; HeadA = $null; HeadB = $null; HeadBox = $null
        Fx = @{}; Variant = $Rig.parts[1].default; FadeTo = $null; FadeP = 1.0
    }

    foreach ($part in $Rig.parts) {
        if ($part.id -eq 'body') {
            $file = Join-Path $Rig.Root ($part.file -replace '/', '\')
            $img = New-Object System.Windows.Controls.Image
            $img.Source = Get-RigBitmap $file $decodeW
            $img.Stretch = 'Fill'
            $img.Width = [Math]::Round($part.w * $k, 1)
            $img.Height = [Math]::Round($part.h * $k, 1)
            [System.Windows.Controls.Canvas]::SetLeft($img, [Math]::Round($part.x * $k, 1))
            [System.Windows.Controls.Canvas]::SetTop($img, [Math]::Round($part.y * $k, 1))
            $stage.Children.Add($img) | Out-Null
            $visual.Body = $img
        }
        elseif ($part.id -eq 'head') {
            $box = New-Object System.Windows.Controls.Canvas
            $box.Width = [Math]::Round($part.w * $k, 1)
            $box.Height = [Math]::Round($part.h * $k, 1)
            [System.Windows.Controls.Canvas]::SetLeft($box, [Math]::Round($part.x * $k, 1))
            [System.Windows.Controls.Canvas]::SetTop($box, [Math]::Round($part.y * $k, 1))
            $box.Background = $null
            # 绕颈部枢轴的旋转（枢轴在 canvas 坐标系里）
            $tg = New-Object System.Windows.Media.TransformGroup
            $rot = New-Object System.Windows.Media.RotateTransform(0.0)
            $tr = New-Object System.Windows.Media.TranslateTransform(0.0, 0.0)
            $tg.Children.Add($rot) | Out-Null
            $tg.Children.Add($tr) | Out-Null
            $box.RenderTransform = $tg
            $ox = ([double]$part.pivot.x - [double]$part.x) / [double]$part.w
            $oy = ([double]$part.pivot.y - [double]$part.y) / [double]$part.h
            $box.RenderTransformOrigin = New-Object System.Windows.Point -ArgumentList $ox, $oy
            $box.Tag = @{ Rotate = $rot; Translate = $tr }

            $a = New-Object System.Windows.Controls.Image
            $a.Stretch = 'Fill'
            $a.Width = [Math]::Round($part.w * $k, 1)
            $a.Height = [Math]::Round($part.h * $k, 1)
            $b = New-Object System.Windows.Controls.Image
            $b.Stretch = 'Fill'
            $b.Width = [Math]::Round($part.w * $k, 1)
            $b.Height = [Math]::Round($part.h * $k, 1)
            $b.Opacity = 0.0
            $box.Children.Add($a) | Out-Null
            $box.Children.Add($b) | Out-Null
            $stage.Children.Add($box) | Out-Null

            $visual.HeadBox = $box
            $visual.HeadA = $a
            $visual.HeadB = $b
            $visual.DecodeW = $decodeW
            Set-RigHead $visual 'default' 0 $false
        }
    }

    foreach ($name in $Rig.fx.PSObject.Properties.Name) {
        $def = $Rig.fx.$name
        $file = Join-Path $Rig.Root ("layers/fx-$name.png")
        if (-not (Test-Path $file)) { continue }
        $img = New-Object System.Windows.Controls.Image
        $img.Source = Get-RigBitmap $file 0
        $img.Stretch = 'Fill'
        $img.Width = [Math]::Round($def.w * $k, 1)
        $img.Height = [Math]::Round($def.h * $k, 1)
        $img.Opacity = 0.0
        [System.Windows.Controls.Canvas]::SetLeft($img, [Math]::Round($def.x * $k, 1))
        [System.Windows.Controls.Canvas]::SetTop($img, [Math]::Round($def.y * $k, 1))
        $img.Tag = @{ Opacity = 0.0; Target = 0.0 }
        $stage.Children.Add($img) | Out-Null
        $visual.Fx[$name] = $img
    }
    return $visual
}

function Set-RigHead {
    param($Visual, [string]$Variant, [int]$FadeMs = 0, [bool]$Force = $false)
    if (-not $Visual.HeadA) { return }
    $headPart = $null
    foreach ($p in $Visual.Rig.parts) { if ($p.id -eq 'head') { $headPart = $p } }
    if (-not $headPart) { return }
    $variants = $headPart.variants.PSObject.Properties
    $def = $null
    if ($Variant -eq 'default') {
        $def = $variants[$headPart.default].Value
        $Variant = $headPart.default
    } else {
        $prop = $headPart.variants.PSObject.Properties[$Variant]
        if (-not $prop) { return }
        $def = $prop.Value
    }
    if (-not $Force -and $Visual.Variant -eq $Variant -and $Visual.FadeP -ge 1.0) { return }
    $file = Join-Path $Visual.Rig.Root $def.file
    $bmp = Get-RigBitmap $file $Visual.DecodeW
    if ($FadeMs -le 0) {
        $Visual.HeadA.Source = $bmp
        $Visual.HeadB.Opacity = 0.0
        $Visual.HeadB.Source = $bmp
        $Visual.FadeP = 1.0
    } else {
        $Visual.HeadB.Source = $bmp
        $Visual.HeadB.Opacity = 0.0
        $Visual.FadeP = 0.0
        $Visual.FadeTo = @{ From = $Visual.HeadA.Source; To = $bmp; Variant = $Variant; Ms = $FadeMs }
    }
    $Visual.Variant = $Variant
}

# 主时钟每帧调用：推进头部交叉淡入
function Update-RigHead {
    param($Visual, [int]$ElapsedMs)
    if (-not $Visual.FadeTo) { return }
    $Visual.FadeP += ($ElapsedMs / [double]$Visual.FadeTo.Ms)
    if ($Visual.FadeP -ge 1.0) {
        $Visual.HeadA.Source = $Visual.FadeTo.To
        $Visual.HeadB.Opacity = 0.0
        $Visual.FadeP = 1.0
        $Visual.FadeTo = $null
    } else {
        $Visual.HeadB.Opacity = [Math]::Min(1.0, $Visual.FadeP)
    }
}

function Set-RigFx {
    param($Visual, [string[]]$Names, [double]$Target = 1.0)
    foreach ($key in $Visual.Fx.Keys) {
        $img = $Visual.Fx[$key]
        $want = if ($Names -and ($Names -contains $key)) { $Target } else { 0.0 }
        $img.Tag.Target = $want
        if ($want -gt 0 -and $img.Opacity -le 0.01) { $img.Opacity = 0.01 }
    }
}

function Update-RigFx {
    param($Visual, [int]$ElapsedMs, [double]$Speed = 0.012)
    foreach ($key in $Visual.Fx.Keys) {
        $img = $Visual.Fx[$key]
        $cur = [double]$img.Opacity
        $want = [double]$img.Tag.Target
        if ([Math]::Abs($want - $cur) -lt 0.01) {
            if ([Math]::Abs($cur - $want) -gt 0) { $img.Opacity = $want }
            continue
        }
        $step = $Speed * $ElapsedMs
        if ($cur -lt $want) { $img.Opacity = [Math]::Min($want, $cur + $step) }
        else { $img.Opacity = [Math]::Max($want, $cur - $step) }
    }
}

function Set-RigHeadPose {
    param($Visual, [double]$AngleDeg, [double]$DX, [double]$DY)
    if (-not $Visual.HeadBox) { return }
    $t = $Visual.HeadBox.Tag
    $t.Rotate.Angle = $AngleDeg
    $t.Translate.X = $DX * $Visual.K
    $t.Translate.Y = $DY * $Visual.K
}
