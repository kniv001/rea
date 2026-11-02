$ErrorActionPreference = "Continue"
$install = "C:\Users\lab\AppData\Local\rea-workbench"
$target = Join-Path $install "agent.ps1"
$log = Join-Path $install "elevate.log"
function Write-ElevateLog {
    param([string]$Message)
    try { Add-Content -LiteralPath $log -Value ((Get-Date).ToString("o") + " " + $Message) } catch {}
}
Write-ElevateLog ("elevated helper started, elevated=" + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
try {
    $stale = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object {
        $_.CommandLine -match "rea-workbench\\agent\.ps1" -and $_.CommandLine -notmatch "-Port 45998"
    }
    foreach ($process in $stale) {
        try {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
            Write-ElevateLog ("killed stale " + $process.ProcessId)
        } catch {
            Write-ElevateLog ("kill failed " + $process.ProcessId + ": " + $_.Exception.Message)
        }
    }
} catch {
    Write-ElevateLog ("stale scan failed: " + $_.Exception.Message)
}
Start-Sleep -Seconds 2
try {
    $process = Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -PassThru -ArgumentList @(
        "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass",
        "-File", $target, "-BindAddress", "10.0.2.15", "-Port", "45999"
    )
    Write-ElevateLog ("elevated agent started pid=" + $process.Id)
} catch {
    Write-ElevateLog ("elevated agent start failed: " + $_.Exception.Message)
}
