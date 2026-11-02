$ErrorActionPreference = "Stop"
$source = Join-Path $PSScriptRoot "agent.ps1"
$targetDir = Join-Path $env:LOCALAPPDATA "rea-workbench"
New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
$target = Join-Path $targetDir "agent.ps1"
Copy-Item -LiteralPath $source -Destination $target -Force
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
New-Item -Path $runKey -Force | Out-Null
$command = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$target`" -Port 45998"
Set-ItemProperty -Path $runKey -Name "REAWorkbenchAgent" -Value $command
netsh advfirewall firewall delete rule name="REA Workbench Agent" | Out-Null
netsh advfirewall firewall add rule name="REA Workbench Agent" dir=in action=allow protocol=TCP localport=45999,45998 profile=any | Out-Null
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$target`" -BindAddress 10.0.2.15"
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName "REAWorkbenchAgent" -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
}
Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -ArgumentList @(
    "-NoProfile",
    "-WindowStyle", "Hidden",
    "-ExecutionPolicy", "Bypass",
    "-File", $target,
    "-Port", "45998"
)
Write-Output "REA Workbench Agent installed: system 45999 (task), user 45998 (Run)"
