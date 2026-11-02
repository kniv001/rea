param(
    [int]$OldPid = 0,
    [int]$Port = 45999,
    [string]$BindAddress = "10.0.2.15",
    [string]$AgentPath = ""
)
$ErrorActionPreference = "Continue"
if (-not $AgentPath) {
    $AgentPath = Join-Path $PSScriptRoot "AppData\Local\rea-workbench\agent.ps1"
}
$target = $AgentPath
$log = Join-Path (Split-Path -Parent $AgentPath) "agent-restart.log"
New-Item -ItemType Directory -Path (Split-Path -Parent $AgentPath) -Force | Out-Null
function Write-RestartLog {
    param([string]$Message)
    try { Add-Content -LiteralPath $log -Value ((Get-Date).ToString("o") + " " + $Message) } catch {}
}
Write-RestartLog ("restart requested old_pid=" + $OldPid + " port=" + $Port + " agent=" + $target)
Start-Sleep -Seconds 2
if ($OldPid -gt 0) {
    try {
        Stop-Process -Id $OldPid -Force -ErrorAction Stop
        Write-RestartLog ("stopped " + $OldPid)
    } catch {
        Write-RestartLog ("stop failed: " + $_.Exception.Message)
    }
}
Start-Sleep -Seconds 1
try {
    $process = Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -PassThru -ArgumentList @(
        "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass",
        "-File", $target, "-BindAddress", $BindAddress, "-Port", [string]$Port
    )
    Write-RestartLog ("started pid=" + $process.Id)
} catch {
    Write-RestartLog ("start failed: " + $_.Exception.Message)
}
