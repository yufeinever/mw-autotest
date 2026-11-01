param([ValidateSet('Create','Deny','Restore')][string]$Action,[string]$Path,[string]$Sddl)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$directory=[IO.Path]::GetFullPath($Path)
if ([IO.Path]::GetFileName($directory) -notmatch '^MW-AUTOTEST-DENY-[a-f0-9-]{36}$') { throw '仅允许本轮隔离拒写目录' }
if ($Action -eq 'Create') {
 if ([IO.Directory]::Exists($directory)) { throw '拒写目录已存在，未接管' }
 $null=[IO.Directory]::CreateDirectory($directory)
 @{path=$directory;sddl=([IO.DirectoryInfo]::new($directory).GetAccessControl()).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)}|ConvertTo-Json -Compress
 exit
}
$info=[IO.DirectoryInfo]::new($directory)
$acl=$info.GetAccessControl()
if ($Action -eq 'Deny') {
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
 $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::Write,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Deny)
 $acl.AddAccessRule($rule)
 $info.SetAccessControl($acl)
 $probe=Join-Path $directory '独立拒写核验.txt'
 $denied=$false
 try {[IO.File]::WriteAllText($probe,'synthetic')} catch [UnauthorizedAccessException] {$denied=$true}
 if (-not $denied) {[IO.File]::Delete($probe);throw '未形成真实不可写前置'}
 @{path=$directory;writeDenied=$true}|ConvertTo-Json -Compress
} else {
 $acl.SetSecurityDescriptorSddlForm($Sddl)
 $info.SetAccessControl($acl)
 if (($info.GetAccessControl()).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All) -ne $Sddl) {throw '原目录ACL恢复未确认'}
 @{restored=$true}|ConvertTo-Json -Compress
}
