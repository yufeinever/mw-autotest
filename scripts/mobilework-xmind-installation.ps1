$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$registryPaths = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
$installed = @(Get-ItemProperty $registryPaths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'XMind' } | Select-Object DisplayName, InstallLocation)
$commands = @(Get-Command xmind -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
$packages = @(Get-AppxPackage -Name '*XMind*' | Select-Object Name, InstallLocation)
@{ installed = $installed; commands = $commands; packages = $packages; checkedSources = @('HKCU/HKLM uninstall registry', 'PATH', 'Current-user Appx packages'); available = ($installed.Count + $commands.Count + $packages.Count -gt 0) } | ConvertTo-Json -Depth 4 -Compress
