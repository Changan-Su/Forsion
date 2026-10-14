/**
 * 应用 / 窗口引用的 Windows 半身(契约见 shared/appRefs.ts,macOS 半身见 appRefs.ts)。
 * 不靠电脑操作的本机助手(那是可选插件):只用系统自带的 Windows PowerShell 5.1 + user32 / kernel32 / shell32。
 *
 * ── 一、应用标识(会写进用户的笔记和消息,定了就不能改)──────────────────────────────
 *   传统应用  = exe 文件名,小写,百分号编码      chrome.exe / notepad%2B%2B.exe / adobe%20premiere%20pro.exe
 *   打包应用  = AUMID(包族名!应用号),小写,百分号编码   microsoft.windowscalculator_8wekyb3d8bbwe%21app
 *  为什么是这两样:
 *   · 窗口那侧天然拿得到的就是「属主进程的 exe」(电脑操作助手在 Windows 上报的也是 processName = exe 文件名、
 *     windowId = HWND,没有 AUMID 这个概念;电脑历史的排除名单同样按小写 exe 名)。开始菜单那侧把快捷方式解到
 *     目标 exe,两边就对上了 —— 同一个应用「列成应用」和「当窗口属主」得到同一个标识。
 *   · 不用完整路径:带用户名、带版本号目录(Squirrel 的 app-1.2.3、WindowsApps 的包全名),升级一次就变,
 *     换台电脑也对不上;exe 名在同一用户的几台 Windows 上是通的(笔记会同步)。
 *   · 传统应用不用 AUMID:窗口 → AUMID 要还原任务栏那套规则(窗口属性 > 进程显式设置 > 按路径推),
 *     进程显式设的那个从外面读不到,开始菜单一个 exe 又常有好几条(Chrome 的网页应用、带参数的变体),对不稳。
 *   · 打包应用(UWP / MSIX)反过来:exe 在 WindowsApps 下,按路径起不来,能启动它的只有 AUMID;
 *     UWP 的窗口还挂在 ApplicationFrameHost.exe 名下,exe 名根本不是它。所以这一类用 AUMID。
 *     判定是确定的、不看开始菜单扫没扫到:窗口类是 ApplicationFrameWindow(取窗口属性里的 AUMID,取不到再看
 *     里面那层 CoreWindow 的进程)→ AUMID;进程有包身份**且** exe 在 \WindowsApps\ 下 → AUMID;其余 → exe 名。
 *     (只注册了「稀疏包」的传统应用也有包身份,但 exe 在普通目录、开始菜单里是普通快捷方式,按 exe 名才对得上。)
 *   · ApplicationFrameHost.exe 永远不当标识:认不出里面是谁的那扇窗口直接丢掉,不会产出「启动 ApplicationFrameHost」的引用。
 *   · 手上只有某个进程的 exe 路径时(比如本机助手推来的事件),标识一律经 winAppIdOf(exePath, aumid?) 算,别自己拼。
 *  语法(shared/appRefs.ts 的 ID_RE):在原来的 [A-Za-z0-9._-] 之外只多了 `%XX`(两位大写十六进制)。
 *   空白、`|`、`[`、`]`、引号、反斜杠、`!` 等一律以转义形态出现;macOS 的 bundle id 原样合法。
 *   比较不分大小写(进来的标识先解码、小写、重新编码成规范形)。
 *  标识不上命令行:它只当查表的键。启动用的是系统自己给的 AUMID / 快捷方式 / exe 路径(开始菜单扫描、
 *   注册表 App Paths、这次运行里见过的进程),切窗口用的是我们自己列出来的 HWND + pid。
 *
 * ── 二、怎么列 ──────────────────────────────────────────────────────────────
 *   窗口 + 进程:一段常量脚本(PS_NATIVE)现编一小段 C#,EnumWindows 按前后顺序走一遍可见的顶层窗口,
 *     带回标题、类名、扩展样式、有没有属主窗口、是否被 DWM 藏起(cloaked)、是否最小化;进程给 exe 路径、
 *     包身份、文件说明。脚本只管照实报,「算不算 Alt-Tab 里的窗口、它是哪个应用」在 TS 里判(resolveWinView,
 *     有夹具测试)。list / status / frontmost 各只起一次 PowerShell,同时到的请求合成一次。
 *     ponytail: 每起一次要几百毫秒到一秒多(进程启动 + 现编 C#),这一版认了;要再快就换成常驻的小进程只管「列」
 *     (「提窗口」仍得每次现起,理由见三),或把编好的程序集缓存到磁盘 —— 接缝形状都不用变。
 *   已安装的应用:另一段常量脚本(PS_SHELL)读 shell:AppsFolder(开始菜单「所有应用」:本地化的名字 + AUMID +
 *     快捷方式目标),再扫一遍开始菜单的 .lnk 和注册表 App Paths 作补充。慢(秒级),所以缓存:60 秒内直接用,
 *     过期了先用旧的、后台刷新,10 分钟以上才等。
 *
 * ── 三、启动 / 切过去 ──────────────────────────────────────────────────────────
 *   Windows 没有 `open -b` 那种「没开就开、开着就切」的命令,再启动一次 exe 多半是多开一个窗口 / 实例。所以:
 *     窗口引用、窗口还在 → 只提那扇窗口;窗口没了 → 按应用处理。
 *     应用在跑且有窗口 → 提它最前面那扇;没有窗口(或没在跑)→ 才启动。
 *   提窗口(Focus):最小化的先还原,SetForegroundWindow,然后**看结果**(GetForegroundWindow 是不是它或它名下的弹窗),
 *     不信 API 的返回值。前台锁的规矩(SetForegroundWindow 文档):允许抢前台的条件之一是「调用进程由前台进程
 *     启动」—— 用户刚点了 Forsion 里的芯片,这次点击现起的 PowerShell 正是前台进程的孩子,所以每次点击都新起
 *     一个进程来做这件事(早先起好、一直留着的进程不保证还有这个资格)。不成再试两招:先发一个不移动的
 *     鼠标输入(切窗口工具里常见的做法:刚发过输入的进程会被放行),再不成 AttachThreadInput + BringWindowToTop。
 *     这两招没有文档背书,只当兜底;成没成一律以观测为准。
 *   仍会失败的情况:用户在 PowerShell 起来的这几百毫秒里已经切去别处;目标是管理员权限的窗口而 Forsion 不是
 *     (最小化的还原不了);系统策略把 PowerShell 限制成受限语言模式(Add-Type 被禁,整个功能列不出窗口)。
 *     失败时 Windows 会让目标的任务栏按钮闪烁,open 回 focus_denied,不会退去多开一个实例。
 *
 * ── 四、图标 ──────────────────────────────────────────────────────────────
 *   标识 → exe 路径(开始菜单扫到的快捷方式目标 / App Paths / 这次运行里见过的进程)→ main.ts 注入的
 *   app.getFileIcon(Windows 上它按文件取 exe 自带的图标;「所有 .app 都是通用图标」是 macOS 才有的问题)。
 *   没在跑的打包应用没有 exe 路径,回 null,渲染层画通用图标。
 *
 * ⚠️ 两段脚本都是常量,任何外部文本都不拼进脚本:数据经环境变量 FSN_APPREFS_IN(base64 的 JSON)进去,
 *    结果以 `<<FSN:base64:FSN>>` 一帧出来(base64 = 不受控制台代码页影响,中文标题不会乱码)。
 * ⚠️ 本机(macOS)跑不了这些脚本:解析与判定有夹具测试;真机那半靠 scripts/app-refs-windows.probe.cjs
 *    (.github/workflows/probe-app-refs-windows.yml 在 windows-latest 上跑)。C# 那段要保持 C# 5 语法、
 *    只用 mscorlib / System.dll 里的类型(Windows PowerShell 5.1 的 Add-Type 用的是 .NET Framework 自带的老编译器,
 *    缺省不引用 System.Core:别用 LINQ、HashSet);改完在本机拿 dotnet 按 LangVersion 5 编一遍能挡掉语法错。
 */
