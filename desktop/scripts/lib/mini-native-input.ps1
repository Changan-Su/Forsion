param([ValidateSet('drag','activate','capture')] [string]$Action,
  [string]$Window, [int]$X, [int]$Y, [int]$Dx, [int]$Dy, [string]$Path)
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Native Mini input is restricted to a dedicated GitHub runner' }
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MiniNativeInput {
  [StructLayout(LayoutKind.Sequential)] struct Point { public int x,y; }
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int l,t,r,b; }
  [StructLayout(LayoutKind.Sequential)] struct Mouse { public int x,y; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct Union { [FieldOffset(0)] public Mouse mouse; }
  [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public Union value; }
  [DllImport("user32.dll")] static extern uint SendInput(uint count, Input[] input, int size);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int n);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h,ref Point p);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out Rect r);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  static void Send(uint flags,int x=0,int y=0) {
    var input=new Input{value=new Union{mouse=new Mouse{x=x,y=y,flags=flags}}};
    if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(Input)))!=1) throw new Exception("SendInput refused");
  }
  static void Move(int x,int y) {
    Send(0xE001,(int)(((long)x-GetSystemMetrics(76))*65536+32768)/GetSystemMetrics(78),
      (int)(((long)y-GetSystemMetrics(77))*65536+32768)/GetSystemMetrics(79));
  }
  static Point Resolve(long window,int x,int y) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    var h=new IntPtr(window); double scale=GetDpiForWindow(h)/96.0;
    var p=new Point{x=(int)Math.Round(x*scale),y=(int)Math.Round(y*scale)};
    if(!ClientToScreen(h,ref p)) throw new Exception("Owned window origin unavailable");
    return p;
  }
  public static void Activate(long window) {
    var h=new IntPtr(window); Rect r; var origin=Resolve(window,0,0);
    if(!GetWindowRect(h,out r)||origin.y<=r.t) throw new Exception("Expected owned native caption");
    Move(r.l+40,r.t+(origin.y-r.t)/2); Send(2); Send(4);
    System.Threading.Thread.Sleep(200);
    if(GetForegroundWindow()!=h) throw new Exception("Owned main window did not receive foreground");
  }
  public static void Drag(long window,int x,int y,int dx,int dy) {
    var start=Resolve(window,x,y); var end=Resolve(window,x+dx,y+dy);
    Move(start.x,start.y); System.Threading.Thread.Sleep(120); Send(2);
    try {
      System.Threading.Thread.Sleep(150);
      for(int i=1;i<=24;i++) {Move(start.x+(end.x-start.x)*i/24,start.y+(end.y-start.y)*i/24);System.Threading.Thread.Sleep(25);}
      System.Threading.Thread.Sleep(150);
    } finally {Send(4);}
  }
}
'@
if ($Action -eq 'activate') { [MiniNativeInput]::Activate([long]::Parse($Window)) }
if ($Action -eq 'drag') { [MiniNativeInput]::Drag([long]::Parse($Window),$X,$Y,$Dx,$Dy) }
if ($Action -eq 'capture') {
  $r=[System.Windows.Forms.SystemInformation]::VirtualScreen
  $b=[System.Drawing.Bitmap]::new($r.Width,$r.Height)
  try {
    $g=[System.Drawing.Graphics]::FromImage($b)
    try {$g.CopyFromScreen($r.Left,$r.Top,0,0,$b.Size)} finally {$g.Dispose()}
    $b.Save($Path,[System.Drawing.Imaging.ImageFormat]::Png)
  } finally {$b.Dispose()}
}
