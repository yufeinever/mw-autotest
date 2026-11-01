param(
 [ValidateSet('Baseline','Open','Inspect','Reset','Calculate','CalculateKeys','Close')][string]$Action='Baseline',
 [long]$Hwnd=0,
 [int]$PidValue=0,
 [string]$Created='',
 [string]$Baseline='[]'
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MobileWorkCalculatorWindow {
 [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int x; public int y; public uint data; public uint flags; public uint time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT keyboard; [FieldOffset(0)] public MOUSEINPUT mouse; }
 [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION value; }
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool PostMessage(IntPtr hwnd,uint message,IntPtr wParam,IntPtr lParam);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll",SetLastError=true)] public static extern uint SendInput(uint count,INPUT[] inputs,int size);
 public static bool Key(ushort vk) {
  INPUT down=new INPUT(); down.type=1; down.value.keyboard.vk=vk;
  INPUT up=down; up.value.keyboard.flags=2;
  return SendInput(2,new INPUT[]{down,up},Marshal.SizeOf(typeof(INPUT)))==2;
 }
}
'@
$condition=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Window)
function CalculatorWindows {
 $result=@()
 foreach($window in [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,$condition)){
  if($window.Current.Name -notmatch '计算器|Calculator'){continue}
  $button=$window.FindFirst([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty,'num1Button'))
  if(-not $button){continue}
  $process=Get-CimInstance Win32_Process -Filter "ProcessId=$($button.Current.ProcessId)"
  if(-not $process -or [IO.Path]::GetFileName($process.ExecutablePath) -notin @('CalculatorApp.exe','Calculator.exe')){continue}
  $result+=@{hwnd=[long]$window.Current.NativeWindowHandle;pid=[int]$process.ProcessId;created=$process.CreationDate.ToUniversalTime().ToString('o');title=$window.Current.Name}
 }
 return $result
}
if($Action -eq 'Baseline'){@{windows=@(CalculatorWindows)}|ConvertTo-Json -Depth 5 -Compress;exit}
if($Action -eq 'Open'){
 $before=@(ConvertFrom-Json $Baseline)
 # The app window is the test subject and must be visible for real recording.
 Start-Process -FilePath calc.exe -WindowStyle Normal
 $deadline=[DateTime]::UtcNow.AddSeconds(15)
 do{
  $added=@(CalculatorWindows|Where-Object {$_.hwnd -notin $before})
  if($added.Count -eq 1){$added[0]|ConvertTo-Json -Compress;exit}
  if($added.Count -gt 1){throw 'Multiple new Calculator windows; ownership is ambiguous'}
  Start-Sleep -Milliseconds 200
 }while([DateTime]::UtcNow -lt $deadline)
 throw 'No uniquely owned Calculator window appeared'
}
if(-not [MobileWorkCalculatorWindow]::IsWindow([IntPtr]$Hwnd)){
 if($Action -eq 'Close'){@{closed=$true;alreadyGone=$true}|ConvertTo-Json -Compress;exit}
 throw 'Registered Calculator window is gone'
}
$actual=@(CalculatorWindows|Where-Object {$_.hwnd -eq $Hwnd -and $_.pid -eq $PidValue -and $_.created -eq $Created})
if($actual.Count -ne 1){throw 'Calculator process, creation time, or HWND no longer matches'}
$window=[Windows.Automation.AutomationElement]::FromHandle([IntPtr]$Hwnd)
function Control($Id){
 $items=$window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty,$Id))
 if($items.Count -ne 1){throw "Calculator control is not unique: $Id"}
 return $items[0]
}
if($Action -eq 'Close'){
 if(-not [MobileWorkCalculatorWindow]::PostMessage([IntPtr]$Hwnd,0x10,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'Calculator did not accept WM_CLOSE'}
 $deadline=[DateTime]::UtcNow.AddSeconds(3)
 while([MobileWorkCalculatorWindow]::IsWindow([IntPtr]$Hwnd) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 50}
 @{closed=(-not [MobileWorkCalculatorWindow]::IsWindow([IntPtr]$Hwnd))}|ConvertTo-Json -Compress;exit
}
$steps=@()
if($Action -eq 'Reset'){
 $element=Control 'clearButton'
 $element.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
 $steps+=@{automationId='clearButton';method='UIA.Invoke';name=$element.Current.Name}
}
if($Action -eq 'Calculate'){
 foreach($id in @('clearButton','num1Button','num2Button','num3Button','num4Button','num5Button','num6Button','num7Button','num8Button','num9Button','minusButton','num1Button','equalButton')){
  $element=Control $id
  $invoke=$element.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
  $invoke.Invoke()
  $steps+=@{automationId=$id;method='UIA.Invoke';name=$element.Current.Name}
 }
}
if($Action -eq 'CalculateKeys'){
 if(-not [MobileWorkCalculatorWindow]::SetForegroundWindow([IntPtr]$Hwnd)){throw 'Calculator cannot own foreground input'}
 (Control 'num1Button').SetFocus()
 $keys=@(@{key='Escape';vk=0x1b},@{key='1';vk=0x31},@{key='2';vk=0x32},@{key='3';vk=0x33},@{key='4';vk=0x34},@{key='5';vk=0x35},@{key='6';vk=0x36},@{key='7';vk=0x37},@{key='8';vk=0x38},@{key='9';vk=0x39},@{key='Subtract';vk=0x6d},@{key='1';vk=0x31},@{key='Enter';vk=0x0d})
 foreach($key in $keys){
  if([MobileWorkCalculatorWindow]::GetForegroundWindow() -ne [IntPtr]$Hwnd -or [Windows.Automation.AutomationElement]::FocusedElement.Current.ProcessId -ne $PidValue){throw 'Calculator lost keyboard ownership; no further keys sent'}
  if(-not [MobileWorkCalculatorWindow]::Key([ushort]$key.vk)){throw 'Win32 did not accept the Calculator key event'}
  $steps+=@{key=$key.key;method='Win32.SendInput'}
 }
}
$display=(Control 'CalculatorResults').Current.Name
if($Action -in @('Reset','Calculate','CalculateKeys')){
 $expected=if($Action -eq 'Reset'){'0'}else{'123456788'}
 $deadline=[DateTime]::UtcNow.AddSeconds(3)
 while(($display -replace '[^0-9-]','') -ne $expected -and [DateTime]::UtcNow -lt $deadline){
  Start-Sleep -Milliseconds 50
  $display=(Control 'CalculatorResults').Current.Name
 }
}
@{window=$actual[0];display=$display;steps=$steps;launchMethod='calc.exe (not Start menu)'}|ConvertTo-Json -Depth 5 -Compress
