$ErrorActionPreference = 'Stop'
$observations = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType = 2 OR DriveType = 3' | Where-Object { $_.Size -gt 0 } | ForEach-Object {
    [pscustomobject]@{ drive = $_.DeviceID; total = [double]$_.Size; free = [double]$_.FreeSpace }
})
ConvertTo-Json -InputObject $observations -Compress
