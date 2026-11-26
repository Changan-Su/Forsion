using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using System.Runtime.InteropServices;
public static class Issue26 {
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(uint processId);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
  [STAThread] public static void Main(string[] args) {
    string dir = args[0];
    Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    int left = Environment.GetEnvironmentVariable("ISSUE26_SECONDARY") == "1" ? 2640 : 100;
    var target = new Form { Text = "Issue26 Native Target", StartPosition = FormStartPosition.Manual, Bounds = new Rectangle(left,100,640,400), AutoScaleMode = AutoScaleMode.None };
    var cover = new Form { Text = "Issue26 Native Cover", StartPosition = FormStartPosition.Manual, Bounds = new Rectangle(left-12,88,675,435), BackColor = Color.DarkSlateBlue, AutoScaleMode = AutoScaleMode.None };
    var button = new Button { Text = "Issue26 native receipt", Location = new Point(65,55), Size = new Size(255,75) };
    var input = new TextBox { Text = "Initial", AccessibleName = "Issue26 Native Field", Location = new Point(65,150), Width = 255 };
    var status = new Label { Text = "Presses: 0", AutoSize = true, Location = new Point(65,220) };
    int presses = 0, writes = 0, coverPresses = 0;
    uint grantedPid = 0;
    button.Click += (s,e) => { presses++; status.Text = "Presses: " + presses; };
    input.TextChanged += (s,e) => { writes++; };
    cover.MouseDown += (s,e) => { coverPresses++; };
    target.Controls.Add(button); target.Controls.Add(status); target.Controls.Add(input);
    var timer = new Timer { Interval = 20 };
    string previous = "";
    timer.Tick += (s,e) => {
      string commandFile = Path.Combine(dir, "command.txt");
      try { if (File.Exists(commandFile)) {
        string cmd = File.ReadAllText(commandFile).Trim();
        File.Delete(commandFile);
        if (cmd == "cover") { cover.Show(); ShowWindow(cover.Handle, 9); cover.BringToFront(); SetForegroundWindow(cover.Handle); }
        uint requestedPid;
        if (cmd.StartsWith("grant:") && uint.TryParse(cmd.Substring(6), out requestedPid)
            && GetForegroundWindow() == cover.Handle && AllowSetForegroundWindow(requestedPid))
          grantedPid = requestedPid;
        if (cmd == "target") { ShowWindow(target.Handle, 9); target.BringToFront(); SetForegroundWindow(target.Handle); }
        if (cmd == "close") { target.Close(); return; }
      }
      } catch (IOException) {}
      Point cursor; GetCursorPos(out cursor);
      Point buttonPoint = button.PointToScreen(new Point(button.Width/2,button.Height/2));
      var screen = Screen.FromHandle(target.Handle).Bounds;
      string row = String.Format("{{\u0022pid\u0022:{0},\u0022hwnd\u0022:{1},\u0022cover\u0022:{2},\u0022front\u0022:{3},\u0022dpi\u0022:{4},\u0022presses\u0022:{5},\u0022writes\u0022:{6},\u0022coverPresses\u0022:{7},\u0022cursor\u0022:[{8},{9}],\u0022button\u0022:[{10},{11}],\u0022bounds\u0022:[{12},{13},{14},{15}],\u0022screen\u0022:[{16},{17},{18},{19}],\u0022grantedPid\u0022:{20}}}",System.Diagnostics.Process.GetCurrentProcess().Id,target.Handle.ToInt64(),cover.Handle.ToInt64(),GetForegroundWindow().ToInt64(),GetDpiForWindow(target.Handle),presses,writes,coverPresses,cursor.X,cursor.Y,buttonPoint.X,buttonPoint.Y,target.Left,target.Top,target.Width,target.Height,screen.Left,screen.Top,screen.Width,screen.Height,grantedPid);
      if (row != previous) {
        try { File.AppendAllText(Path.Combine(dir,"native.jsonl"), "{\u0022at\u0022:" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + ",\u0022state\u0022:" + row + "}" + Environment.NewLine);
        previous = row; } catch (IOException) {}
      }
    };
    target.Shown += (s,e) => { ShowWindow(target.Handle, 9); cover.Show(); ShowWindow(cover.Handle, 9); cover.BringToFront(); SetForegroundWindow(cover.Handle); timer.Start(); };
    target.FormClosed += (s,e) => { timer.Stop(); cover.Dispose(); };
    Application.Run(target);
  }
}
