@echo off
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
netsh advfirewall firewall add rule name="REA Workbench Agent" dir=in action=allow protocol=TCP localport=45999 >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0agent.ps1" -Install
pause
