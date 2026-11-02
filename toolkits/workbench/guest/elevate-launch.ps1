$ErrorActionPreference = "Stop"
Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "C:\Users\lab\rea-elevate.ps1"
)
