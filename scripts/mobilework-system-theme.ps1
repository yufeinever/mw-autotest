param([ValidateSet('Read','Set','Restore')][string]$Action='Read',[ValidateSet(0,1)][int]$Value=1,[switch]$Absent)
$ErrorActionPreference='Stop'
$themeKey=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Themes\Personalize',$Action -ne 'Read')
try {
 if($Action -eq 'Set'){$themeKey.SetValue('AppsUseLightTheme',$Value,[Microsoft.Win32.RegistryValueKind]::DWord)}
 if($Action -eq 'Restore'){if($Absent){$themeKey.DeleteValue('AppsUseLightTheme',$false)}else{$themeKey.SetValue('AppsUseLightTheme',$Value,[Microsoft.Win32.RegistryValueKind]::DWord)}}
 $actual=$themeKey.GetValue('AppsUseLightTheme',$null)
} finally {$themeKey.Close()}
if($Action -ne 'Read'){
 Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MobileWorkThemeNotification {
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr window,uint message,IntPtr wParam,string lParam,uint flags,uint timeout,out IntPtr result);
}
'@
 $notification=[IntPtr]::Zero
 $null=[MobileWorkThemeNotification]::SendMessageTimeout([IntPtr]0xffff,0x1a,[IntPtr]::Zero,'ImmersiveColorSet',2,2000,[ref]$notification)
}
@{appsUseLightTheme=$actual}|ConvertTo-Json -Compress
