$ErrorActionPreference = "Continue"
$outPath = "C:\Users\lab\rea-probe.json"
function Try-It {
    param([scriptblock]$Block)
    try { return (& $Block) } catch { return @{ error = $_.Exception.Message } }
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$integrity = "unknown"
try {
    $token = [Security.Principal.WindowsIdentity]::GetCurrent().Token
    # 0x2000 = high, 0x3000 = system, 0x1000 = medium
    $elevation = $token.IsElevated
} catch { $elevation = $null }

$regWrite = Try-It {
    $key = "HKLM:\SOFTWARE\REAWorkbenchProbe"
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name "Probe" -Value "ok"
    $value = (Get-ItemProperty -Path $key -Name "Probe").Probe
    Remove-Item -Path $key -Recurse -Force
    @{ ok = ($value -eq "ok"); value = $value }
}

$machineGuid = Try-It { (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Cryptography" -Name MachineGuid).MachineGuid }
$productId = Try-It { (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion" -Name ProductId).ProductId }
$biosReg = Try-It {
    $k = "HKLM:\HARDWARE\DESCRIPTION\System\BIOS"
    Get-ItemProperty $k | Select-Object BaseBoardManufacturer, BaseBoardProduct, BIOSVendor, BIOSVersion, BIOSReleaseDate, SystemManufacturer, SystemProductName, SystemSerialNumber, SystemVersion
}
$cpuReg = Try-It {
    $k = "HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor\0"
    Get-ItemProperty $k | Select-Object ProcessorNameString, Identifier, VendorIdentifier, ~MHz
}

$schedTask = Try-It { (schtasks /query /tn REAWorkbenchAgent /fo LIST 2>&1 | Out-String).Trim() }
$schedTask2 = Try-It { (schtasks /query /tn REAWorkbenchAgentTask /fo LIST 2>&1 | Out-String).Trim() }
$agentProc = Try-It { Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Select-Object ProcessId, CommandLine, ParentProcessId }

$tools = @{}
foreach ($name in "logman", "tracerpt", "wpr", "wevtutil", "reg", "schtasks", "whoami") {
    $tools[$name] = [bool](Get-Command $name -ErrorAction SilentlyContinue)
}
$logmanSessions = Try-It { (logman query -ets 2>&1 | Out-String).Trim() }
$winfsp = Try-It {
    @{
        service = (Get-Service winfsp -ErrorAction SilentlyContinue | Select-Object Name, Status, StartType)
        dir = (Test-Path "$env:ProgramFiles\WinFsp")
    }
}

$payload = [ordered]@{
    time = (Get-Date).ToString("o")
    computer = $env:COMPUTERNAME
    user = $env:USERNAME
    identity = $identity.Name
    is_admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    token_elevated = $elevation
    integrity = $integrity
    os_build = [Environment]::OSVersion.VersionString
    reg_hklm_write = $regWrite
    machine_guid = $machineGuid
    product_id = $productId
    bios_registry = $biosReg
    cpu_registry = $cpuReg
    scheduled_task = $schedTask
    scheduled_task_alt = $schedTask2
    powershell_processes = $agentProc
    tools = $tools
    logman_sessions = $logmanSessions
    winfsp = $winfsp
    sid = $identity.User.Value
}
try {
    $payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $outPath -Encoding UTF8
    @{ ok = $true; path = $outPath } | ConvertTo-Json -Compress
} catch {
    @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
