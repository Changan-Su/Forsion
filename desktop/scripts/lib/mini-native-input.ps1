param([ValidateSet('drag','activate','capture','fixture','click','hotkey','foreground')] [string]$Action,
  [string]$Window, [int]$X, [int]$Y, [int]$Dx, [int]$Dy, [string]$Path, [string]$FrameDir, [string]$BackdropWindow)
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Native Mini input is restricted to a dedicated GitHub runner' }
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:GITHUB_WORKFLOW -ne 'probe-windows-mini-native' -or
    $env:GITHUB_JOB -ne 'native-mini' -or ![Environment]::UserInteractive) {
  throw 'Native Mini input requires the interactive GitHub-hosted Mini workflow'
}
if ($FrameDir) {
  if (!$env:RUNNER_TEMP -or !$BackdropWindow) { throw 'RUNNER_TEMP and the owned backdrop are required to record frames' }
  $tempRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
  $FrameDir = [IO.Path]::GetFullPath($FrameDir)
  if (!$FrameDir.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $FrameDir)) {
    throw 'Frames need a fresh directory under RUNNER_TEMP'
  }
}
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -ReferencedAssemblies System,System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
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
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h,out Rect r);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point p);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint flag);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out Rect r);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int command);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int width,int height,uint flags);
  delegate bool EnumWindow(IntPtr h,IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback,IntPtr parameter);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,System.Text.StringBuilder name,int size);
  public static IntPtr FindOwnedNotepad(uint ownedPid) {
    IntPtr result=IntPtr.Zero;
    EnumWindows((h,p)=>{uint pid;GetWindowThreadProcessId(h,out pid);if(pid!=ownedPid)return true;
      var name=new System.Text.StringBuilder(128);GetClassName(h,name,name.Capacity);
      if(name.ToString()!="Notepad")return true;result=h;return false;},IntPtr.Zero);
    return result;
  }
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
    ShowWindow(new IntPtr(window),9);
    // Expose the owned fixture's caption before the physical click. Showing
    // Forsion in the main panel may have covered Notepad since the last case.
    if(!SetWindowPos(new IntPtr(window),IntPtr.Zero,0,0,0,0,0x13)) throw new Exception("Cannot expose owned fixture caption");
    var h=new IntPtr(window); Rect r; var origin=Resolve(window,0,0);
    if(!GetWindowRect(h,out r)||origin.y<=r.t) throw new Exception("Expected owned native caption");
    Move(r.l+40,r.t+(origin.y-r.t)/2);System.Threading.Thread.Sleep(100);
    Send(2);System.Threading.Thread.Sleep(40);Send(4);
    System.Threading.Thread.Sleep(200);
    if(GetForegroundWindow()!=h) throw new Exception("Owned main window did not receive foreground");
  }
  public sealed class Frame {
    public string phase;
    public int timeMs,x,y,width,height,cursorX,cursorY,roundedCorners,filledSides,lightInterior;
    public bool stableGeometry,clearBackdrop;
  }
  static bool Light(Color pixel) { return pixel.R > 160 && pixel.G > 160 && pixel.B > 160; }
  static int LightInset(Bitmap bitmap,int x,int y,int dx,int dy) {
    for(int i=0;i<24;i++) if(Light(bitmap.GetPixel(x+i*dx,y+i*dy))) return i;
    return 24;
  }
  static bool Rounded(Bitmap bitmap,int x,int y,int dx,int dy) {
    int upper=LightInset(bitmap,x,y+2*dy,dx,0), lower=LightInset(bitmap,x,y+8*dy,dx,0);
    int outer=LightInset(bitmap,x+2*dx,y,0,dy), inner=LightInset(bitmap,x+8*dx,y,0,dy);
    return upper>=3 && upper-lower>=2 && lower<=5 && outer>=3 && outer-inner>=2 && inner<=5;
  }
  static int FilledSides(Bitmap bitmap) {
    int left=0,right=0,top=0,bottom=0;
    for(int i=3;i<=7;i++) {
      int x=bitmap.Width*i/10,y=bitmap.Height*i/10;
      if(Light(bitmap.GetPixel(3,y))) left++;
      if(Light(bitmap.GetPixel(bitmap.Width-4,y))) right++;
      if(Light(bitmap.GetPixel(x,3))) top++;
      if(Light(bitmap.GetPixel(x,bitmap.Height-4))) bottom++;
    }
    return (left>=4?1:0)+(right>=4?1:0)+(top>=4?1:0)+(bottom>=4?1:0);
  }
  static Frame Sample(long window,Rectangle backdrop,string phase,int time,out Bitmap image) {
    var hwnd=new IntPtr(window); Rect client; Point pointer;
    if(!GetClientRect(hwnd,out client)||!GetCursorPos(out pointer)||client.r<=0||client.b<=0) throw new Exception("Cannot sample the owned card");
    var origin=Resolve(window,0,0);
    var frame=new Frame{phase=phase,timeMs=time,x=origin.x,y=origin.y,width=client.r,height=client.b,cursorX=pointer.x,cursorY=pointer.y};
    var card=new Rectangle(frame.x,frame.y,frame.width,frame.height);
    if(!backdrop.Contains(card)) throw new Exception("The capture escaped the owned backdrop");
    var clip=Rectangle.Intersect(Rectangle.Inflate(card,6,6),backdrop);
    var bitmap=new Bitmap(clip.Width,clip.Height);
    try {
      using(var graphics=Graphics.FromImage(bitmap)) graphics.CopyFromScreen(clip.X,clip.Y,0,0,bitmap.Size);
      Rect next; var nextOrigin=Resolve(window,0,0);
      frame.stableGeometry=GetClientRect(hwnd,out next)&&next.r==frame.width&&next.b==frame.height&&nextOrigin.x==origin.x&&nextOrigin.y==origin.y;
      card.Offset(-clip.X,-clip.Y);
      frame.clearBackdrop=true;
      for(int y=0;y<bitmap.Height&&frame.clearBackdrop;y++) {
        bool acrossCard=y>=card.Top&&y<card.Bottom;
        for(int x=0;x<bitmap.Width;x++) {
          if(acrossCard&&x==card.Left) x=card.Right;
          if(x<bitmap.Width&&Light(bitmap.GetPixel(x,y))) { frame.clearBackdrop=false; break; }
        }
      }
      using(var clientImage=bitmap.Clone(card,bitmap.PixelFormat)) {
        foreach(int dx in new[]{1,-1})
          foreach(int dy in new[]{1,-1})
            if(Rounded(clientImage,dx==1?0:frame.width-1,dy==1?0:frame.height-1,dx,dy)) frame.roundedCorners++;
        frame.filledSides=FilledSides(clientImage);
        foreach(int x in new[]{frame.width/4,frame.width/3,frame.width/2,2*frame.width/3,3*frame.width/4})
          foreach(int y in new[]{frame.height/4,frame.height/3,frame.height/2,2*frame.height/3,3*frame.height/4})
            if(Light(clientImage.GetPixel(x,y))) frame.lightInterior++;
      }
    } catch { bitmap.Dispose(); throw; }
    image=bitmap;
    return frame;
  }
  sealed class Recorder {
    readonly long window;
    readonly Rectangle backdrop;
    readonly string frameDir;
    readonly Thread thread;
    readonly List<Frame> frames=new List<Frame>();
    readonly List<Bitmap> images=new List<Bitmap>();
    volatile bool stop;
    public volatile string phase="before";
    Exception failure;
    public Recorder(long window,long backdropWindow,string frameDir) {
      this.window=window; this.frameDir=frameDir;
      Rect size; uint owner,backdropOwner;
      GetWindowThreadProcessId(new IntPtr(window),out owner);
      GetWindowThreadProcessId(new IntPtr(backdropWindow),out backdropOwner);
      if(owner==0||owner!=backdropOwner||window==backdropWindow||!GetClientRect(new IntPtr(backdropWindow),out size))
        throw new Exception("The capture requires an owned backdrop for the Mini");
      var origin=Resolve(backdropWindow,0,0);
      backdrop=new Rectangle(origin.x,origin.y,size.r,size.b);
      Directory.CreateDirectory(frameDir);
      thread=new Thread(Capture) { IsBackground=true };
      thread.Start();
    }
    void Capture() {
      var watch=Stopwatch.StartNew();
      SetThreadDpiAwarenessContext(new IntPtr(-4));
      try {
        while(!stop && frames.Count<160) {
          int start=(int)watch.ElapsedMilliseconds;
          Bitmap image;
          frames.Add(Sample(window,backdrop,phase,start,out image));
          images.Add(image);
          int delay=16-(int)watch.ElapsedMilliseconds+start;
          if(delay>0) Thread.Sleep(delay);
        }
      } catch(Exception error) { failure=error; }
    }
    public Frame[] Finish() {
      stop=true;
      if(!thread.Join(2000)) throw new Exception("Mini compositor capture could not stop");
      try {
        if(failure!=null) throw failure;
        for(int i=0;i<frames.Count;i++) images[i].Save(Path.Combine(frameDir,i.ToString("000")+"-"+frames[i].phase+".png"),ImageFormat.Png);
        return frames.ToArray();
      } finally { foreach(var image in images) image.Dispose(); }
    }
  }
  static void RequireMiniAtPointer(long window) {
    Point actual;
    if(!GetCursorPos(out actual)||GetAncestor(WindowFromPoint(actual),2)!=new IntPtr(window))
      throw new Exception("Mouse down must hit the owned Mini window");
  }
  public static Frame[] Drag(long window,int x,int y,int dx,int dy,string frameDir,long backdrop) {
    var start=Resolve(window,x,y); var end=Resolve(window,x+dx,y+dy);
    Move(start.x,start.y);
    Thread.Sleep(120);
    RequireMiniAtPointer(window);
    Recorder recorder=String.IsNullOrWhiteSpace(frameDir)?null:new Recorder(window,backdrop,frameDir);
    Frame[] frames=null;
    try {
      if(recorder!=null) Thread.Sleep(160);
      RequireMiniAtPointer(window);
      Send(2);
      try {
        Thread.Sleep(150);
        if(recorder!=null) recorder.phase="drag";
        for(int i=1;i<=24;i++) {
          Move(start.x+(end.x-start.x)*i/24,start.y+(end.y-start.y)*i/24);
          Thread.Sleep(25);
        }
        Thread.Sleep(150);
        if(recorder!=null) {
          recorder.phase="clamped";
          for(int i=0;i<12;i++) {
            int wiggle=i%2==0 ? -6 : 6;
            Move(end.x+wiggle,end.y+wiggle);
            Thread.Sleep(35);
          }
        }
      } finally { Send(4); }
      if(recorder!=null) { recorder.phase="released"; Thread.Sleep(200); }
    } finally { if(recorder!=null) frames=recorder.Finish(); }
    return frames??new Frame[0];
  }
  public static void Click(long window,int x,int y) {
    var p=Resolve(window,x,y);Move(p.x,p.y);System.Threading.Thread.Sleep(100);
    Send(2);System.Threading.Thread.Sleep(40);Send(4);
  }
  public static bool IsForeground(long window) {return GetForegroundWindow()==new IntPtr(window);}
}
'@
if ($Action -eq 'fixture') {
  $fixture=Start-Process -FilePath (Join-Path $env:WINDIR 'System32/notepad.exe') -WindowStyle Hidden -PassThru
  for($i=0;$i -lt 60;$i++) {
    $fixtureWindow=[MiniNativeInput]::FindOwnedNotepad($fixture.Id)
    if($fixtureWindow -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 100
  }
  if($fixtureWindow -eq [IntPtr]::Zero) { throw 'Owned Notepad fixture window missing' }
  [void][MiniNativeInput]::ShowWindow($fixtureWindow,9)
  @{pid=$fixture.Id;hwnd=$fixtureWindow.ToInt64().ToString()} | ConvertTo-Json -Compress
  exit
}
if ($Action -eq 'activate') { [MiniNativeInput]::Activate([long]::Parse($Window)) }
if ($Action -eq 'drag') {
  $frames=[MiniNativeInput]::Drag([long]::Parse($Window),$X,$Y,$Dx,$Dy,$FrameDir,[long]$BackdropWindow)
  if ($FrameDir) { ConvertTo-Json -Compress -Depth 3 -InputObject @($frames) }
}
if ($Action -eq 'click') { [MiniNativeInput]::Click([long]::Parse($Window),$X,$Y) }
if ($Action -eq 'foreground') { [MiniNativeInput]::IsForeground([long]::Parse($Window)) }
if ($Action -eq 'hotkey') {
  [MiniNativeInput]::Activate([long]::Parse($Window))
  [System.Windows.Forms.SendKeys]::SendWait('^+m')
}
if ($Action -eq 'capture') {
  $r=[System.Windows.Forms.SystemInformation]::VirtualScreen
  $b=[System.Drawing.Bitmap]::new($r.Width,$r.Height)
  try {
    $g=[System.Drawing.Graphics]::FromImage($b)
    try {$g.CopyFromScreen($r.Left,$r.Top,0,0,$b.Size)} finally {$g.Dispose()}
    $b.Save($Path,[System.Drawing.Imaging.ImageFormat]::Png)
  } finally {$b.Dispose()}
}
