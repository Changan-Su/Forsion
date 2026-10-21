param([ValidateSet('activate','click','drag','picker','explorer','capture')] [string]$Action,
  [string]$Path, [int]$FromX, [int]$FromY, [int]$ToX, [int]$ToY, [string]$FromWindow, [switch]$Close)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Native Clip probe requires a dedicated GitHub Actions desktop' }
$OutputEncoding=[System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=$OutputEncoding
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ClipDesktopInput {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x,y; }
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int left,top,right,bottom; }
  [StructLayout(LayoutKind.Sequential)] struct Mouse { public int x,y; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct Union { [FieldOffset(0)] public Mouse mouse; }
  [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public Union value; }
  [DllImport("user32.dll")] static extern uint SendInput(uint count, Input[] input, int size);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd,ref Point point);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
  [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr dialog,int id);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,System.Text.StringBuilder text,int length);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern uint GetLongPathName(string path,System.Text.StringBuilder result,uint length);
  public static string LongPath(string path) {
    var result=new System.Text.StringBuilder(32768);
    uint length=GetLongPathName(path,result,(uint)result.Capacity);
    return (length>0&&length<result.Capacity?result.ToString():path).TrimEnd('\\');
  }
  public static Point ClientPoint(long window,int x,int y) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    var hwnd=new IntPtr(window); double scale=GetDpiForWindow(hwnd)/96.0;
    var point=new Point{x=(int)Math.Round(x*scale),y=(int)Math.Round(y*scale)};
    if(!ClientToScreen(hwnd,ref point)) throw new Exception("Cannot resolve owned window client origin");
    return point;
  }
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
  public static void Click(int x,int y) { Move(x,y); System.Threading.Thread.Sleep(80); Send(2); Send(4); }
  public static void ActivateCaption(long window) {
    var point=ClientPoint(window,0,0); Rect rect; var hwnd=new IntPtr(window);
    if(!GetWindowRect(hwnd,out rect)||point.y<=rect.top) throw new Exception("Owned settings window has no native caption");
    Click((rect.left+rect.right)/2,rect.top+(point.y-rect.top)/2);
    System.Threading.Thread.Sleep(200);
    if(GetForegroundWindow()!=hwnd) throw new Exception("Owned settings caption did not activate its window");
  }
  public static string SelectFolder(long window) {
    var dialog=new IntPtr(window);var button=GetDlgItem(dialog,1);
    var title=new System.Text.StringBuilder(256);GetWindowText(button,title,title.Capacity);
    string label=title.ToString().Replace("&","").Trim();Rect rect;
    if(button==IntPtr.Zero||label!="Select Folder"||!IsWindowVisible(button)||!IsWindowEnabled(button)||!GetWindowRect(button,out rect))
      throw new Exception("Owned native IDOK is not a visible enabled Select Folder button: "+title);
    if(GetForegroundWindow()!=dialog) throw new Exception("Owned folder picker lost foreground before Select Folder");
    Click((rect.left+rect.right)/2,(rect.top+rect.bottom)/2);
    return label;
  }
}
'@
if ($Action -eq 'activate') { [ClipDesktopInput]::ActivateCaption([long]::Parse($FromWindow)); exit }
if ($FromWindow) {
  $point=[ClipDesktopInput]::ClientPoint([long]::Parse($FromWindow),$FromX,$FromY)
  $FromX=$point.x; $FromY=$point.y
}
if ($Action -eq 'click') { [ClipDesktopInput]::Click($FromX,$FromY); exit }
if ($Action -eq 'drag') { [ClipDesktopInput]::Drag($FromX,$FromY,$ToX,$ToY); exit }
if ($Action -eq 'picker') {
  $dialog = [IntPtr]::Zero
  $candidates = @()
  for ($attempt=0;$attempt -lt 60;$attempt++) {
    # Other runner processes can own #32770 windows. Select by Chrome ownership
    # before committing to a candidate, rather than rejecting the first window.
    $candidates = @()
    $candidate = [IntPtr]::Zero
    while ($true) {
      # A genuine null title is required; PowerShell's $null becomes "".
      $candidate = [ClipDesktopInput]::FindWindowEx([IntPtr]::Zero,$candidate,'#32770',[System.Management.Automation.Language.NullString]::Value)
      if ($candidate -eq [IntPtr]::Zero) { break }
      if (-not [ClipDesktopInput]::IsWindowVisible($candidate)) { continue }
      [uint32]$candidatePid=0
      [void][ClipDesktopInput]::GetWindowThreadProcessId($candidate,[ref]$candidatePid)
      $owner = Get-Process -Id $candidatePid -ErrorAction SilentlyContinue
      if ($owner -and $owner.ProcessName -ieq 'chrome') { $candidates += $candidate }
    }
    $foreground = [ClipDesktopInput]::GetForegroundWindow()
    if ($candidates -contains $foreground) { $dialog = $foreground }
    elseif ($candidates.Count -eq 1) { $dialog = $candidates[0] }
    if ($dialog -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 200
  }
  if ($dialog -eq [IntPtr]::Zero) { throw "Chrome native folder picker was absent or ambiguous (visible Chrome dialogs: $($candidates.Count))" }
  [uint32]$dialogPid=0
  [void][ClipDesktopInput]::GetWindowThreadProcessId($dialog,[ref]$dialogPid)
  if ((Get-Process -Id $dialogPid).ProcessName -ine 'chrome') { throw 'Folder dialog is not owned by Chrome' }
  [void][ClipDesktopInput]::SetForegroundWindow($dialog)
  if ([ClipDesktopInput]::GetForegroundWindow() -ne $dialog) { throw 'Chrome folder picker did not own foreground; refusing global keys' }
  [System.Windows.Forms.Clipboard]::SetText($Path)
  [System.Windows.Forms.SendKeys]::SendWait('^l')
  Start-Sleep -Milliseconds 200
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Milliseconds 600
  # UIA's control view omits the classic IDOK/Cancel controls on this dialog.
  # Read the real HWND/button label, then physically click its screen rectangle.
  [ClipDesktopInput]::SelectFolder($dialog.ToInt64())
  exit
}
if ($Action -eq 'explorer') {
  $shell=New-Object -ComObject Shell.Application
  $expected=[ClipDesktopInput]::LongPath($Path)
  $seen=@(); $matched=@()
  foreach($window in $shell.Windows()) {
    try {
      $actual=[string]$window.Document.Folder.Self.Path
      $canonical=[ClipDesktopInput]::LongPath($actual)
      $seen+=@{path=$actual;canonical=$canonical;hwnd=$window.HWND}
      if($canonical -ieq $expected) { $matched+= $window }
    } catch { $seen+=@{error=$_.Exception.Message} }
  }
  $matched | ForEach-Object { if ($Close) { $_.Quit() } }
  @{found=($matched.Count -gt 0);count=$matched.Count;expected=$expected;windows=$seen} | ConvertTo-Json -Depth 4 -Compress
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
