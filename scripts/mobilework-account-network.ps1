param(
 [Parameter(Mandatory=$true)][ValidateSet('process','inspect','apply','remove')][string]$Mode,
 [int]$ClientPid,
 [string]$RuleName,
 [string]$Program,
 [string]$Addresses,
 [int]$RemotePort
)
$ErrorActionPreference = 'Stop'
if ($Mode -eq 'process') {
 $client = Get-CimInstance Win32_Process -Filter "ProcessId = $ClientPid"
 if (-not $client.ExecutablePath -or [IO.Path]::GetFileName($client.ExecutablePath) -ine 'MobileWork.exe') { throw 'Connected process is not MobileWork.exe' }
 $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
 $principal = [Security.Principal.WindowsPrincipal]::new($identity)
 @{ pid=$ClientPid; program=$client.ExecutablePath; administrator=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } | ConvertTo-Json -Compress
 exit
}
if ($RuleName -notmatch '^MW-Autotest-Network-169-[a-f0-9-]{36}$' -or [IO.Path]::GetFileName($Program) -ine 'MobileWork.exe' -or -not [IO.Path]::IsPathRooted($Program) -or $RemotePort -lt 1 -or $RemotePort -gt 65535) { throw 'Invalid owned network rule' }
$expected = @($Addresses.Split(',') | ForEach-Object { [Net.IPAddress]::Parse($_).ToString() } | Sort-Object -Unique)
if (-not $expected.Count) { throw 'No portal address supplied' }
$rule = Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue
if ($Mode -eq 'apply') {
 if ($rule) { throw 'Owned rule name already exists; no existing rule was changed' }
 $client = Get-CimInstance Win32_Process -Filter "ProcessId = $ClientPid"
 if ($client.ExecutablePath -ine $Program) { throw 'Client process identity changed' }
 New-NetFirewallRule -Name $RuleName -DisplayName $RuleName -Group 'MobileWorkAutotest' -Program $Program -Direction Outbound -Action Block -Enabled True -Profile Any -Protocol TCP -RemoteAddress $expected -RemotePort $RemotePort | Out-Null
 $rule = Get-NetFirewallRule -Name $RuleName
}
if ($rule) {
 $app = $rule | Get-NetFirewallApplicationFilter
 $address = $rule | Get-NetFirewallAddressFilter
 $port = $rule | Get-NetFirewallPortFilter
 $actual = @($address.RemoteAddress | ForEach-Object { [Net.IPAddress]::Parse($_).ToString() } | Sort-Object -Unique)
 if (@($rule).Count -ne 1 -or $rule.DisplayName -ne $RuleName -or $rule.Group -ne 'MobileWorkAutotest' -or $app.Program -ine $Program -or $rule.Direction -ne 'Outbound' -or $rule.Action -ne 'Block' -or $rule.Enabled -ne 'True' -or $port.Protocol -notin @('TCP','6') -or [string]$port.RemotePort -ne [string]$RemotePort -or ($expected -join ',') -ne ($actual -join ',')) { throw 'Rule no longer matches its registered scope; preserved' }
}
if ($Mode -eq 'remove' -and $rule) {
 $rule | Remove-NetFirewallRule
 if (Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue) { throw 'Owned rule removal not confirmed' }
}
@{ exists=([bool]$rule -and $Mode -ne 'remove'); removed=($Mode -eq 'remove'); scopeVerified=[bool]$rule } | ConvertTo-Json -Compress
