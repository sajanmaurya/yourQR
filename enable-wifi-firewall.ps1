# Enables only this Node app, on Wi-Fi, port 8787, from the local subnet.
# Run in an administrator PowerShell window. No router port forwarding is used.
param([string]$StatusPath)
$ErrorActionPreference = 'Stop'
try {
    $yourQRNode = (Get-Command node.exe -ErrorAction Stop).Source
    $yourQRRuleName = 'Qori-WiFi-8787'
    if (-not (Get-NetFirewallRule -Name $yourQRRuleName -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -Name $yourQRRuleName -DisplayName 'yourQR QR app - same Wi-Fi only' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8787 -Program $yourQRNode -RemoteAddress LocalSubnet -InterfaceAlias 'Wi-Fi' -Profile Private,Public -EdgeTraversalPolicy Block -ErrorAction Stop | Out-Null
    }
    $yourQRRule = Get-NetFirewallRule -Name $yourQRRuleName -ErrorAction Stop
    if ($yourQRRule.Enabled -ne 'True' -or $yourQRRule.Action -ne 'Allow') { throw 'The firewall rule is not enabled.' }
    if ($StatusPath) { @{success=$true;rule=$yourQRRuleName} | ConvertTo-Json | Set-Content -LiteralPath $StatusPath }
    Write-Output 'yourQR is allowed on Wi-Fi from the local subnet on TCP port 8787.'
} catch {
    if ($StatusPath) { @{success=$false;error=$_.Exception.Message} | ConvertTo-Json | Set-Content -LiteralPath $StatusPath }
    Write-Error $_
    exit 1
}
