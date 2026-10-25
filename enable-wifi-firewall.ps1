# Enables only this Node app, on Wi-Fi, port 8787, from the local subnet.
# Run in an administrator PowerShell window. No router port forwarding is used.
param([string]$StatusPath)
$ErrorActionPreference = 'Stop'
try {
    $qoriNode = (Get-Command node.exe -ErrorAction Stop).Source
    $qoriRuleName = 'Qori-WiFi-8787'
    if (-not (Get-NetFirewallRule -Name $qoriRuleName -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -Name $qoriRuleName -DisplayName 'Qori QR app - same Wi-Fi only' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8787 -Program $qoriNode -RemoteAddress LocalSubnet -InterfaceAlias 'Wi-Fi' -Profile Private,Public -EdgeTraversalPolicy Block -ErrorAction Stop | Out-Null
    }
    $qoriRule = Get-NetFirewallRule -Name $qoriRuleName -ErrorAction Stop
    if ($qoriRule.Enabled -ne 'True' -or $qoriRule.Action -ne 'Allow') { throw 'The firewall rule is not enabled.' }
    if ($StatusPath) { @{success=$true;rule=$qoriRuleName} | ConvertTo-Json | Set-Content -LiteralPath $StatusPath }
    Write-Output 'Qori is allowed on Wi-Fi from the local subnet on TCP port 8787.'
} catch {
    if ($StatusPath) { @{success=$false;error=$_.Exception.Message} | ConvertTo-Json | Set-Content -LiteralPath $StatusPath }
    Write-Error $_
    exit 1
}
