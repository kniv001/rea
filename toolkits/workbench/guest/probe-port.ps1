$out = "C:\Users\lab\probe-port.out.txt"
$lines = @()
foreach ($port in 45999, 45998) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect("10.0.2.15", $port)
        $lines += ("port " + $port + ": CONNECT OK")
    } catch {
        $lines += ("port " + $port + ": FAIL " + $_.Exception.Message)
    } finally {
        $client.Close()
    }
}
Set-Content -LiteralPath $out -Value ($lines -join "`r`n") -Encoding UTF8