import { appRefKey, isAppRefId, normalizeAppRef, pickWindow, type AppRef, type AppRefApp, type AppRefList, type AppRefStatus } from '../shared/appRefs'

export interface WinRunOpts { env?: Record<string, string>; timeoutMs?: number }

export interface WinAppRefDeps {
  ownPid: number
  /** execFile:回 stdout;非零退出 / 超时 reject。opts.env 并进子进程环境,不经 shell。 */
  run: (file: string, args: string[], opts?: WinRunOpts) => Promise<string>
  now?: () => number
  /** exe 路径 → 图标 dataURL(main.ts 注入 app.getFileIcon);没注入就没有图标。 */
  fileIcon?: (exePath: string) => Promise<string | null>
  /** 取 SystemRoot 用(测试注入)。 */
  env?: NodeJS.ProcessEnv
}

// ── 标识 ────────────────────────────────────────────────────────────────

/** 包族名(名字_发布者号 13 位)!应用号。 */
const PACKAGED_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,63}_[A-Za-z0-9]{13}![A-Za-z0-9._-]{1,128}$/
export const isPackagedAumid = (s: unknown): s is string => typeof s === 'string' && PACKAGED_RE.test(s)

/** 永远不当标识的宿主进程:UWP 的窗口外框挂在它名下,它不是任何一个应用。 */
const NEVER_IDS = new Set(['applicationframehost.exe'])

const baseName = (p: string): string => p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1)
const stem = (p: string): string => baseName(p).replace(/\.exe$/i, '')
const isAbsPath = (p: string): boolean => /^(?:[A-Za-z]:\\|\\\\)/.test(p)

