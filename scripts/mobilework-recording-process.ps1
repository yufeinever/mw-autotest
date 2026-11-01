param(
 [ValidateSet('Client','Recorder','Probe')][string]$Action,
 [Parameter(Mandatory=$true)][int]$ClientPid,
 [int]$RecorderPid=0,
 [int]$Port=18002
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
function Identity($Process) {
 @{pid=[int]$Process.ProcessId;executable=$Process.ExecutablePath;created=$Process.CreationDate.ToUniversalTime().ToString('o')}
}
$client=Get-CimInstance Win32_Process -Filter "ProcessId=$ClientPid"
if(-not $client){throw 'Registered MobileWork process is gone'}
if($Action -eq 'Client'){@{client=(Identity $client)}|ConvertTo-Json -Depth 4 -Compress;exit}
$listeners=@(Get-NetTCPConnection -State Listen | Where-Object {$_.LocalPort -eq $Port} | Select-Object -ExpandProperty OwningProcess -Unique)
if($Action -eq 'Probe' -and $listeners.Count -eq 0){@{client=(Identity $client);recorder=$null;port=$Port}|ConvertTo-Json -Depth 4 -Compress;exit}
if($listeners.Count -ne 1){throw 'Recorder has no unique listening process'}
if($RecorderPid -and $listeners[0] -ne $RecorderPid){throw 'Recorder port belongs to another process'}
$recorder=Get-CimInstance Win32_Process -Filter "ProcessId=$($listeners[0])"
if(-not $recorder){throw 'Recorder process is gone'}
$cursor=$recorder
$seen=[Collections.Generic.HashSet[int]]::new()
while($cursor.ProcessId -ne $ClientPid){
 if(-not $seen.Add([int]$cursor.ProcessId)){throw 'Recorder process ancestry is cyclic'}
 $parent=Get-CimInstance Win32_Process -Filter "ProcessId=$($cursor.ParentProcessId)"
 if(-not $parent -or $parent.CreationDate -gt $cursor.CreationDate){throw 'Recorder is not a current MobileWork descendant'}
 $cursor=$parent
}
# Read only the entry script path, never emit the full command or environment.
$entry=[regex]::Match($recorder.CommandLine,'(?:"([^"\r\n]+[\\/]main\.py)"|([^\s"]+[\\/]main\.py))')
if(-not $entry.Success){throw 'Cannot identify the product recorder entry script'}
$entryPath=if($entry.Groups[1].Success){$entry.Groups[1].Value}else{$entry.Groups[2].Value}
$packageRoot=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($entryPath))
if(-not (Test-Path -LiteralPath (Join-Path $packageRoot 'manifest.json') -PathType Leaf)){throw 'Actual recorder package has no manifest'}
@{client=(Identity $client);recorder=(Identity $recorder);port=$Port;packageRoot=$packageRoot}|ConvertTo-Json -Depth 4 -Compress
