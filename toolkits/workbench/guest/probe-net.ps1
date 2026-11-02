$out = "C:\Users\lab\probe-net.out.txt"
$lines = @()
$lines += (Get-NetFirewallProfile -ErrorAction SilentlyContinue | ForEach-Object {
    "profile " + $_.Name + " enabled=" + $_.Enabled + " inbound=" + $_.DefaultInboundAction
})
$lines += (Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object {
    "conn " + $_.Name + " category=" + $_.NetworkCategory + " ipv4=" + $_.IPv4Connectivity
})
$lines += (Get-NetFirewallRule -DisplayName "Windows PowerShell" -ErrorAction SilentlyContinue | ForEach-Object {
    "rule " + $_.DisplayName + " enabled=" + $_.Enabled + " profile=" + $_.Profile + " action=" + $_.Action + " direction=" + $_.Direction
})
Set-Content -LiteralPath $out -Value ($lines -join "`r`n") -Encoding UTF8
