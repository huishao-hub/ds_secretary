$files = @(
    'D:\AI-Secretary\app\Pet.ps1',
    'D:\AI-Secretary\app\PlanningCenter.ps1',
    'D:\AI-Secretary\app\lib\Bridge.ps1'
)
foreach ($f in $files) {
    $errs = $null
    $null = [System.Management.Automation.PSParser]::Tokenize((Get-Content $f -Raw), [ref]$errs)
    if ($errs.Count -eq 0) { "OK   $([System.IO.Path]::GetFileName($f))" }
    else { "FAIL $([System.IO.Path]::GetFileName($f))"; $errs | ForEach-Object { "     " + $_.Message } }
}
