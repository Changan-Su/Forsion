param([ValidateSet('drag','picker','explorer','capture')] [string]$Action,
  [string]$Path, [int]$FromX, [int]$FromY, [int]$ToX, [int]$ToY, [switch]$Close)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Native Clip probe requires a dedicated GitHub Actions desktop' }
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ClipDesktopInput {
  [StructLayout(LayoutKind.Sequential)] struct Mouse { public int x,y; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct Union { [FieldOffset(0)] public Mouse mouse; }
  [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public Union value; }
  [DllImport("user32.dll")] static extern uint SendInput(uint count, Input[] input, int size);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  static void Send(uint flags, int x=0, int y=0) {
    var input = new Input { value = new Union { mouse = new Mouse { x=x,y=y,flags=flags } } };
    if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(Input)))!=1) throw new Exception("Native mouse input refused");
  }
  static void Move(int x,int y) {
    int left=GetSystemMetrics(76),top=GetSystemMetrics(77),width=GetSystemMetrics(78),height=GetSystemMetrics(79);
    Send(0xE001,(int)(((long)x-left)*65536+32768)/width,(int)(((long)y-top)*65536+32768)/height);
  }
  public static void Drag(int x,int y,int endX,int endY) {
    Move(x,y); System.Threading.Thread.Sleep(100); Send(2);
    try {
      System.Threading.Thread.Sleep(120);
      for(int i=1;i<=40;i++) { Move(x+(endX-x)*i/40,y+(endY-y)*i/40); System.Threading.Thread.Sleep(25); }
      System.Threading.Thread.Sleep(300);
    } finally { Send(4); }
  }
}
'@
if ($Action -eq 'drag') { [ClipDesktopInput]::Drag($FromX,$FromY,$ToX,$ToY); exit }
if ($Action -eq 'picker') {
  $dialog = [IntPtr]::Zero
  for ($attempt=0;$attempt -lt 60;$attempt++) {
    $dialog = [ClipDesktopInput]::FindWindow('#32770',$null)
    if ($dialog -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 200
  }
  if ($dialog -eq [IntPtr]::Zero) { throw 'Chrome native folder picker did not appear' }
  [uint32]$dialogPid=0
  [void][ClipDesktopInput]::GetWindowThreadProcessId($dialog,[ref]$dialogPid)
  if ((Get-Process -Id $dialogPid).ProcessName -notmatch 'chrome') { throw 'Folder dialog is not owned by Chrome' }
  [void][ClipDesktopInput]::SetForegroundWindow($dialog)
  if ([ClipDesktopInput]::GetForegroundWindow() -ne $dialog) { throw 'Chrome folder picker did not own foreground; refusing global keys' }
  [System.Windows.Forms.Clipboard]::SetText($Path)
  [System.Windows.Forms.SendKeys]::SendWait('^l')
  Start-Sleep -Milliseconds 200
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Milliseconds 600
  $root=[System.Windows.Automation.AutomationElement]::FromHandle($dialog)
  $buttons=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button))
  $select=$buttons | Where-Object { $_.Current.Name -match '^Select [Ff]older$' } | Select-Object -First 1
  if (-not $select) { throw ('Native Select Folder button not found: '+(($buttons | ForEach-Object {$_.Current.Name}) -join ', ')) }
  $select.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  'Native folder picker accepted the selected directory'
  exit
}
if ($Action -eq 'explorer') {
  $shell=New-Object -ComObject Shell.Application
  $matched=@($shell.Windows() | Where-Object {
    try { $_.Document.Folder.Self.Path.TrimEnd('\') -ieq $Path.TrimEnd('\') } catch { $false }
  })
  $matched | ForEach-Object { if ($Close) { $_.Quit() } }
  @{found=($matched.Count -gt 0);count=$matched.Count} | ConvertTo-Json -Compress
  exit
}
if ($Action -eq 'capture') {
  $size=[System.Windows.Forms.SystemInformation]::VirtualScreen
  $bitmap=[System.Drawing.Bitmap]::new($size.Width,$size.Height)
  try {
    $graphics=[System.Drawing.Graphics]::FromImage($bitmap)
    try { $graphics.CopyFromScreen($size.Left,$size.Top,0,0,$bitmap.Size) } finally { $graphics.Dispose() }
    $bitmap.Save($Path,[System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $bitmap.Dispose() }
}
