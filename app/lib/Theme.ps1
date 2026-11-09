# AI-Secretary · 主题与配色
function Get-SystemTheme {
    try {
        $v = (Get-ItemProperty -Path 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name 'AppsUseLightTheme' -ErrorAction Stop).AppsUseLightTheme
        if ($v -eq 0) { return 'dark' }
    } catch { }
    return 'light'
}

function Get-Theme([string]$Mode = 'system') {
    if ($Mode -eq 'system') { $Mode = Get-SystemTheme }
    if ($Mode -eq 'dark') {
        return @{
            Mode = 'dark'
            Panel = '#F21E2436'; PanelEdge = '#3A6FA8FF'; PanelText = '#E8EDF7'; PanelSub = '#9FB0C9'
            Accent = '#6FA8FF'; AccentSoft = '#2E4A78'; AccentText = '#FFFFFF'
            Btn = '#2A3550'; BtnText = '#DCE6F5'; BtnHover = '#39476A'
            Bubble = '#F21E2436'; BubbleEdge = '#3A6FA8FF'
            Ok = '#6BD08A'; Warn = '#FFC46B'; Bad = '#FF7A85'
        }
    }
    return @{
        Mode = 'light'
        Panel = '#F7FFFFFF'; PanelEdge = '#2E6FA8FF'; PanelText = '#1F2A3C'; PanelSub = '#5E6E85'
        Accent = '#4C86E8'; AccentSoft = '#DCE9FF'; AccentText = '#FFFFFF'
        Btn = '#EEF3FB'; BtnText = '#2A3A52'; BtnHover = '#DFE9F8'
        Bubble = '#FAFFFFFF'; BubbleEdge = '#336FA8FF'
        Ok = '#2FA35C'; Warn = '#C98A18'; Bad = '#D0454F'
    }
}
