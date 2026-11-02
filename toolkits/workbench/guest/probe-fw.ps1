$out = "C:\Users\lab\probe-fw.out.txt"
$lines = @()
$rules = Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object {
    $_.Enabled -eq "True" -and $_.Direction -eq "Inbound"
}
foreach ($rule in $rules) {
    $port = $rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
    $app = $rule | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue
    $localPort = [string]$port.LocalPort
    $program = [string]$app.Program
    if ($localPort -match "4599" -or $program -match "powershell") {
        $lines += ("name=" + $rule.DisplayName + " action=" + $rule.Action + " profile=" + $rule.Profile + " port=" + $localPort + " program=" + $program)
    }
}
$profiles = Get-NetFirewallProfile -ErrorAction SilentlyContinue | ForEach-Object {
    "profile " + $_.Name + " enabled=" + $_.Enabled + " inbound=" + $_.DefaultInboundAction
}
Set-Content -LiteralPath $out -Value (($lines + $profiles) -join "`r`n") -Encoding UTF8