/** 小写 + 百分号编码成 ID_RE 认的形态(确定的:同一个输入永远同一个输出)。 */
export function encodeWinId(raw: string): string {
  let out = ''
  for (const ch of raw.toLowerCase()) {
    if (/^[a-z0-9]$/.test(ch) || (out && /^[._-]$/.test(ch))) out += ch
    else for (const b of Buffer.from(ch, 'utf8')) out += '%' + b.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

/** exe 路径(或文件名)→ 标识;不是 .exe / 名字不合法 / 太长 → null。 */
export function winIdOfExe(exePath: string): string | null {
  const name = baseName(String(exePath || '')).trim()
  if (!/^[^\\/:*?"<>|\u0000-\u001f]+\.exe$/i.test(name)) return null
  const id = encodeWinId(name)
  return isAppRefId(id) ? id : null
}

export function winIdOfAumid(aumid: string): string | null {
  if (!isPackagedAumid(aumid)) return null
  const id = encodeWinId(aumid)
  return isAppRefId(id) ? id : null
}

/**
 * 进程的 exe 路径(+ 它的包身份,知道的话)→ 它名下窗口用的应用标识。「窗口属主是哪个应用」只走这一个口:
 * 本文件的 resolveWinView,以及从别处拿到 exe / path 的调用方(比如本机助手推来的快捷键事件)。
 * null = 光凭这两样定不了 —— 宿主进程 ApplicationFrameHost(里面是谁要看窗口属性)、exe 在 \WindowsApps\ 下却没给 AUMID
 * (打包应用按 AUMID 记,exe 名对不上开始菜单那侧)、不是 .exe。这时别硬凑,改问 createWinAppRefs().frontmost()。
 */
export function winAppIdOf(exePath: string, aumid?: string): string | null {
  const exeId = winIdOfExe(exePath)
  if (!exeId || NEVER_IDS.has(exeId)) return null
  return /\\WindowsApps\\/i.test(exePath) ? winIdOfAumid(aumid ?? '') : exeId
}

/** 渲染层 / 笔记里来的标识 → 规范形(小写、重新编码)。不是 Windows 的标识(比如 macOS 的 bundle id)→ null。 */
export function canonWinId(id: unknown): string | null {
  if (!isAppRefId(id)) return null
  let raw: string
  try { raw = decodeURIComponent(id) } catch { return null }
  return isPackagedAumid(raw) ? winIdOfAumid(raw) : raw === baseName(raw) ? winIdOfExe(raw) : null
}

// ── 脚本 ────────────────────────────────────────────────────────────────

/** 结果帧:base64 里是 UTF-8 的 JSON。前后混进别的输出(警告之类)不影响。 */
const FRAME_RE = /<<FSN:([A-Za-z0-9+/=]*):FSN>>/

export function unframe(stdout: unknown): unknown {
  const m = typeof stdout === 'string' ? FRAME_RE.exec(stdout) : null
  if (!m) return null
  try { return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) } catch { return null }
}

/**
 * 窗口 / 进程快照与提窗口。op = snapshot:{ own } → { v, fg, apps:[{exe,aumid,desc}], wins:[…] };
 * op = focus:{ hwnd, wpid } → { gone, focused, step, min }。字段含义见 parseWinSnapshot / parseWinFocus。
 * ⚠️ 这里不做任何「算不算数」的判断,只照实报;判定在 resolveWinView。
 */
export const PS_NATIVE = String.raw`
$ErrorActionPreference = 'Stop'
$req = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:FSN_APPREFS_IN)))
Add-Type -IgnoreWarnings -WarningAction SilentlyContinue -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

[StructLayout(LayoutKind.Sequential)]
public struct FsnPKey { public Guid fmtid; public uint pid; }

[StructLayout(LayoutKind.Explicit, Size = 24)]
public struct FsnPropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }

[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface FsnPropertyStore {
  [PreserveSig] int GetCount(out uint n);
  [PreserveSig] int GetAt(uint i, out FsnPKey key);
  [PreserveSig] int GetValue(ref FsnPKey key, out FsnPropVariant v);
  [PreserveSig] int SetValue(ref FsnPKey key, ref FsnPropVariant v);
  [PreserveSig] int Commit();
}

[StructLayout(LayoutKind.Sequential)]
public struct FsnMouseInput { public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra; }

[StructLayout(LayoutKind.Sequential)]
public struct FsnInput { public uint type; public FsnMouseInput mi; }

public static class FsnAppRefs {
  delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr h, int index);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern uint SendInput(uint n, FsnInput[] inputs, int size);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder s, ref uint n);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetApplicationUserModelId(IntPtr h, ref uint n, StringBuilder s);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr h, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out FsnPropertyStore store);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref FsnPropVariant v);

  static void Q(StringBuilder sb, string s) {
    sb.Append('"');
    if (s != null) {
      for (int i = 0; i < s.Length; i++) {
        char c = s[i];
        if (c == '"' || c == '\\') { sb.Append('\\'); sb.Append(c); }
        else if (c < 0x20 || c > 0x7e) { sb.Append("\\u"); sb.Append(((int)c).ToString("x4")); }
        else sb.Append(c);
      }
    }
    sb.Append('"');
  }

  static string Title(IntPtr h) { StringBuilder sb = new StringBuilder(1024); GetWindowTextW(h, sb, 1024); return sb.ToString(); }
  static string ClassName(IntPtr h) { StringBuilder sb = new StringBuilder(256); GetClassNameW(h, sb, 256); return sb.ToString(); }

  static string ProcAumid(IntPtr hp) {
    try { uint n = 512; StringBuilder sb = new StringBuilder(512); return GetApplicationUserModelId(hp, ref n, sb) == 0 ? sb.ToString() : ""; }
    catch { return ""; }
  }

  static string WindowAumid(IntPtr h) {
    try {
      Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
      FsnPropertyStore store;
      if (SHGetPropertyStoreForWindow(h, ref iid, out store) != 0 || store == null) return "";
      try {
        FsnPKey key; key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); key.pid = 5;
        FsnPropVariant v;
        if (store.GetValue(ref key, out v) != 0) return "";
        string s = (v.vt == 31 && v.p != IntPtr.Zero) ? Marshal.PtrToStringUni(v.p) : "";
        PropVariantClear(ref v);
        return s == null ? "" : s;
      } finally { Marshal.ReleaseComObject(store); }
    } catch { return ""; }
  }

  static int AddProc(uint pid, List<string[]> apps, Dictionary<string, int> byKey, Dictionary<uint, int> byPid) {
    int known;
    if (byPid.TryGetValue(pid, out known)) return known;
    int idx = -1;
    IntPtr hp = OpenProcess(0x1000, false, pid);
    if (hp != IntPtr.Zero) {
      string exe = "";
      string aumid = "";
      try {
        StringBuilder sb = new StringBuilder(1024); uint n = 1024;
        if (QueryFullProcessImageNameW(hp, 0, sb, ref n)) exe = sb.ToString();
        aumid = ProcAumid(hp);
      } finally { CloseHandle(hp); }
      if (exe.Length > 0) {
        string key = exe.ToLowerInvariant() + "|" + aumid;
        if (!byKey.TryGetValue(key, out idx)) {
          idx = apps.Count;
          apps.Add(new string[] { exe, aumid, "" });
          byKey[key] = idx;
        }
      }
    }
    byPid[pid] = idx;
    return idx;
  }

  public static string Snapshot(int ownPid) {
    List<IntPtr> all = new List<IntPtr>();
    EnumProc collect = delegate(IntPtr h, IntPtr l) { all.Add(h); return true; };
    EnumWindows(collect, IntPtr.Zero);
    GC.KeepAlive(collect);

    List<string[]> apps = new List<string[]>();
    Dictionary<string, int> byKey = new Dictionary<string, int>();
    Dictionary<uint, int> byPid = new Dictionary<uint, int>();
    foreach (Process p in Process.GetProcesses()) {
      uint pid = 0;
      try { pid = (uint)p.Id; } catch { }
      p.Dispose();
      if (pid > 4 && apps.Count < 800) AddProc(pid, apps, byKey, byPid);
    }

    Dictionary<int, bool> described = new Dictionary<int, bool>();
    StringBuilder wins = new StringBuilder();
    int count = 0;
    foreach (IntPtr h in all) {
      if (count >= 400) break;
      if (!IsWindowVisible(h)) continue;
      uint pid;
      if (GetWindowThreadProcessId(h, out pid) == 0 || pid == 0 || pid == (uint)ownPid) continue;
      int a = AddProc(pid, apps, byKey, byPid);
      if (a < 0) continue;
      string cls = ClassName(h);
      int cloaked = 0;
      try { if (DwmGetWindowAttribute(h, 14, out cloaked, 4) != 0) cloaked = 0; } catch { cloaked = 0; }
      string wa = "";
      int host = -1;
      if (cls == "ApplicationFrameWindow") {
        wa = WindowAumid(h);
        uint childPid = 0;
        uint framePid = pid;
        EnumProc findChild = delegate(IntPtr c, IntPtr l) {
          uint cp;
          if (GetWindowThreadProcessId(c, out cp) != 0 && cp != 0 && cp != framePid) { childPid = cp; return false; }
          return true;
        };
        EnumChildWindows(h, findChild, IntPtr.Zero);
        GC.KeepAlive(findChild);
        if (childPid != 0) host = AddProc(childPid, apps, byKey, byPid);
      }
      described[a] = true;
      if (host >= 0) described[host] = true;
      if (count > 0) wins.Append(',');
      wins.Append("{\"h\":").Append(h.ToInt64());
      wins.Append(",\"pid\":").Append(pid);
      wins.Append(",\"a\":").Append(a);
      wins.Append(",\"ha\":").Append(host);
      wins.Append(",\"t\":"); Q(wins, Title(h));
      wins.Append(",\"c\":"); Q(wins, cls);
      wins.Append(",\"x\":").Append((uint)GetWindowLongW(h, -20));
      IntPtr owner = GetWindow(h, 4);
      wins.Append(",\"o\":").Append(owner == IntPtr.Zero ? 0 : (IsWindowVisible(owner) ? 1 : 2));
      wins.Append(",\"k\":").Append(cloaked);
      wins.Append(",\"m\":").Append(IsIconic(h) ? 1 : 0);
      wins.Append(",\"wa\":"); Q(wins, wa);
      wins.Append('}');
      count++;
    }

    foreach (int i in described.Keys) {
      try { string d = FileVersionInfo.GetVersionInfo(apps[i][0]).FileDescription; apps[i][2] = d == null ? "" : d.Trim(); } catch { }
    }

    StringBuilder sb = new StringBuilder();
    sb.Append("{\"v\":1,\"fg\":").Append(GetForegroundWindow().ToInt64()).Append(",\"apps\":[");
    for (int i = 0; i < apps.Count; i++) {
      if (i > 0) sb.Append(',');
      sb.Append("{\"exe\":"); Q(sb, apps[i][0]);
      sb.Append(",\"aumid\":"); Q(sb, apps[i][1]);
      sb.Append(",\"desc\":"); Q(sb, apps[i][2]);
      sb.Append('}');
    }
    sb.Append("],\"wins\":[").Append(wins.ToString()).Append("]}");
    return sb.ToString();
  }

  static bool IsFront(IntPtr h) {
    IntPtr fg = GetForegroundWindow();
    if (fg == IntPtr.Zero) return false;
    return fg == h || GetAncestor(fg, 3) == h;
  }

  static bool WaitFront(IntPtr h) {
    for (int i = 0; i < 10; i++) { if (IsFront(h)) return true; Thread.Sleep(30); }
    return IsFront(h);
  }

  public static string Focus(long hwnd, int pid) {
    IntPtr h = new IntPtr(hwnd);
    uint wpid = 0;
    if (!IsWindow(h) || GetWindowThreadProcessId(h, out wpid) == 0 || (pid > 0 && wpid != (uint)pid))
      return "{\"gone\":true,\"focused\":false,\"step\":0,\"min\":false}";
    bool min = IsIconic(h);
    if (min) ShowWindowAsync(h, 9);
    int step = 0;
    bool ok = !min && IsFront(h);
    if (!ok) { SetForegroundWindow(h); ok = WaitFront(h); }
    if (!ok) {
      step = 1;
      FsnInput[] nudge = new FsnInput[1];
      SendInput(1, nudge, Marshal.SizeOf(typeof(FsnInput)));
      SetForegroundWindow(h);
      ok = WaitFront(h);
    }
    if (!ok) {
      step = 2;
      uint other;
      uint cur = GetCurrentThreadId();
      IntPtr fg = GetForegroundWindow();
      uint ft = fg == IntPtr.Zero ? 0u : GetWindowThreadProcessId(fg, out other);
      bool attached = ft != 0 && ft != cur && AttachThreadInput(cur, ft, true);
      BringWindowToTop(h);
      SetForegroundWindow(h);
      if (attached) AttachThreadInput(cur, ft, false);
      ok = WaitFront(h);
    }
    if (ok && min) {
      for (int i = 0; i < 10 && IsIconic(h); i++) Thread.Sleep(30);
      if (IsIconic(h)) ok = false;
    }
    return "{\"gone\":false,\"focused\":" + (ok ? "true" : "false") + ",\"step\":" + step + ",\"min\":" + (min ? "true" : "false") + "}";
  }
}
'@
if ($req.op -eq 'focus') { $json = [FsnAppRefs]::Focus([long]$req.hwnd, [int]$req.wpid) }
else { $json = [FsnAppRefs]::Snapshot([int]$req.own) }
[Console]::Out.Write('<<FSN:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)) + ':FSN>>')
`

/**
 * 已安装应用的扫描与启动(不编 C#)。op = installed → { start:[{name,aumid,target,args}], links:[{name,lnk,target,args}],
 * paths:[{exe,path}], errors:[…] };op = launch:{ kind: aumid|lnk|exe, value } → { ok, error }。
 * 启动走 ShellExecute(ProcessStartInfo.UseShellExecute),不弹系统的报错框;value 只来自我们自己扫到的东西。
 */
export const PS_SHELL = String.raw`
$ErrorActionPreference = 'Stop'
$req = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:FSN_APPREFS_IN)))
function Out-Fsn($o) {
  $j = ConvertTo-Json -InputObject $o -Compress -Depth 6
  [Console]::Out.Write('<<FSN:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j)) + ':FSN>>')
}
if ($req.op -eq 'launch') {
  $kind = [string]$req.kind
  $value = [string]$req.value
  $ok = $false
  $err = ''
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.UseShellExecute = $true
    if ($kind -eq 'aumid') {
      $psi.FileName = 'shell:AppsFolder\' + $value
    } elseif ($kind -eq 'lnk' -and $value.ToLowerInvariant().EndsWith('.lnk') -and (Test-Path -LiteralPath $value -PathType Leaf)) {
      $psi.FileName = $value
    } elseif ($kind -eq 'exe' -and $value.ToLowerInvariant().EndsWith('.exe') -and (Test-Path -LiteralPath $value -PathType Leaf)) {
      $psi.FileName = $value
      $psi.WorkingDirectory = [IO.Path]::GetDirectoryName($value)
    } else {
      $err = 'not_found'
    }
    if (-not $err) {
      $p = [System.Diagnostics.Process]::Start($psi)
      if ($p) { $p.Dispose() }
      $ok = $true
    }
  } catch { $err = 'launch_failed' }
  Out-Fsn @{ ok = $ok; error = $err }
  exit 0
}
$errors = New-Object System.Collections.ArrayList
$start = New-Object System.Collections.ArrayList
try {
  $shell = New-Object -ComObject Shell.Application
  $folder = $shell.NameSpace('shell:AppsFolder')
  if ($folder) {
    foreach ($it in $folder.Items()) {
      if ($start.Count -ge 2000) { break }
      $target = ''
      $arguments = ''
      try { $target = [string]$it.ExtendedProperty('System.Link.TargetParsingPath') } catch {}
      try { $arguments = [string]$it.ExtendedProperty('System.Link.Arguments') } catch {}
      [void]$start.Add(@{ name = [string]$it.Name; aumid = [string]$it.Path; target = $target; args = $arguments })
    }
  } else { [void]$errors.Add('start: no AppsFolder') }
} catch { [void]$errors.Add('start: ' + $_.Exception.Message) }
$links = New-Object System.Collections.ArrayList
try {
  $wsh = New-Object -ComObject WScript.Shell
  foreach ($dir in @([Environment]::GetFolderPath('CommonPrograms'), [Environment]::GetFolderPath('Programs'))) {
    if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
    foreach ($f in @(Get-ChildItem -LiteralPath $dir -Recurse -Filter '*.lnk' -File -ErrorAction SilentlyContinue)) {
      if ($links.Count -ge 2000) { break }
      try {
        $s = $wsh.CreateShortcut($f.FullName)
        [void]$links.Add(@{ name = [string]$f.BaseName; lnk = [string]$f.FullName; target = [string]$s.TargetPath; args = [string]$s.Arguments })
      } catch {}
    }
  }
} catch { [void]$errors.Add('links: ' + $_.Exception.Message) }
$paths = New-Object System.Collections.ArrayList
foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths')) {
  try {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    foreach ($k in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
      if ($paths.Count -ge 2000) { break }
      $v = [string]$k.GetValue('')
      if ($v) { [void]$paths.Add(@{ exe = [string]$k.PSChildName; path = $v }) }
    }
  } catch { [void]$errors.Add('paths: ' + $_.Exception.Message) }
}
Out-Fsn @{ start = @($start); links = @($links); paths = @($paths); errors = @($errors) }
`

// ── 解析(子进程输出的格式风险全在这里,测试打这一层)────────────────────────────

/** PowerShell 会把只有一项的数组拆成那一项、空数组可能给 null:都认。 */
const arr = (v: unknown): Array<Record<string, unknown>> =>
  (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
/** 截断后把落单的半个代理对换掉(别的应用给的标题里可能有;带着它进 token,渲染时 encodeURIComponent 会抛)。 */
const text = (v: unknown, max: number): string =>
  (typeof v === 'string' ? v.slice(0, max) : '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
const int = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) ? v : 0)

export interface WinRawApp { exe: string; aumid: string; desc: string }
export interface WinRawWindow {
  hwnd: number; pid: number
  /** 属主进程在 apps 里的下标。 */
  app: number
  /** ApplicationFrameWindow 里那层 CoreWindow 的进程在 apps 里的下标;没有 = -1。 */
  host: number
  title: string; cls: string
  /** GWL_EXSTYLE。 */
  ex: number
  /** 有一个看得见的属主窗口(对话框、弹出面板:Alt-Tab 里由属主代表)。属主藏着的不算 —— 老式程序的主窗口就挂在一个隐藏窗口名下。 */
  owned: boolean
  /** DWMWA_CLOAKED:0 = 看得见;1 = 应用自己藏的;2 = 系统藏的(别的虚拟桌面 / 挂起的 UWP);4 = 跟着属主藏。 */
  cloaked: number
  min: boolean
  /** 窗口属性里的 AUMID(只对 ApplicationFrameWindow 取)。 */
  aumid: string
}
export interface WinSnapshot { fg: number; apps: WinRawApp[]; windows: WinRawWindow[] }

export function parseWinSnapshot(stdout: unknown): WinSnapshot | null {
  const o = unframe(stdout) as Record<string, unknown> | null
  if (!o || typeof o !== 'object' || !('wins' in o) || !('apps' in o)) return null
  const apps = arr(o.apps).slice(0, 1000).map((a) => ({ exe: text(a.exe, 1024), aumid: text(a.aumid, 256), desc: text(a.desc, 128).trim() }))
  const windows = arr(o.wins).slice(0, 400).flatMap((w): WinRawWindow[] => {
    const hwnd = int(w.h), pid = int(w.pid), app = int(w.a)
    if (!(hwnd > 0) || !(pid > 0) || typeof w.a !== 'number' || !apps[app]) return []
    const host = typeof w.ha === 'number' && w.ha >= 0 && apps[int(w.ha)] ? int(w.ha) : -1
    return [{ hwnd, pid, app, host, title: text(w.t, 512), cls: text(w.c, 128), ex: int(w.x), owned: w.o === 1, cloaked: int(w.k), min: !!w.m, aumid: text(w.wa, 256) }]
  })
  return { fg: int(o.fg), apps, windows }
}

export function parseWinFocus(stdout: unknown): { gone: boolean; focused: boolean } | null {
  const o = unframe(stdout) as Record<string, unknown> | null
  if (!o || typeof o !== 'object' || typeof o.focused !== 'boolean') return null
  return { gone: o.gone === true, focused: o.focused && o.gone !== true }
}

export interface WinInstalledRaw {
  start: Array<{ name: string; aumid: string; target: string; args: string }>
  links: Array<{ name: string; lnk: string; target: string; args: string }>
  paths: Array<{ exe: string; path: string }>
  errors: string[]
}

export function parseWinInstalled(stdout: unknown): WinInstalledRaw | null {
  const o = unframe(stdout) as Record<string, unknown> | null
  if (!o || typeof o !== 'object' || !('start' in o) || !('links' in o)) return null
  return {
    start: arr(o.start).slice(0, 2000).map((s) => ({ name: text(s.name, 128), aumid: text(s.aumid, 512), target: text(s.target, 1024), args: text(s.args, 1024) })),
    links: arr(o.links).slice(0, 2000).map((s) => ({ name: text(s.name, 128), lnk: text(s.lnk, 1024), target: text(s.target, 1024), args: text(s.args, 1024) })),
    paths: arr(o.paths).slice(0, 2000).map((s) => ({ exe: text(s.exe, 256), path: text(s.path, 1024) })),
    errors: (Array.isArray(o.errors) ? o.errors : typeof o.errors === 'string' ? [o.errors] : []).filter((e): e is string => typeof e === 'string').slice(0, 8).map((e) => e.slice(0, 200)),
  }
}

// ── 已安装的应用 → 索引 ───────────────────────────────────────────────────────

export interface WinLaunch { kind: 'aumid' | 'lnk' | 'exe'; value: string }
export interface WinApp {
  id: string
  name: string
  /** 启动它用的东西:全部来自系统(AppsFolder 的 AUMID、快捷方式路径、注册表里的 exe 路径)。 */
  launch: WinLaunch
  /** 取图标用的 exe 路径。 */
  icon?: string
  /** 进不进选择器:开始菜单里有的才进;只在 App Paths 里的(一堆系统小工具)只用来判断「装没装」和启动。 */
  listed: boolean
}

/** 带着参数的快捷方式指向这些 = 「用它去跑别的东西」,不是这个 exe 自己的入口(开发者命令行、jar、网页应用…)。 */
const HOST_EXES = new Set([
  'cmd.exe', 'powershell.exe', 'pwsh.exe', 'wscript.exe', 'cscript.exe', 'mshta.exe', 'rundll32.exe', 'msiexec.exe', 'mmc.exe', 'control.exe',
  'explorer.exe', 'conhost.exe', 'wt.exe', 'wsl.exe', 'java.exe', 'javaw.exe', 'python.exe', 'pythonw.exe', 'py.exe', 'pyw.exe', 'node.exe', 'dotnet.exe',
  'chrome_proxy.exe', 'msedge_proxy.exe', 'brave_proxy.exe',
])

/**
 * 三路来源并成「标识 → 应用」。同一个 exe 有几条开始菜单项时:不带参数的 > 带参数的,AppsFolder > .lnk,名字短的在前。
 * Squirrel 装的应用(Discord、旧 Slack…)快捷方式指向 `Update.exe --processStart "X.exe"`,窗口属主却是 X.exe:按 X.exe 记。
 */
export function buildWinIndex(raw: WinInstalledRaw): Map<string, WinApp> {
  type Cand = WinApp & { rank: number }
  const best = new Map<string, Cand>()
  const icons = new Map<string, string>()
  const consider = (c: Cand): void => {
    if (c.icon && !icons.has(c.id)) icons.set(c.id, c.icon)
    const cur = best.get(c.id)
    if (!cur || c.rank < cur.rank || (c.rank === cur.rank && (c.name.length - cur.name.length || c.name.localeCompare(cur.name)) < 0)) best.set(c.id, c)
  }
  const classic = (name: string, target: string, args: string, launch: WinLaunch, sourceRank: number): void => {
    const base = baseName(target).toLowerCase()
    if (!base.endsWith('.exe') || /^unins/.test(base)) return
    const hasArgs = !!args.trim()
    // 卸载 / 修复入口:同一个 exe 带着 `--uninstall` 之类的参数,名字还可能比正主短(排到前面)—— 绝不能让一条应用引用启动到它头上。
    // 只看带参数的:名字里有 Uninstaller 的正经应用(各种卸载工具)不带参数,照常进。
    if (hasArgs && /unins|remove|repair|卸载|卸載/i.test(`${name} ${args}`)) return
    let exeName = base
    let rank = sourceRank + (hasArgs ? 2 : 0)
    if (base === 'update.exe') {
      const m = /--processStart(?:AndWait)?\s+(?:"([^"]+\.exe)"|(\S+\.exe))/i.exec(args)
      if (!m) return
      exeName = baseName(m[1] || m[2]).toLowerCase()
      rank = sourceRank
    } else if (hasArgs && HOST_EXES.has(base)) return
    const id = winIdOfExe(exeName)
    if (!id || NEVER_IDS.has(id)) return
    consider({ id, name: name.trim() || stem(exeName), launch, ...(isAbsPath(target) ? { icon: target } : {}), listed: true, rank })
  }
  for (const s of raw.start) {
    if (!s.aumid) continue
    const launch: WinLaunch = { kind: 'aumid', value: s.aumid }
    const packaged = winIdOfAumid(s.aumid)
    if (packaged) consider({ id: packaged, name: s.name.trim() || s.aumid, launch, listed: true, rank: 0 })
    else if (s.target) classic(s.name, s.target, s.args, launch, 0)
    else if (/\.exe$/i.test(s.aumid)) classic(s.name, s.aumid, '', launch, 0) // 系统按路径生成的 AUMID:`{已知文件夹}\…\x.exe`
  }
  for (const l of raw.links) if (l.lnk && l.target) classic(l.name, l.target, l.args, { kind: 'lnk', value: l.lnk }, 1)
  const out = new Map<string, WinApp>()
  for (const [id, c] of best) out.set(id, { id, name: c.name, launch: c.launch, ...(icons.has(id) ? { icon: icons.get(id) } : {}), listed: true })
  for (const p of raw.paths) {
    const file = p.path.trim().replace(/^"([^"]*)".*$/, '$1')
    const id = isAbsPath(file) ? winIdOfExe(file) : null
    if (!id || NEVER_IDS.has(id)) continue
    const cur = out.get(id)
    if (!cur) out.set(id, { id, name: stem(file), launch: { kind: 'exe', value: file }, icon: file, listed: false })
    else if (!cur.icon) cur.icon = file
  }
  return out
}

// ── 快照 → 可引用的窗口 / 在跑的应用 ───────────────────────────────────────────────

const WS_EX_TOPMOST = 0x8
const WS_EX_TOOLWINDOW = 0x80
const WS_EX_APPWINDOW = 0x40000
const WS_EX_NOACTIVATE = 0x8000000
/** 桌面、任务栏、没挂进外框的 UWP 内层窗口(开始菜单、搜索、输入法面板都是这一类):可见、有标题,但不是用户的窗口。 */
const SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Windows.UI.Core.CoreWindow'])
const FRAME_CLASS = 'ApplicationFrameWindow'

export interface WinWindow {
  id: string
  /** 应用名。 */
  app: string
  title: string
  pid: number
  hwnd: number
  min: boolean
  /** 在当前桌面上(没被系统藏起)。false = 在别的虚拟桌面:选择器不列,但引用仍算开着、点了能切过去。 */
  onScreen: boolean
  topmost: boolean
}
export interface WinRunning { name: string; exe?: string; aumid?: string }
export interface WinView { fg: number; windows: WinWindow[]; running: Map<string, WinRunning> }

/**
 * 快照里哪些窗口算数、各是哪个应用的(判定规则见文件头一、二)。窗口保持前后顺序。
 * running:每个进程按 exe 名记一条;有包身份的再按 AUMID 记一条 —— 开始菜单那侧用的是哪种标识,都查得到「在跑」。
 */
export function resolveWinView(snap: WinSnapshot, nameOf: (id: string) => string | undefined = () => undefined): WinView {
  const running = new Map<string, WinRunning>()
  for (const a of snap.apps) {
    const exeId = winIdOfExe(a.exe)
    const name = a.desc || stem(a.exe)
    if (exeId && !NEVER_IDS.has(exeId) && !running.get(exeId)?.exe) running.set(exeId, { name, exe: a.exe })
    const pkgId = winIdOfAumid(a.aumid)
    if (pkgId && !running.has(pkgId)) running.set(pkgId, { name, exe: a.exe, aumid: a.aumid })
  }
  const windows: WinWindow[] = []
  for (const w of snap.windows) {
    const appWindow = (w.ex & WS_EX_APPWINDOW) !== 0
    if (SHELL_CLASSES.has(w.cls)) continue
    if (!appWindow && ((w.ex & WS_EX_TOOLWINDOW) !== 0 || (w.ex & WS_EX_NOACTIVATE) !== 0 || w.owned)) continue
    // 藏起来的:只认「系统藏的传统窗口」= 在别的虚拟桌面;UWP 外框被藏多半是挂起后留下的空壳,不算
    if (w.cloaked !== 0 && !(w.cloaked === 2 && w.cls !== FRAME_CLASS)) continue
    const owner = snap.apps[w.app]
    if (!owner) continue
    let id: string | null
    let fallback: string
    if (w.cls === FRAME_CLASS || NEVER_IDS.has(winIdOfExe(owner.exe) ?? '')) {
      const hosted = w.host >= 0 ? snap.apps[w.host] : undefined
      id = winIdOfAumid(w.aumid) ?? (hosted ? winIdOfAumid(hosted.aumid) : null)
      fallback = hosted?.desc || w.title
    } else {
      // 在 WindowsApps 下却读不到包身份(少见:进程拒绝访问)→ 退回 exe 名,总比这扇窗口引用不了强
      id = winAppIdOf(owner.exe, owner.aumid) ?? winIdOfExe(owner.exe)
      fallback = owner.desc || stem(owner.exe)
    }
    if (!id || NEVER_IDS.has(id)) continue
    windows.push({ id, app: nameOf(id) || fallback || id, title: w.title, pid: w.pid, hwnd: w.hwnd, min: w.min, onScreen: w.cloaked === 0, topmost: (w.ex & WS_EX_TOPMOST) !== 0 })
  }
  return { fg: snap.fg, windows, running }
}

// ── 后端 ────────────────────────────────────────────────────────────────

const INSTALLED_TTL_MS = 60_000
/** 旧到这个程度就不再「先用旧的」,等刷新完。 */
const INSTALLED_MAX_STALE_MS = 10 * 60_000
const INSTALLED_TIMEOUT_MS = 20_000
/** 冷机器上第一次起 PowerShell + 现编 C# 可能要好几秒(之后有磁盘缓存就快了)。 */
const NATIVE_TIMEOUT_MS = 10_000
const LAUNCH_TIMEOUT_MS = 8_000
/** 同一阵渲染里的几批状态查询共用一次快照。 */
const SNAPSHOT_REUSE_MS = 1_000
/** 点击时可以先用的旧快照(悬停刚问过状态);找不到 / 句柄失效再现列。 */
const SNAPSHOT_CLICK_MS = 3_000
/** PowerShell 起不来(被策略禁了 / 超时)之后,这段时间内的状态查询不再重试 —— 不然每 5 秒白起一个进程。 */
const FAIL_BACKOFF_MS = 15_000
const MAX_ICON_IDS = 64

type OpenResult = { ok: boolean; landed?: 'window' | 'app'; error?: string }

export function createWinAppRefs(deps: WinAppRefDeps) {
  const now = deps.now ?? Date.now
  const env = deps.env ?? process.env
  const powershell = `${env.SystemRoot || env.windir || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  // 换行统一成 CRLF 再交出去:模板字面量里的换行按语言规范恒为 LF(源码检出成 CRLF 也一样),而这是给 Windows PowerShell 解析的脚本
  const ps = (script: string, req: Record<string, unknown>, timeoutMs: number): Promise<string> =>
    deps.run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script.replace(/\r?\n/g, '\r\n')],
      { env: { FSN_APPREFS_IN: Buffer.from(JSON.stringify(req), 'utf8').toString('base64') }, timeoutMs })

  // ── 已安装的应用(缓存 + 过期后先用旧的)──
  let index = new Map<string, WinApp>()
  let indexAt: number | null = null
  let indexTriedAt: number | null = null
  let indexInflight: Promise<void> | null = null

  function refreshIndex(): Promise<void> {
    indexInflight ??= ps(PS_SHELL, { op: 'installed' }, INSTALLED_TIMEOUT_MS)
      .then((out) => { const raw = parseWinInstalled(out); if (raw) { index = buildWinIndex(raw); indexAt = now() } }, () => {})
      .then(() => { indexTriedAt = now(); indexInflight = null })
    return indexInflight
  }
  async function installed(): Promise<Map<string, WinApp>> {
    const t = now()
    if (indexAt !== null && t - indexAt < INSTALLED_TTL_MS) return index
    // 刚失败过:这一分钟内不再起,先用手上的
    if (!indexInflight && indexTriedAt !== null && t - indexTriedAt < INSTALLED_TTL_MS && (indexAt === null || t - indexAt < INSTALLED_MAX_STALE_MS)) return index
    const p = refreshIndex()
    if (indexAt === null || t - indexAt >= INSTALLED_MAX_STALE_MS) await p
    return index
  }

  // ── 这次运行里见过的 ──
  // seenApps:有过窗口的应用。不在开始菜单里的(便携版、开发构建)关掉之后靠它仍算「装着」、仍能启动。
  //   ⚠️ 只收有过窗口的:后台进程(系统服务、各种小工具)不该因为「见过它在跑」就能被一条引用启动。
  // seenExe:任何在跑的进程的 exe 路径,只给图标用(打包应用在开始菜单那侧只有 AUMID,没有 exe 路径)。
  const seenApps = new Map<string, WinRunning>()
  const seenExe = new Map<string, string>()
  const keep = <V>(map: Map<string, V>, id: string, v: V, max: number): void => {
    map.delete(id) // 重新插到最后:满了丢最早的
    map.set(id, v)
    if (map.size > max) map.delete(map.keys().next().value!)
  }
  function noteRunning(view: WinView): void {
    for (const [id, r] of view.running) if (r.exe) keep(seenExe, id, r.exe, 2000)
    for (const w of view.windows) keep(seenApps, w.id, view.running.get(w.id) ?? { name: w.app }, 500)
  }

  // ── 快照(同时到的请求合成一次;刚列过的短时间内直接用)──
  let snap: WinSnapshot | null = null
  let snapAt = 0
  let snapFailedAt: number | null = null
  let snapInflight: Promise<WinSnapshot> | null = null

  function snapshot(maxAgeMs: number, userAction = false): Promise<{ view: WinView; cached: boolean }> {
    const viewOf = (s: WinSnapshot, cached: boolean): { view: WinView; cached: boolean } => {
      const view = resolveWinView(s, (id) => index.get(id)?.name)
      noteRunning(view)
      return { view, cached }
    }
    if (snap && maxAgeMs > 0 && now() - snapAt < maxAgeMs) return Promise.resolve(viewOf(snap, true))
    if (!snapInflight) {
      if (!userAction && snapFailedAt !== null && now() - snapFailedAt < FAIL_BACKOFF_MS) return Promise.reject(Object.assign(new Error('window snapshot unavailable'), { code: 'unavailable' }))
      snapInflight = ps(PS_NATIVE, { op: 'snapshot', own: deps.ownPid }, NATIVE_TIMEOUT_MS)
        .then((out) => {
          const parsed = parseWinSnapshot(out)
          if (!parsed) throw Object.assign(new Error('window snapshot unreadable'), { code: 'unavailable' })
          snap = parsed; snapAt = now(); snapFailedAt = null
          return parsed
        })
        .catch((err) => { snapFailedAt = now(); throw err })
        .finally(() => { snapInflight = null })
    }
    return snapInflight.then((s) => viewOf(s, false))
  }

  /** 这次运行里经手过的窗口引用 → 它当时是哪扇窗口(与 macOS 半身同一套:标题变了照样认得出这一扇)。 */
  // ponytail: 不跟踪窗口的销毁。同一个进程把同一个句柄值发给另一扇窗口时会认错 —— 句柄高 16 位是复用计数,
  // 同一个值要这个槽位被回收 65536 次才再出现;真碰上了再在快照里顺手清掉「进程还在、句柄不在」的条目。
  const seen = new Map<string, { pid: number; windowId: number }>()
  function remember(id: string, title: string, pid: number, windowId: number): void {
    const canon = canonWinId(id)
    if (!canon || !title || !(pid > 0) || !(windowId > 0)) return
    const key = appRefKey({ kind: 'window', id: canon, name: title })
    seen.delete(key) // 重新插到最后:满了丢最早的
    seen.set(key, { pid, windowId })
    if (seen.size > 500) seen.delete(seen.keys().next().value!)
  }

  /** 引用指的那扇窗口:这次运行里记下的那一扇还在(标题变了也算)→ 再按标题挑(shared 的 pickWindow:相同的 > 唯一相近的)。
   *  最小化的、在别的虚拟桌面的都在候选里(它们还开着)。 */
  function findWindow(ref: AppRef & { id: string }, view: WinView): WinWindow | null {
    const mine = view.windows.filter((w) => w.id === ref.id)
    const known = seen.get(appRefKey(ref))
    return (known && mine.find((w) => w.pid === known.pid && w.hwnd === known.windowId)) || pickWindow(ref.name, mine.filter((w) => w.title))
  }

  /** 选择器的候选:当前桌面上带标题的窗口(前到后)+ 应用(在跑的在前,其余按名字)。 */
  async function list(): Promise<AppRefList> {
    const [apps, got] = await Promise.all([installed(), snapshot(SNAPSHOT_REUSE_MS, true).catch(() => null)])
    const view = got?.view ?? { fg: 0, windows: [], running: new Map<string, WinRunning>() }
    const onScreen = view.windows.filter((w) => w.onScreen)
    const listed = new Set<string>()
    const windows = onScreen.flatMap((w) => {
      const key = `${w.id}|${w.title}`
      if (!w.title || listed.has(key)) return []
      listed.add(key)
      remember(w.id, w.title, w.pid, w.hwnd) // 同名的记最前面那扇(候选里显示的也是它)
      return [{ id: w.id, app: apps.get(w.id)?.name || w.app, title: w.title }]
    })
    const byId = new Map<string, AppRefApp>()
    for (const w of onScreen) if (!byId.has(w.id)) byId.set(w.id, { id: w.id, name: apps.get(w.id)?.name || w.app || w.id, running: true })
    for (const [id, app] of apps) if (app.listed && !byId.has(id)) byId.set(id, { id, name: app.name, running: view.running.has(id) })
    const sorted = [...byId.values()].sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name))
    return { windows, apps: sorted, ...(got ? {} : { error: 'unavailable' }) }
  }

  /** 一批引用此刻的状态。只读:一次快照(隐藏窗口的子进程),不启动、不切换任何东西。列不出来时窗口按已关、应用按没在跑。 */
  async function status(raw: unknown): Promise<AppRefStatus[]> {
    const refs = (Array.isArray(raw) ? raw : []).slice(0, 64).map(normalizeAppRef)
    if (!refs.some(Boolean)) return refs.map(() => ({ state: 'missing' as const, appName: '' }))
    const [apps, got] = await Promise.all([installed(), snapshot(SNAPSHOT_REUSE_MS).catch(() => null)])
    return refs.map((ref): AppRefStatus => {
      if (!ref) return { state: 'missing', appName: '' }
      const id = canonWinId(ref.id)
      const fallbackName = ref.kind === 'app' ? ref.name : ref.id
      if (!id) return { state: 'missing', appName: fallbackName }
      const run = got?.view.running.get(id)
      const appName = apps.get(id)?.name || run?.name || seenApps.get(id)?.name || fallbackName
      if (!apps.has(id) && !run && !seenApps.has(id)) return { state: 'missing', appName }
      if (ref.kind === 'app') return { state: run ? 'running' : 'idle', appName }
      return { state: got && findWindow({ ...ref, id }, got.view) ? 'live' : 'closed', appName }
    })
  }

  async function focus(w: { hwnd: number; pid: number }): Promise<'focused' | 'gone' | 'denied'> {
    const r = parseWinFocus(await ps(PS_NATIVE, { op: 'focus', hwnd: w.hwnd, wpid: w.pid }, NATIVE_TIMEOUT_MS).catch(() => null))
    return !r ? 'denied' : r.gone ? 'gone' : r.focused ? 'focused' : 'denied'
  }

  /** 先用刚列过的快照,不行再现列:在里面挑一扇窗口提上来。null = 没有这样的窗口。
   *  列不出来时:这次运行里列成功过 → 多半是一时的(超时),回 'unavailable',调用方不启动(应用也许正开着,再启动就是多开);
   *  从来没成功过 → 这台机器列不了窗口(PowerShell 被限制),按「没有」算,点击退成开始菜单那样直接启动。 */
  async function focusPicked(pick: (view: WinView) => WinWindow | null | undefined): Promise<'focused' | 'denied' | 'unavailable' | null> {
    for (const maxAge of [SNAPSHOT_CLICK_MS, 0]) {
      const got = await snapshot(maxAge, true).catch(() => null)
      if (!got) return snap ? 'unavailable' : null
      const w = pick(got.view)
      if (w) {
        const r = await focus({ hwnd: w.hwnd, pid: w.pid })
        if (r !== 'gone') return r
      }
      if (!got.cached) return null // 现列的都没有 / 刚没了:确实没有
    }
    return null
  }

  async function launchTarget(id: string): Promise<WinLaunch | null> {
    const fromSeen = (): WinLaunch | null => {
      const s = seenApps.get(id)
      return s?.aumid ? { kind: 'aumid', value: s.aumid } : s?.exe && /\.exe$/i.test(s.exe) ? { kind: 'exe', value: s.exe } : null
    }
    let hit = (await installed()).get(id)?.launch ?? fromSeen()
    // 刚装的应用还没进缓存:现扫一遍再认一次
    if (!hit && indexAt !== null && now() - indexAt > 5_000) { await refreshIndex(); hit = index.get(id)?.launch ?? null }
    return hit
  }

  /** 刚启动过的应用 → 什么时候启动的。窗口还没出来的这几秒里再点(连点两下 / 等不及又点)不再启动第二个。
   *  ponytail: 固定 8 秒;启动更慢的应用在这之后再点仍可能多开一个,真碰上了再改成「等到它的窗口出现」。 */
  const launchedAt = new Map<string, number>()
  const RELAUNCH_GUARD_MS = 8_000

  async function openApp(id: string): Promise<OpenResult> {
    const r = await focusPicked((view) => { const mine = view.windows.filter((w) => w.id === id); return mine.find((w) => !w.min) ?? mine[0] })
    if (r === 'focused') return { ok: true, landed: 'app' }
    if (r === 'denied') return { ok: false, error: 'focus_denied' } // 窗口在、但系统不让抢前台:不去多开一个实例
    if (r === 'unavailable') return { ok: false, error: 'unavailable' }
    // 从这里到记下 launchedAt 之间没有 await:同时到的两次点击,后一个一定看得见前一个记的
    const last = launchedAt.get(id)
    if (last !== undefined && now() - last < RELAUNCH_GUARD_MS) return { ok: true, landed: 'app' }
    launchedAt.set(id, now())
    const target = await launchTarget(id)
    const out = target && unframe(await ps(PS_SHELL, { op: 'launch', kind: target.kind, value: target.value }, LAUNCH_TIMEOUT_MS).catch(() => null)) as { ok?: unknown } | null
    if (out?.ok === true) { snapAt = 0; return { ok: true, landed: 'app' } } // 手上的快照里没有它的窗口,不再当「刚列过」用
    launchedAt.delete(id)
    return { ok: false, error: 'not_installed' }
  }

  /** 点击:窗口还在 → 提那扇窗口;不在 → 按应用处理(有窗口就切过去,没有才启动)。 */
  async function open(raw: unknown): Promise<OpenResult> {
    const ref = normalizeAppRef(raw)
    if (!ref) return { ok: false, error: 'bad_ref' }
    const id = canonWinId(ref.id)
    if (!id) return { ok: false, error: 'not_installed' }
    if (ref.kind === 'window') {
      const key = appRefKey({ ...ref, id })
      const known = seen.get(key)
      // 这次运行里记下的那一扇:不必先列窗口,直接提(脚本自己核对句柄还在、还属于那个进程)
      let r: 'focused' | 'gone' | 'denied' | 'unavailable' | null = known ? await focus({ hwnd: known.windowId, pid: known.pid }) : null
      if (r === 'gone') seen.delete(key)
      if (r === null || r === 'gone') r = await focusPicked((view) => findWindow({ ...ref, id }, view))
      if (r === 'focused') return { ok: true, landed: 'window' }
      if (r === 'denied') return { ok: false, error: 'focus_denied' }
      if (r === 'unavailable') return { ok: false, error: 'unavailable' }
    }
    return openApp(id)
  }

  /** 紧挨在 Forsion 后面的那扇窗口:此刻的前台窗口不是自己的就是它;否则按前后顺序取第一扇(置顶的小窗口往后排)。 */
  async function frontmost(): Promise<AppRef | null> {
    const got = await snapshot(0, true).catch(() => null)
    if (!got) return null
    const cands = got.view.windows.filter((w) => w.onScreen && !w.min)
    const w = cands.find((x) => x.hwnd === got.view.fg) ?? cands.find((x) => !x.topmost) ?? cands[0]
    if (!w) return null
    remember(w.id, w.title, w.pid, w.hwnd)
    return w.title ? { kind: 'window', id: w.id, name: w.title } : { kind: 'app', id: w.id, name: w.app || w.id }
  }

  // ── 图标 ──
  const iconCache = new Map<string, string | null>()
  async function icons(raw: unknown): Promise<Record<string, string | null>> {
    const want = [...new Set(Array.isArray(raw) ? raw : [])].filter(isAppRefId).slice(0, MAX_ICON_IDS)
    const canon = new Map(want.map((orig) => [orig, canonWinId(orig)] as const))
    const todo = [...new Set([...canon.values()].filter((id): id is string => !!id && !iconCache.has(id)))]
    const fileIcon = deps.fileIcon
    if (todo.length && fileIcon) {
      const apps = await installed()
      const exeOf = (id: string): string | undefined => apps.get(id)?.icon ?? seenExe.get(id)
      // 不在开始菜单里的(便携版)要看过一眼在跑的进程才知道它在哪
      if (todo.some((id) => !exeOf(id))) await snapshot(SNAPSHOT_CLICK_MS).catch(() => null)
      await Promise.all(todo.map(async (id) => {
        const exe = exeOf(id)
        if (!exe) return // 还不知道在哪:不缓存,下次再认
        iconCache.set(id, await fileIcon(exe).catch(() => null))
        if (iconCache.size > 500) iconCache.delete(iconCache.keys().next().value!)
      }))
    }
    return Object.fromEntries(want.map((orig) => { const id = canon.get(orig); return [orig, (id && iconCache.get(id)) || null] }))
  }

  /** 同 macOS 半身:这次运行里记下的那扇窗口(句柄),截图只认这种。 */
  const known = (ref: AppRef): { pid: number; windowId: number } | null => {
    const canon = canonWinId(ref.id)
    return canon ? seen.get(appRefKey({ ...ref, id: canon })) ?? null : null
  }

  return { list, status, open, frontmost, remember, icons, known }
}
