$ErrorActionPreference = "Stop"
$Port = 45999
$portIndex = [Array]::IndexOf($args, "-Port")
if ($portIndex -ge 0 -and $portIndex + 1 -lt $args.Count) {
    $Port = [int]$args[$portIndex + 1]
}
$MaxBytes = 16MB
$script:StopRequested = $false
$script:Watchers = @{}
$BindAddress = "10.0.2.15"
$bindIndex = [Array]::IndexOf($args, "-BindAddress")
if ($bindIndex -ge 0 -and $bindIndex + 1 -lt $args.Count) {
    $BindAddress = [string]$args[$bindIndex + 1]
}

# -Install copies the agent to a stable per-user path, adds a per-user Run
# entry on the interactive port, opens both loopback ports, and registers a
# SYSTEM control agent on the privileged port. The current process still
# starts its own listener immediately afterward.
if ($args -contains "-Install") {
    $installDir = Join-Path $env:LOCALAPPDATA "rea-workbench"
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    $target = Join-Path $installDir "agent.ps1"
    Copy-Item -LiteralPath $PSCommandPath -Destination $target -Force
    $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    New-Item -Path $runKey -Force | Out-Null
    $command = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$target`" -Port 45998"
    Set-ItemProperty -Path $runKey -Name "REAWorkbenchAgent" -Value $command
    & netsh advfirewall firewall delete rule name="REA Workbench Agent" | Out-Null
    & netsh advfirewall firewall add rule name="REA Workbench Agent" dir=in action=allow protocol=TCP localport=45999,45998 profile=any | Out-Null
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($isAdmin) {
        try {
            $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$target`" -BindAddress 10.0.2.15"
            $trigger = New-ScheduledTaskTrigger -AtStartup
            $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
            Register-ScheduledTask -TaskName "REAWorkbenchAgent" -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
        } catch {
            Write-Warning ("SYSTEM agent task registration failed: " + $_.Exception.Message)
        }
    }
}

function Send-JsonLine {
    param($Stream, $Object)
    $json = $Object | ConvertTo-Json -Compress -Depth 10
    $bytes = [Text.Encoding]::UTF8.GetBytes($json + "`n")
    $Stream.Write($bytes, 0, $bytes.Length)
    $Stream.Flush()
}

function Get-Sha256Hex {
    param([byte[]]$Bytes)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return -join ($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString("x2") })
    } finally {
        $sha.Dispose()
    }
}

function Get-FileSha256 {
    param([string]$Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    $stream = $null
    try {
        $stream = [IO.File]::OpenRead($Path)
        return -join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString("x2") })
    } finally {
        if ($stream) { $stream.Dispose() }
        $sha.Dispose()
    }
}

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Format-DateTime {
    param($Value)
    if ($null -eq $Value) { return $null }
    try { return ([datetime]$Value).ToString("o") } catch { return [string]$Value }
}

function Convert-RegValue {
    param($Value, [string]$Kind)
    if ($null -eq $Value) { return $null }
    if ($Value -is [byte[]]) {
        return @{ kind = "Binary"; hex = (($Value | ForEach-Object { $_.ToString("x2") }) -join "") }
    }
    if ($Value -is [array]) {
        return @{ kind = $Kind; value = @($Value | ForEach-Object { [string]$_ }) }
    }
    return @{ kind = $Kind; value = [string]$Value }
}

function Normalize-RegPath {
    param([string]$Path)
    $text = [string]$Path
    if (-not $text) { return "" }
    $text = $text.Replace("/", "\").Trim()
    $map = @{
        "HKLM" = "HKLM:"
        "HKEY_LOCAL_MACHINE" = "HKLM:"
        "HKCU" = "HKCU:"
        "HKEY_CURRENT_USER" = "HKCU:"
        "HKCR" = "Registry::HKEY_CLASSES_ROOT"
        "HKEY_CLASSES_ROOT" = "Registry::HKEY_CLASSES_ROOT"
        "HKU" = "Registry::HKEY_USERS"
        "HKEY_USERS" = "Registry::HKEY_USERS"
        "HKCC" = "Registry::HKEY_CURRENT_CONFIG"
        "HKEY_CURRENT_CONFIG" = "Registry::HKEY_CURRENT_CONFIG"
    }
    $text = $text.Trim()
    foreach ($key in $map.Keys) {
        if ($text -match ("^" + [regex]::Escape($key) + "(\\|:|$)")) {
            $rest = $text.Substring($key.Length).TrimStart(":\")
            if ($rest) { return $map[$key] + "\" + $rest }
            return $map[$key] + "\"
        }
    }
    return $text
}

function Invoke-AgentCommand {
    param($Request)
    $cmd = [string]$Request.cmd
    switch ($cmd) {
        "ping" {
            return @{
                ok = $true
                host = $env:COMPUTERNAME
                user = [Environment]::UserName
                os = [Environment]::OSVersion.VersionString
                time = (Get-Date).ToString("o")
                pid = $PID
                admin = (Test-IsAdmin)
                version = 1
            }
        }
        "whoami" {
            $id = [Security.Principal.WindowsIdentity]::GetCurrent()
            $principal = [Security.Principal.WindowsPrincipal]::new($id)
            $priv = ""
            $groups = ""
            try { $priv = (whoami /priv 2>&1 | Out-String).Trim() } catch {}
            try { $groups = (whoami /groups 2>&1 | Out-String).Trim() } catch {}
            $mandatory = ($groups -split "`r?`n" | Where-Object { $_ -match "Mandatory Label" } | Select-Object -First 1)
            return @{
                ok = $true
                identity = $id.Name
                sid = $id.User.Value
                is_admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
                is_system = ($id.User.Value -eq "S-1-5-18")
                session_id = (Get-Process -Id $PID).SessionId
                pid = $PID
                computer = $env:COMPUTERNAME
                user = $env:USERNAME
                integrity = ([string]$mandatory).Trim()
                privileges = $priv
            }
        }
        "profile" {
            $cs = Get-CimInstance Win32_ComputerSystem
            $bios = Get-CimInstance Win32_BIOS
            $os = Get-CimInstance Win32_OperatingSystem
            $product = Get-CimInstance Win32_ComputerSystemProduct -ErrorAction SilentlyContinue
            $disks = @(Get-CimInstance Win32_DiskDrive | Select-Object -First 8 | ForEach-Object {
                [pscustomobject]@{ model = $_.Model; serial = $_.SerialNumber; size = $_.Size }
            })
            $nics = @(Get-CimInstance Win32_NetworkAdapter -Filter "PhysicalAdapter=True" | Select-Object -First 8 | ForEach-Object {
                [pscustomobject]@{ name = $_.Name; mac = $_.MACAddress }
            })
            return @{
                ok = $true
                computer = @{
                    name = $cs.Name
                    manufacturer = $cs.Manufacturer
                    model = $cs.Model
                    memory = $cs.TotalPhysicalMemory
                    uuid = if ($product) { $product.UUID } else { $null }
                }
                bios = @{
                    manufacturer = $bios.Manufacturer
                    version = $bios.SMBIOSBIOSVersion
                    serial = $bios.SerialNumber
                    release = $bios.ReleaseDate
                }
                product = if ($product) { @{
                    vendor = $product.Vendor
                    name = $product.Name
                    version = $product.Version
                    serial = $product.IdentifyingNumber
                    uuid = $product.UUID
                } } else { $null }
                os = @{
                    caption = $os.Caption
                    version = $os.Version
                    build = $os.BuildNumber
                    install_date = (Format-DateTime $os.InstallDate)
                }
                disks = $disks
                nics = $nics
            }
        }
        "identity" {
            $machineGuid = $null
            $productId = $null
            try { $machineGuid = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Cryptography" -Name MachineGuid -ErrorAction Stop).MachineGuid } catch {}
            try { $productId = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion" -Name ProductId -ErrorAction Stop).ProductId } catch {}
            $bios = @{}
            try {
                $k = Get-ItemProperty "HKLM:\HARDWARE\DESCRIPTION\System\BIOS" -ErrorAction Stop
                foreach ($name in @(
                    "BaseBoardManufacturer", "BaseBoardProduct", "BaseBoardSerialNumber", "BaseBoardVersion",
                    "BIOSVendor", "BIOSVersion", "BIOSReleaseDate",
                    "SystemManufacturer", "SystemProductName", "SystemSerialNumber", "SystemVersion", "SystemSKU"
                )) {
                    $value = $k.$name
                    if ($null -ne $value) { $bios[$name] = [string]$value }
                }
            } catch {}
            $cpu = @{}
            try {
                $k = Get-ItemProperty "HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor\0" -ErrorAction Stop
                foreach ($name in @("ProcessorNameString", "Identifier", "VendorIdentifier", "~MHz")) {
                    $value = $k.$name
                    if ($null -ne $value) { $cpu[$name] = if ($name -eq "~MHz") { [int64]$value } else { [string]$value } }
                }
            } catch {}
            $wmiCpu = $null
            try { $wmiCpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name } catch {}
            $smbios = $null
            try {
                $p = Get-CimInstance Win32_ComputerSystemProduct -ErrorAction Stop
                $smbios = @{
                    vendor = $p.Vendor
                    name = $p.Name
                    version = $p.Version
                    serial = $p.IdentifyingNumber
                    uuid = $p.UUID
                }
            } catch {}
            $volume = $null
            try { $volume = (Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").VolumeSerialNumber } catch {}
            $os = Get-CimInstance Win32_OperatingSystem
            return @{
                ok = $true
                computer = $env:COMPUTERNAME
                user = [Environment]::UserName
                machine_guid = $machineGuid
                product_id = $productId
                install_date = (Format-DateTime $os.InstallDate)
                system_drive_volume_serial = $volume
                bios_registry = $bios
                cpu_registry = $cpu
                wmi_cpu_name = $wmiCpu
                smbios = $smbios
                os = @{ caption = $os.Caption; version = $os.Version; build = $os.BuildNumber }
            }
        }
        "identity_apply" {
            $machineGuid = [string]$Request.machine_guid
            $productId = [string]$Request.product_id
            $computerName = [string]$Request.computer_name
            $cpuName = [string]$Request.cpu_name
            $bios = $Request.bios
            $persist = ($Request.persist -ne $false)
            $applied = @()
            $previous = @{}
            $needsReboot = $false

            $hasField = $false
            if ($machineGuid) { $hasField = $true }
            if ($productId) { $hasField = $true }
            if ($computerName) { $hasField = $true }
            if ($cpuName) { $hasField = $true }
            if ($bios) { $hasField = $true }
            if (-not $hasField) { return @{ ok = $false; error = "no identity fields supplied" } }
            if (-not (Test-IsAdmin)) { return @{ ok = $false; error = "administrator required" } }

            if ($machineGuid) {
                if ($machineGuid -notmatch "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$") {
                    return @{ ok = $false; error = "machine_guid must be a canonical UUID" }
                }
                try { $previous.machine_guid = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Cryptography" -Name MachineGuid -ErrorAction Stop).MachineGuid } catch {}
                Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Cryptography" -Name MachineGuid -Value $machineGuid -ErrorAction Stop
                $applied += "machine_guid"
            }
            if ($productId) {
                if ($productId -notmatch "^[A-Za-z0-9-]{5,40}$") { return @{ ok = $false; error = "product_id must be 5-40 alphanumeric/dash chars" } }
                try { $previous.product_id = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion" -Name ProductId -ErrorAction Stop).ProductId } catch {}
                Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion" -Name ProductId -Value $productId -ErrorAction Stop
                $applied += "product_id"
            }
            if ($computerName) {
                if ($computerName -notmatch "^[A-Za-z0-9-]{1,15}$") { return @{ ok = $false; error = "computer_name must be 1-15 alphanumeric/dash chars" } }
                $previous.computer_name = $env:COMPUTERNAME
                try {
                    Rename-Computer -NewName $computerName -Force -ErrorAction Stop
                    $applied += "computer_name"
                    $needsReboot = $true
                } catch {
                    return @{ ok = $false; error = ("rename failed: " + $_.Exception.Message); applied = $applied }
                }
            }
            if ($bios) {
                $allowed = @(
                    "BaseBoardManufacturer", "BaseBoardProduct", "BaseBoardSerialNumber", "BaseBoardVersion",
                    "BIOSVendor", "BIOSVersion", "BIOSReleaseDate",
                    "SystemManufacturer", "SystemProductName", "SystemSerialNumber", "SystemVersion", "SystemSKU"
                )
                $key = "HKLM:\HARDWARE\DESCRIPTION\System\BIOS"
                if (-not (Test-Path -LiteralPath $key)) {
                    New-Item -Path $key -Force | Out-Null
                }
                foreach ($name in $allowed) {
                    $value = [string]$bios.$name
                    if (-not $value) { continue }
                    if ($value.Length -gt 96 -or $value -match "[`r`n`0]") {
                        return @{ ok = $false; error = ("invalid bios value for " + $name); applied = $applied }
                    }
                    try { $previous["bios." + $name] = (Get-ItemProperty $key -Name $name -ErrorAction Stop).$name } catch {}
                    Set-ItemProperty -Path $key -Name $name -Value $value -ErrorAction Stop
                    $applied += ("bios." + $name)
                }
            }
            if ($cpuName) {
                if ($cpuName.Length -gt 96 -or $cpuName -match "[`r`n`0]") {
                    return @{ ok = $false; error = "invalid cpu_name"; applied = $applied }
                }
                $key = "HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor\0"
                try { $previous.cpu_name = (Get-ItemProperty $key -Name ProcessorNameString -ErrorAction Stop).ProcessorNameString } catch {}
                try {
                    Set-ItemProperty -Path $key -Name ProcessorNameString -Value $cpuName -ErrorAction Stop
                    $applied += "cpu_name"
                } catch {
                    return @{ ok = $false; error = ("cpu_name write failed: " + $_.Exception.Message); applied = $applied }
                }
            }

            $persistPath = $null
            $taskName = $null
            if ($persist) {
                $root = Join-Path $env:ProgramData "rea-workbench"
                New-Item -ItemType Directory -Path $root -Force | Out-Null
                $persistPath = Join-Path $root "identity.json"
                $doc = [ordered]@{
                    updated_at = (Get-Date).ToString("o")
                    machine_guid = if ($machineGuid) { $machineGuid } else { $previous.machine_guid }
                    product_id = if ($productId) { $productId } else { $previous.product_id }
                    cpu_name = if ($cpuName) { $cpuName } else { $previous.cpu_name }
                    bios = $bios
                }
                $doc | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $persistPath -Encoding UTF8
                $taskScript = Join-Path $root "identity-task.ps1"
                $scriptText = @'
$ErrorActionPreference = "Continue"
$root = Join-Path $env:ProgramData "rea-workbench"
$log = Join-Path $root "identity-apply.log"
function Write-ApplyLog {
    param([string]$Message)
    try {
        Add-Content -LiteralPath $log -Value ((Get-Date).ToString("o") + " " + $Message)
    } catch {}
}
try {
    $id = Get-Content -LiteralPath (Join-Path $root "identity.json") -Raw | ConvertFrom-Json
    if ($id.machine_guid) {
        Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Cryptography" -Name MachineGuid -Value ([string]$id.machine_guid)
    }
    if ($id.product_id) {
        Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion" -Name ProductId -Value ([string]$id.product_id)
    }
    if ($id.bios) {
        $key = "HKLM:\HARDWARE\DESCRIPTION\System\BIOS"
        if (-not (Test-Path -LiteralPath $key)) {
            New-Item -Path $key -Force | Out-Null
        }
        foreach ($prop in $id.bios.PSObject.Properties) {
            if ($null -ne $prop.Value) {
                Set-ItemProperty -Path $key -Name $prop.Name -Value ([string]$prop.Value)
            }
        }
    }
    if ($id.cpu_name) {
        try {
            Set-ItemProperty -Path "HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor\0" -Name ProcessorNameString -Value ([string]$id.cpu_name)
        } catch {}
    }
    Write-ApplyLog "identity applied"
} catch {
    Write-ApplyLog ("identity apply failed: " + $_.Exception.Message)
}
'@
                Set-Content -LiteralPath $taskScript -Value $scriptText -Encoding UTF8
                try {
                    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$taskScript`""
                    $trigger = New-ScheduledTaskTrigger -AtStartup
                    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
                    Register-ScheduledTask -TaskName "REAIdentityApply" -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
                    $taskName = "REAIdentityApply"
                } catch {
                    return @{ ok = $false; error = ("identity persisted but task registration failed: " + $_.Exception.Message); applied = $applied; persisted = $persistPath }
                }
            }

            return @{
                ok = $true
                applied = $applied
                previous = $previous
                persist_file = $persistPath
                scheduled_task = $taskName
                needs_reboot = $needsReboot
            }
        }
        "net_conns" {
            $procNames = @{}
            Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $procNames[$_.Id] = $_.ProcessName }
            $entries = @()
            try {
                $tcp = Get-NetTCPConnection -ErrorAction Stop | Select-Object -First 500
                foreach ($c in $tcp) {
                    $entries += [pscustomobject]@{
                        proto = "tcp"
                        local = ($c.LocalAddress + ":" + $c.LocalPort)
                        remote = ($c.RemoteAddress + ":" + $c.RemotePort)
                        state = [string]$c.State
                        pid = $c.OwningProcess
                        process = $procNames[$c.OwningProcess]
                    }
                }
            } catch {}
            try {
                $udp = Get-NetUDPEndpoint -ErrorAction Stop | Select-Object -First 300
                foreach ($c in $udp) {
                    $entries += [pscustomobject]@{
                        proto = "udp"
                        local = ($c.LocalAddress + ":" + $c.LocalPort)
                        remote = ""
                        state = "listen"
                        pid = $c.OwningProcess
                        process = $procNames[$c.OwningProcess]
                    }
                }
            } catch {}
            return @{ ok = $true; entries = @($entries | Sort-Object proto, pid); count = @($entries).Count }
        }
        "services" {
            $filter = [string]$Request.filter
            $items = @(Get-CimInstance Win32_Service | Select-Object -First 500 | ForEach-Object {
                [pscustomobject]@{
                    name = $_.Name
                    display = $_.DisplayName
                    state = $_.State
                    start_mode = $_.StartMode
                    pid = $_.ProcessId
                    account = $_.StartName
                    path = $_.PathName
                }
            })
            if ($filter) {
                $needle = $filter.ToLower()
                $items = @($items | Where-Object {
                    ($_.name + " " + $_.display + " " + $_.path).ToLower().Contains($needle)
                })
            }
            return @{ ok = $true; services = $items; count = @($items).Count }
        }
        "autoruns" {
            $runKeys = @(
                "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run",
                "HKLM:\Software\Microsoft\Windows\CurrentVersion\RunOnce",
                "HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Run",
                "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run",
                "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce"
            )
            $entries = @()
            foreach ($key in $runKeys) {
                try {
                    $item = Get-ItemProperty -Path $key -ErrorAction Stop
                    foreach ($prop in $item.PSObject.Properties) {
                        if ($prop.Name -like "PS*") { continue }
                        $entries += [pscustomobject]@{ kind = "run"; key = $key; name = $prop.Name; value = [string]$prop.Value }
                    }
                } catch {}
            }
            $folders = @()
            try { $folders += [Environment]::GetFolderPath("Startup") } catch {}
            try { $folders += [Environment]::GetFolderPath("CommonStartup") } catch {}
            foreach ($folder in $folders) {
                if (-not $folder) { continue }
                try {
                    Get-ChildItem -LiteralPath $folder -Force -ErrorAction Stop | ForEach-Object {
                        $entries += [pscustomobject]@{ kind = "startup_folder"; key = $folder; name = $_.Name; value = $_.FullName }
                    }
                } catch {}
            }
            try {
                $tasks = Get-ScheduledTask -ErrorAction Stop | Select-Object -First 300
                foreach ($task in $tasks) {
                    $entries += [pscustomobject]@{
                        kind = "scheduled_task"
                        key = [string]$task.TaskPath
                        name = [string]$task.TaskName
                        value = [string]$task.State
                    }
                }
            } catch {}
            try {
                $auto = Get-CimInstance Win32_Service -Filter "StartMode='Auto'" -ErrorAction Stop | Select-Object -First 200
                foreach ($svc in $auto) {
                    $entries += [pscustomobject]@{ kind = "service_auto"; key = "services"; name = $svc.Name; value = [string]$svc.PathName }
                }
            } catch {}
            return @{ ok = $true; entries = $entries; count = @($entries).Count }
        }
        "eventlog" {
            $log = [string]$Request.log
            if (-not $log) { $log = "System" }
            $max = 50
            if ($Request.max) { $max = [Math]::Max(1, [Math]::Min([int]$Request.max, 500)) }
            $events = @()
            try {
                $events = @(Get-WinEvent -LogName $log -MaxEvents $max -ErrorAction Stop)
            } catch {
                return @{ ok = $false; error = $_.Exception.Message; log = $log }
            }
            $level = [string]$Request.level
            $since = $null
            if ($Request.since_minutes) {
                $since = (Get-Date).AddMinutes(-1 * [double]$Request.since_minutes)
            }
            $entries = @()
            foreach ($event in $events) {
                if ($level) {
                    if ($event.LevelDisplayName -ne $level -and [string]$event.Level -ne $level) { continue }
                }
                if ($since -and $event.TimeCreated -lt $since) { continue }
                $message = ""
                try { $message = [string]$event.Message } catch {}
                if ($message.Length -gt 800) { $message = $message.Substring(0, 800) + "..." }
                $entries += [pscustomobject]@{
                    time = $event.TimeCreated.ToString("o")
                    id = $event.Id
                    provider = $event.ProviderName
                    level = $event.LevelDisplayName
                    record_id = $event.RecordId
                    message = $message
                }
            }
            return @{ ok = $true; log = $log; entries = $entries; count = @($entries).Count }
        }
        "dns_cache" {
            $entries = @()
            try {
                $entries = @(Get-DnsClientCache -ErrorAction Stop | Select-Object -First 500 | ForEach-Object {
                    [pscustomobject]@{
                        entry = $_.Entry
                        name = $_.RecordName
                        type = $_.RecordType
                        status = $_.Status
                        data = $_.Data
                        ttl = $_.TimeToLive
                    }
                })
            } catch {
                return @{ ok = $false; error = $_.Exception.Message }
            }
            return @{ ok = $true; entries = $entries; count = $entries.Count }
        }
        "reg_read" {
            $path = Normalize-RegPath ([string]$Request.path)
            if (-not $path) { return @{ ok = $false; error = "path required" } }
            try {
                $item = Get-Item -LiteralPath $path -ErrorAction Stop
            } catch {
                return @{ ok = $false; error = $_.Exception.Message; path = $path }
            }
            $name = [string]$Request.name
            if ($Request.PSObject.Properties.Name -contains "name" -and $Request.name -ne $null) {
                $valueName = [string]$Request.name
                if ($valueName -eq "(default)") { $valueName = "" }
                try {
                    $kind = $item.GetValueKind($valueName).ToString()
                    $value = $item.GetValue($valueName)
                    return @{
                        ok = $true
                        path = $path
                        name = if ($valueName) { $valueName } else { "(default)" }
                        kind = $kind
                        value = (Convert-RegValue -Value $value -Kind $kind)
                    }
                } catch {
                    return @{ ok = $false; error = $_.Exception.Message; path = $path; name = $Request.name }
                }
            }
            $values = @()
            foreach ($valueName in $item.GetValueNames()) {
                try {
                    $kind = $item.GetValueKind($valueName).ToString()
                    $value = $item.GetValue($valueName)
                    $values += [pscustomobject]@{
                        name = if ($valueName) { $valueName } else { "(default)" }
                        kind = $kind
                        value = (Convert-RegValue -Value $value -Kind $kind)
                    }
                } catch {}
            }
            return @{
                ok = $true
                path = $path
                values = $values
                subkeys = @($item.GetSubKeyNames())
                count = $values.Count
            }
        }
        "reg_write" {
            $path = Normalize-RegPath ([string]$Request.path)
            if (-not $path) { return @{ ok = $false; error = "path required" } }
            if (-not (Test-IsAdmin)) { return @{ ok = $false; error = "administrator required" } }
            $name = [string]$Request.name
            if (-not $name) { return @{ ok = $false; error = "name required; use (default) for the default value" } }
            $type = [string]$Request.type
            if (-not $type) { $type = "String" }
            $allowed = @("String", "ExpandString", "DWord", "QWord", "Binary", "MultiString")
            if ($allowed -notcontains $type) {
                return @{ ok = $false; error = ("type must be one of " + ($allowed -join ",")) }
            }
            $raw = $Request.value
            $value = $raw
            if ($type -eq "DWord") { $value = [int][int64]$raw }
            elseif ($type -eq "QWord") { $value = [int64]$raw }
            elseif ($type -eq "Binary") {
                $hex = ([string]$raw) -replace "\s", ""
                if ($hex.Length % 2 -ne 0 -or $hex -notmatch "^[0-9a-fA-F]*$") {
                    return @{ ok = $false; error = "Binary value must be an even-length hex string" }
                }
                $bytes = New-Object byte[] ($hex.Length / 2)
                for ($i = 0; $i -lt $bytes.Length; $i++) {
                    $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16)
                }
                $value = $bytes
            } elseif ($type -eq "MultiString") {
                $value = @($raw | ForEach-Object { [string]$_ })
            } else {
                $value = [string]$raw
            }
            try {
                $item = Get-Item -LiteralPath $path -ErrorAction Stop
            } catch {
                try {
                    $parent = Split-Path -Path $path -Parent
                    if ($parent) { New-Item -Path $parent -Force -ErrorAction SilentlyContinue | Out-Null }
                    $item = New-Item -Path $path -Force -ErrorAction Stop
                } catch {
                    return @{ ok = $false; error = $_.Exception.Message; path = $path }
                }
            }
            $valueName = $name
            if ($valueName -eq "(default)") { $valueName = "" }
            $previous = $null
            try {
                if ($item.GetValueNames() -contains $valueName) {
                    $previous = (Convert-RegValue -Value $item.GetValue($valueName) -Kind $item.GetValueKind($valueName).ToString())
                }
            } catch {}
            try {
                if ($valueName -eq "") {
                    $kind = [Microsoft.Win32.RegistryValueKind]::$type
                    $item.SetValue("", $value, $kind)
                } else {
                    Set-ItemProperty -LiteralPath $path -Name $valueName -Value $value -Type $type -ErrorAction Stop
                }
            } catch {
                return @{ ok = $false; error = $_.Exception.Message; path = $path; name = $name }
            }
            return @{ ok = $true; path = $path; name = $name; type = $type; previous = $previous }
        }
        "stat" {
            $path = [string]$Request.path
            if (-not $path) { return @{ ok = $false; error = "path required" } }
            try {
                $info = Get-Item -LiteralPath $path -Force -ErrorAction Stop
            } catch {
                return @{ ok = $false; error = $_.Exception.Message; path = $path }
            }
            if ($info.PSIsContainer) {
                return @{ ok = $true; path = $path; directory = $true; last_write = $info.LastWriteTimeUtc.ToString("o") }
            }
            return @{
                ok = $true
                path = $path
                directory = $false
                bytes = $info.Length
                last_write = $info.LastWriteTimeUtc.ToString("o")
                sha256 = (Get-FileSha256 $path)
            }
        }
        "ls_tree" {
            $root = [string]$Request.path
            if (-not $root) { return @{ ok = $false; error = "path required" } }
            $max = 5000
            if ($Request.max) { $max = [Math]::Max(1, [Math]::Min([int]$Request.max, 50000)) }
            $depthMax = 16
            if ($Request.depth) { $depthMax = [Math]::Max(0, [Math]::Min([int]$Request.depth, 64)) }
            $withHash = ($Request.hash -eq $true)
            $entries = New-Object System.Collections.ArrayList
            $stack = New-Object System.Collections.Stack
            $stack.Push(@{ path = $root; rel = ""; depth = 0 })
            $hashedBytes = 0
            while ($stack.Count -gt 0 -and $entries.Count -lt $max) {
                $current = $stack.Pop()
                $items = @(Get-ChildItem -LiteralPath $current.path -Force -ErrorAction SilentlyContinue)
                foreach ($item in $items) {
                    if ($entries.Count -ge $max) { break }
                    $rel = if ($current.rel) { $current.rel + "\" + $item.Name } else { $item.Name }
                    if ($item.PSIsContainer) {
                        [void]$entries.Add([pscustomobject]@{
                            rel = $rel
                            directory = $true
                            bytes = $null
                            last_write = $item.LastWriteTimeUtc.ToString("o")
                            sha256 = $null
                        })
                        if ($current.depth -lt $depthMax) {
                            $stack.Push(@{ path = $item.FullName; rel = $rel; depth = $current.depth + 1 })
                        }
                    } else {
                        $sha = $null
                        if ($withHash -and $entries.Count -lt 200 -and $hashedBytes -lt 536870912) {
                            try {
                                $sha = Get-FileSha256 $item.FullName
                                $hashedBytes += $item.Length
                            } catch {}
                        }
                        [void]$entries.Add([pscustomobject]@{
                            rel = $rel
                            directory = $false
                            bytes = $item.Length
                            last_write = $item.LastWriteTimeUtc.ToString("o")
                            sha256 = $sha
                        })
                    }
                }
            }
            return @{
                ok = $true
                path = $root
                entries = @($entries)
                count = $entries.Count
                truncated = ($entries.Count -ge $max)
            }
        }
        "watch_start" {
            $path = [string]$Request.path
            if (-not $path) { return @{ ok = $false; error = "path required" } }
            if (-not (Test-Path -LiteralPath $path)) {
                return @{ ok = $false; error = "path not found" }
            }
            $id = if ($Request.id) {
                ([string]$Request.id -replace "[^A-Za-z0-9_-]", "")
            } else {
                [guid]::NewGuid().ToString("N").Substring(0, 8)
            }
            if (-not $id) { return @{ ok = $false; error = "invalid id" } }
            $recursive = [bool]$Request.recursive
            $snapshot = @{}
            $items = Get-ChildItem -LiteralPath $path -Force -Recurse:$recursive -ErrorAction SilentlyContinue |
                Select-Object -First 5000
            foreach ($item in $items) {
                if (-not $item.PSIsContainer) {
                    $snapshot[$item.FullName] = @{
                        length = $item.Length
                        last_write = $item.LastWriteTimeUtc.ToString("o")
                    }
                }
            }
            $script:Watchers[$id] = @{
                path = $path
                recursive = $recursive
                snapshot = $snapshot
            }
            return @{
                ok = $true
                id = $id
                path = $path
                recursive = $recursive
                mode = "poll-snapshot"
                files = $snapshot.Count
            }
        }
        "watch_poll" {
            $id = ([string]$Request.id -replace "[^A-Za-z0-9_-]", "")
            if (-not $id -or -not $script:Watchers.ContainsKey($id)) {
                return @{ ok = $false; error = "unknown watch id" }
            }
            $watch = $script:Watchers[$id]
            $max = 500
            if ($Request.max) { $max = [Math]::Max(1, [Math]::Min([int]$Request.max, 5000)) }
            $current = @{}
            $items = Get-ChildItem -LiteralPath $watch.path -Force -Recurse:$watch.recursive -ErrorAction SilentlyContinue |
                Select-Object -First 5000
            foreach ($item in $items) {
                if (-not $item.PSIsContainer) {
                    $current[$item.FullName] = @{
                        length = $item.Length
                        last_write = $item.LastWriteTimeUtc.ToString("o")
                    }
                }
            }
            $entries = @()
            foreach ($pathKey in $current.Keys) {
                if (-not $watch.snapshot.ContainsKey($pathKey)) {
                    $entries += [ordered]@{ time = (Get-Date).ToString("o"); change = "created"; path = $pathKey }
                } elseif (
                    $watch.snapshot[$pathKey].length -ne $current[$pathKey].length -or
                    $watch.snapshot[$pathKey].last_write -ne $current[$pathKey].last_write
                ) {
                    $entries += [ordered]@{ time = (Get-Date).ToString("o"); change = "modified"; path = $pathKey }
                }
            }
            foreach ($pathKey in $watch.snapshot.Keys) {
                if (-not $current.ContainsKey($pathKey)) {
                    $entries += [ordered]@{ time = (Get-Date).ToString("o"); change = "deleted"; path = $pathKey }
                }
            }
            $watch.snapshot = $current
            $script:Watchers[$id] = $watch
            $totalChanges = @($entries).Count
            $entries = @($entries | Select-Object -First $max)
            return @{ ok = $true; id = $id; entries = $entries; remaining = [Math]::Max(0, $totalChanges - $max) }
        }
        "watch_stop" {
            $id = ([string]$Request.id -replace "[^A-Za-z0-9_-]", "")
            if (-not $id -or -not $script:Watchers.ContainsKey($id)) {
                return @{ ok = $false; error = "unknown watch id" }
            }
            $watch = $script:Watchers[$id]
            $script:Watchers.Remove($id)
            return @{ ok = $true; id = $id; path = $watch.path; files = $watch.snapshot.Count }
        }
        "ps" {
            $items = @(Get-Process | Sort-Object Id | Select-Object -First 500 | ForEach-Object {
                [pscustomobject]@{
                    id = $_.Id
                    name = $_.ProcessName
                    cpu = $_.CPU
                    working_set = $_.WorkingSet64
                }
            })
            return @{ ok = $true; processes = $items }
        }
        "ls" {
            $path = [string]$Request.path
            if (-not $path) { return @{ ok = $false; error = "path required" } }
            $items = @(Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop | Select-Object -First 1000 | ForEach-Object {
                [pscustomobject]@{
                    name = $_.Name
                    length = if ($_.PSIsContainer) { $null } else { $_.Length }
                    directory = [bool]$_.PSIsContainer
                    last_write = $_.LastWriteTime.ToString("o")
                }
            })
            return @{ ok = $true; path = $path; entries = $items }
        }
        "read" {
            $path = [string]$Request.path
            if (-not $path) { return @{ ok = $false; error = "path required" } }
            $max = $MaxBytes
            if ($Request.max_bytes) {
                $max = [Math]::Min([int64]$Request.max_bytes, $MaxBytes)
            }
            $info = Get-Item -LiteralPath $path -Force -ErrorAction Stop
            if ($info.PSIsContainer) { return @{ ok = $false; error = "path is a directory" } }
            $offset = 0
            if ($null -ne $Request.offset) { $offset = [int64]$Request.offset }
            if ($offset -lt 0 -or $offset -gt $info.Length) {
                return @{ ok = $false; error = "offset outside file"; bytes = $info.Length }
            }
            $length = $info.Length - $offset
            if ($length -gt $max) { $length = $max }
            $buffer = New-Object byte[] $length
            $read = 0
            $stream = [IO.File]::OpenRead($path)
            try {
                [void]$stream.Seek($offset, [IO.SeekOrigin]::Begin)
                while ($read -lt $length) {
                    $n = $stream.Read($buffer, $read, $length - $read)
                    if ($n -le 0) { break }
                    $read += $n
                }
            } finally {
                $stream.Dispose()
            }
            if ($read -ne $length) {
                $trimmed = New-Object byte[] $read
                [Array]::Copy($buffer, $trimmed, $read)
                $buffer = $trimmed
            }
            return @{
                ok = $true
                path = $path
                offset = $offset
                bytes = $buffer.Length
                total_bytes = $info.Length
                eof = (($offset + $buffer.Length) -ge $info.Length)
                sha256 = Get-Sha256Hex $buffer
                base64 = [Convert]::ToBase64String($buffer)
            }
        }
        "write" {
            $path = [string]$Request.path
            if (-not $path) { return @{ ok = $false; error = "path required" } }
            if (-not $Request.base64) { return @{ ok = $false; error = "base64 required" } }
            $bytes = [Convert]::FromBase64String([string]$Request.base64)
            if ($bytes.Length -gt $MaxBytes) {
                return @{ ok = $false; error = "payload exceeds 16 MiB" }
            }
            $parent = Split-Path -Parent $path
            if ($parent -and -not (Test-Path -LiteralPath $parent)) {
                New-Item -ItemType Directory -Path $parent -Force | Out-Null
            }
            if ($Request.append -eq $true) {
                $stream = [IO.File]::Open($path, [IO.FileMode]::Append, [IO.FileAccess]::Write)
                try {
                    $stream.Write($bytes, 0, $bytes.Length)
                } finally {
                    $stream.Dispose()
                }
            } else {
                [IO.File]::WriteAllBytes($path, $bytes)
            }
            return @{
                ok = $true
                path = $path
                bytes = $bytes.Length
                sha256 = Get-Sha256Hex $bytes
            }
        }
        "launch" {
            $path = [string]$Request.path
            if (-not $path) { return @{ ok = $false; error = "path required" } }
            $argList = @()
            if ($Request.arguments) { $argList = @($Request.arguments) }
            $startArgs = @{
                FilePath = $path
                PassThru = $true
            }
            if ($argList.Count -gt 0) { $startArgs.ArgumentList = $argList }
            if ($Request.cwd) { $startArgs.WorkingDirectory = [string]$Request.cwd }
            $process = Start-Process @startArgs
            return @{ ok = $true; pid = $process.Id; path = $path }
        }
        "etw_start" {
            $name = [string]$Request.name
            if (-not $name) { $name = "rea-kernel" }
            if ($name -notmatch "^[A-Za-z0-9_-]{1,32}$") {
                return @{ ok = $false; error = "name must match [A-Za-z0-9_-]{1,32}" }
            }
            $all = @(
                @{ id = "{22FB2CD6-0E7B-422B-A0C7-2FAD1FD0E716}"; name = "process"; keywords = "0x30"; level = "5" },
                @{ id = "{EDD08927-9CC4-4E65-B970-C2560FB5C289}"; name = "file"; keywords = "0xffffffff"; level = "5" },
                @{ id = "{70EB4F03-C1DE-4F73-A051-33D13D5413BD}"; name = "registry"; keywords = "0xffffffff"; level = "5" },
                @{ id = "{7DD42A49-5329-4832-8DFD-43D979153A88}"; name = "network"; keywords = "0xffffffff"; level = "5" }
            )
            $wanted = @("process", "registry", "network")
            if ($Request.providers) { $wanted = @($Request.providers | ForEach-Object { [string]$_ }) }
            $selected = @()
            foreach ($want in $wanted) {
                $hit = $all | Where-Object { $_.name -eq $want -or $_.id -eq $want } | Select-Object -First 1
                if (-not $hit) { return @{ ok = $false; error = ("unknown provider: " + $want + "; use process,file,registry,network or a GUID") } }
                $selected += $hit
            }
            $existing = (logman query $name -ets 2>&1 | Out-String).Trim()
            if ($LASTEXITCODE -eq 0) {
                return @{ ok = $false; error = "session already exists"; name = $name; output = $existing }
            }
            $root = Join-Path $env:ProgramData "rea-workbench\telemetry"
            New-Item -ItemType Directory -Path $root -Force | Out-Null
            $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
            $file = Join-Path $root ($name + "-" + $stamp + ".etl")
            $providerFile = Join-Path $root ($name + ".providers.txt")
            $lines = @()
            foreach ($p in $selected) {
                $lines += ($p.id + " " + $p.keywords + " " + $p.level)
            }
            Set-Content -LiteralPath $providerFile -Value $lines -Encoding ASCII
            $logmanArgs = @("create", "trace", $name, "-pf", $providerFile, "-o", $file, "-ets", "-f", "bin", "-bs", "256")
            $output = (& logman @logmanArgs 2>&1 | Out-String).Trim()
            $code = $LASTEXITCODE
            if ($code -ne 0) {
                return @{ ok = $false; error = "logman create failed"; exit = $code; output = $output }
            }
            $map = [ordered]@{
                name = $name
                file = $file
                providers = @($selected | ForEach-Object { $_.name })
                started_at = (Get-Date).ToString("o")
            }
            $map | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $root ($name + ".json")) -Encoding UTF8
            return @{ ok = $true; name = $name; file = $file; providers = $map.providers; output = $output }
        }
        "etw_status" {
            $name = [string]$Request.name
            if (-not $name) { $name = "rea-kernel" }
            $root = Join-Path $env:ProgramData "rea-workbench\telemetry"
            $mapPath = Join-Path $root ($name + ".json")
            $map = $null
            try { $map = Get-Content -LiteralPath $mapPath -Raw | ConvertFrom-Json } catch {}
            $output = (logman query $name -ets 2>&1 | Out-String).Trim()
            $running = ($LASTEXITCODE -eq 0)
            $file = $null
            if ($map) { $file = [string]$map.file }
            $info = $null
            if ($file -and (Test-Path -LiteralPath $file)) {
                $item = Get-Item -LiteralPath $file
                $info = @{ path = $file; bytes = $item.Length; last_write = $item.LastWriteTimeUtc.ToString("o") }
            }
            return @{
                ok = $true
                name = $name
                running = $running
                session_output = $output
                file = $info
                providers = if ($map) { $map.providers } else { $null }
                started_at = if ($map) { $map.started_at } else { $null }
            }
        }
        "etw_stop" {
            $name = [string]$Request.name
            if (-not $name) { $name = "rea-kernel" }
            $output = (logman stop $name -ets 2>&1 | Out-String).Trim()
            $root = Join-Path $env:ProgramData "rea-workbench\telemetry"
            $mapPath = Join-Path $root ($name + ".json")
            $file = $null
            try {
                $map = Get-Content -LiteralPath $mapPath -Raw | ConvertFrom-Json
                $file = [string]$map.file
            } catch {}
            Start-Sleep -Milliseconds 800
            $info = $null
            if ($file -and (Test-Path -LiteralPath $file)) {
                $item = Get-Item -LiteralPath $file
                $info = @{
                    path = $file
                    bytes = $item.Length
                    sha256 = (Get-FileSha256 $file)
                    last_write = $item.LastWriteTimeUtc.ToString("o")
                }
            }
            return @{ ok = $true; name = $name; output = $output; file = $info }
        }
        "etw_summary" {
            $name = [string]$Request.name
            $file = [string]$Request.path
            if (-not $file) {
                if (-not $name) { $name = "rea-kernel" }
                $root = Join-Path $env:ProgramData "rea-workbench\telemetry"
                try {
                    $map = Get-Content -LiteralPath (Join-Path $root ($name + ".json")) -Raw | ConvertFrom-Json
                    $file = [string]$map.file
                } catch {}
            }
            if (-not $file -or -not (Test-Path -LiteralPath $file)) {
                return @{ ok = $false; error = "trace file not found"; path = $file }
            }
            $summary = [IO.Path]::ChangeExtension($file, ".summary.txt")
            if (Test-Path -LiteralPath $summary) {
                Remove-Item -LiteralPath $summary -Force -ErrorAction SilentlyContinue
            }
            $tracer = Join-Path $env:SystemRoot "System32\tracerpt.exe"
            Start-Process -FilePath $tracer -ArgumentList @($file, "-summary", $summary, "-y") -WindowStyle Hidden | Out-Null
            $deadline = (Get-Date).AddSeconds(60)
            while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $summary)) {
                Start-Sleep -Milliseconds 500
            }
            if (-not (Test-Path -LiteralPath $summary)) {
                return @{ ok = $false; error = "tracerpt did not produce a summary within 60s"; file = $file; summary_file = $summary }
            }
            $item = Get-Item -LiteralPath $summary -ErrorAction SilentlyContinue
            return @{
                ok = ($null -ne $item)
                file = $file
                summary_file = $summary
                bytes = if ($item) { $item.Length } else { 0 }
                note = "summary file is ready; copy it to the host instead of reading it inside the agent"
            }
        }
        "stop" {
            $script:StopRequested = $true
            try { $script:Listener.Stop() } catch {}
            return @{ ok = $true; stopping = $true }
        }
        default {
            return @{ ok = $false; error = "unknown command: $cmd" }
        }
    }
}

$listener = $null
$script:Listener = $null
$bindDeadline = (Get-Date).AddSeconds(120)
$logDir = Join-Path $env:ProgramData "rea-workbench"
function Write-AgentLog {
    param([string]$Message)
    try {
        if (-not (Test-Path -LiteralPath $logDir)) {
            New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        }
        Add-Content -LiteralPath (Join-Path $logDir "agent.log") -Value ((Get-Date).ToString("o") + " [" + $PID + "] " + $Message)
    } catch {}
}
Write-AgentLog ("start port=" + $Port + " bind=" + $BindAddress + " user=" + $env:USERNAME)
while ($null -eq $listener) {
    try {
        $candidate = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse($BindAddress), $Port)
        $candidate.Start()
        $listener = $candidate
        $script:Listener = $listener
        Write-AgentLog ("bound " + $BindAddress + ":" + $Port)
    } catch {
        if ((Get-Date) -gt $bindDeadline) {
            Write-AgentLog ("bind failed permanently: " + $_.Exception.Message)
            Write-Error ("Agent failed to bind " + $BindAddress + ":" + $Port + ": " + $_.Exception.Message)
            exit 1
        }
        Start-Sleep -Seconds 2
    }
}
try {
    while (-not $script:StopRequested) {
        $client = $listener.AcceptTcpClient()
        try {
            $client.NoDelay = $true
            $stream = $client.GetStream()
            $stream.ReadTimeout = 15000
            $stream.WriteTimeout = 60000
            $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $false, 4096, $true)
            # One request per connection. A half-open slirp connection must not
            # wedge the single-threaded agent, so drop idle clients.
            $idle = [Diagnostics.Stopwatch]::StartNew()
            while (-not $script:StopRequested) {
                if (-not $stream.DataAvailable) {
                    if ($idle.Elapsed.TotalSeconds -gt 10) { break }
                    Start-Sleep -Milliseconds 50
                    continue
                }
                $line = $reader.ReadLine()
                if ($null -eq $line) { break }
                if (-not $line.Trim()) { $idle.Restart(); continue }
                try {
                    $request = $line | ConvertFrom-Json
                    $response = Invoke-AgentCommand $request
                } catch {
                    $response = @{ ok = $false; error = $_.Exception.Message }
                }
                Send-JsonLine $stream $response
                break
            }
        } catch {
            # Client disconnected; keep serving.
        } finally {
            $client.Close()
        }
    }
} finally {
    $listener.Stop()
}
