/**
 * 听写往别的应用写字:Windows 那一半。一个常驻的 PowerShell(-STA,剪贴板要单线程套间)按行收 JSON、按行回 JSON:
 *   - 前台窗口:GetForegroundWindow + GetWindowThreadProcessId(HWND + pid)。
 *   - 密码框:UI Automation 焦点元素的 IsPassword(经典 Edit 的 ES_PASSWORD 与多数现代框都报这个);**读不到 = 不写**(no-field),
 *     Windows 没有 macOS 那种 Secure Event Input 兜底,看不清的框只能当可能是密码框。
 *   - 还在打字:GetLastInputInfo(含鼠标)+ GetAsyncKeyState 看 Shift / Ctrl / Alt / Win 有没有按着;等不到安静就不写。
 *   - 剪贴板:记序号 → GetDataObject 把每种格式抄进新的 DataObject(**有一种读不回来就不写**,还原时会丢)→ 序号变了就放弃
 *     → 再核目标 → 写(带 CanIncludeInClipboardHistory=0,不进 Win+V 历史)→ Ctrl+V 前最后核一次,没过就还原 → 等一会儿 →
 *     序号还是我们写的那个才还原。每次写之前都重核序号,不用 SetDataObject 自带的重试(它会在用户刚复制的东西上再写一遍)。
 *   - 截止时间:请求带 deadline,worker 在写剪贴板前、按 Ctrl+V 前各看一次,过了就不动;主进程超时(比 deadline 晚)才杀进程,
 *     免得「主进程已经报失败、worker 卡在慢的剪贴板提供方后面又粘了一次」。
 *   - 已知限制(写进 GitHub issue 交 Windows 实机验):UIPI —— 目标是管理员权限的窗口时按键会被系统丢掉,我们看不出来;
 *     延迟渲染 / 非 HGLOBAL 的格式(Office 的嵌入对象之类)读不回来时这次就只给「复制」。
 * Add-Type 编译一次 C# 要几百毫秒:插件开着(有租约)时进程常驻(keepWarm),按下快捷键那一刻取前台窗口不用等冷启动;没租约时闲 2 分钟自己退。
 * 听写的文字走 stdin,不进命令行参数。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { DictationFailure } from '../../shared/dictation'

export const WIN_DRIVER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ForsionDictation {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
  public static uint IdleMs() { var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i); GetLastInputInfo(ref i); return unchecked((uint)Environment.TickCount - i.dwTime); }
  public static bool ModifiersDown() { foreach (int k in new int[] { 0x10, 0x11, 0x12, 0x5B, 0x5C }) { if ((GetAsyncKeyState(k) & 0x8000) != 0) return true; } return false; }
  public static void Paste() { keybd_event(0x11, 0, 0, UIntPtr.Zero); keybd_event(0x56, 0, 0, UIntPtr.Zero); keybd_event(0x56, 0, 2, UIntPtr.Zero); keybd_event(0x11, 0, 2, UIntPtr.Zero); }
}
"@
function Get-Front {
  $h = [ForsionDictation]::GetForegroundWindow()
  $p = [uint32]0
  [void][ForsionDictation]::GetWindowThreadProcessId($h, [ref]$p)
  @{ pid = [int]$p; window = $h.ToInt64() }
}
# $true / $false / $null (could not tell). Unknown is treated as "don't type": a password box we can't see is still a password box.
function Test-Password {
  try {
    $el = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -eq $el) { return $null }
    return [bool]$el.Current.IsPassword
  } catch { return $null }
}
function Test-Target($req) {
  $f = Get-Front
  if ($null -eq $req.target -or $f.pid -ne [int]$req.target.pid) { return @{ outcome = 'target-changed' } }
  if ($req.target.window -and $f.window -ne [int64]$req.target.window) { return @{ outcome = 'target-changed'; detail = 'window' } }
  $pw = Test-Password
  if ($pw -eq $true) { return @{ outcome = 'secure-field' } }
  if ($null -eq $pw) { return @{ outcome = 'no-field'; detail = 'unverified' } }
  return $null
}
function Test-Late($req) { return ($req.deadline -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -gt [int64]$req.deadline) }
function Seq { return [ForsionDictation]::GetClipboardSequenceNumber() }
# Write only while the clipboard is still at $expect. No hidden retries (SetDataObject's own retry loop could land on top of
# a copy the user just made), so the loop here re-checks the sequence number before every attempt.
function Set-Guarded($data, $expect) {
  for ($i = 0; $i -lt 10; $i++) {
    if ((Seq) -ne $expect) { return 'changed' }
    try { [System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 0, 0); return 'ok' } catch { Start-Sleep -Milliseconds 30 }
  }
  return 'busy'
}
function Restore-Clip($snap, $count, $mine) {
  if ($count -eq 0) {
    if ((Seq) -ne $mine) { return 'changed' }
    try { [System.Windows.Forms.Clipboard]::Clear(); return 'empty' } catch { return 'busy' }
  }
  return (Set-Guarded $snap $mine)
}
function Invoke-Insert($req) {
  $bad = Test-Target $req; if ($bad) { return $bad }
  $quiet = if ($req.quiet) { [int]($req.quiet * 1000) } else { 350 }
  $maxWait = if ($req.maxWait) { [int]($req.maxWait * 1000) } else { 4000 }
  $waited = 0
  while ([ForsionDictation]::IdleMs() -lt $quiet -or [ForsionDictation]::ModifiersDown()) {
    if ($waited -ge $maxWait) { return @{ outcome = 'still-typing' } }
    Start-Sleep -Milliseconds 50; $waited += 50
  }
  # Snapshot every format. Any format that can't be read back means the restore would lose it: don't paste, offer Copy.
  $before = Seq
  $old = $null
  for ($i = 0; $i -lt 10 -and $null -eq $old; $i++) { try { $old = [System.Windows.Forms.Clipboard]::GetDataObject() } catch { Start-Sleep -Milliseconds 30 } }
  $snap = New-Object System.Windows.Forms.DataObject
  $formats = @()
  if ($null -ne $old) { $formats = @($old.GetFormats($false)) }
  foreach ($fmt in $formats) {
    $d = $null
    try { $d = $old.GetData($fmt, $false) } catch {}
    if ($null -eq $d) { return @{ outcome = 'paste-failed'; detail = 'clipboard not fully readable' } }
    $snap.SetData($fmt, $false, $d)
  }
  if ((Seq) -ne $before) { return @{ outcome = 'paste-failed'; detail = 'clipboard changed' } }
  if (Test-Late $req) { return @{ outcome = 'paste-failed'; detail = 'deadline' } }
  $bad = Test-Target $req; if ($bad) { return $bad }
  $mine = $null
  $data = New-Object System.Windows.Forms.DataObject
  $data.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $false, [string]$req.text)
  # keep it out of Win+V history / cloud clipboard
  $data.SetData('CanIncludeInClipboardHistory', $false, (New-Object System.IO.MemoryStream (, [byte[]](0, 0, 0, 0))))
  $data.SetData('CanUploadToCloudClipboard', $false, (New-Object System.IO.MemoryStream (, [byte[]](0, 0, 0, 0))))
  $w = Set-Guarded $data $before
  if ($w -eq 'changed') { return @{ outcome = 'paste-failed'; detail = 'clipboard changed' } }
  if ($w -ne 'ok') { return @{ outcome = 'paste-failed'; detail = 'write' } }
  $mine = Seq
  # last look right before the keystroke: Ctrl+V lands wherever focus is now
  $bad = Test-Target $req
  if (-not $bad -and (Test-Late $req)) { $bad = @{ outcome = 'paste-failed'; detail = 'deadline' } }
  if ($bad) { [void](Restore-Clip $snap $formats.Count $mine); return $bad }
  [ForsionDictation]::Paste()
  $settle = if ($req.settle) { [int]($req.settle * 1000) } else { 400 }
  Start-Sleep -Milliseconds $settle
  if ((Seq) -ne $mine) { return @{ outcome = 'pasted'; restored = 'changed' } }
  $r = Restore-Clip $snap $formats.Count $mine
  if ($r -eq 'empty') { return @{ outcome = 'pasted'; restored = 'empty' } }
  if ($r -eq 'changed') { return @{ outcome = 'pasted'; restored = 'changed' } }
  return @{ outcome = 'pasted'; restored = ($r -eq 'ok') }
}
[Console]::Out.WriteLine('{"ready":true}')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    switch ($req.op) {
      'front' { $r = @{ front = (Get-Front) } }
      'insert' { $r = Invoke-Insert $req }
      'copy' { $ok = $false; for ($i = 0; $i -lt 10 -and -not $ok; $i++) { try { [System.Windows.Forms.Clipboard]::SetText([string]$req.text); $ok = $true } catch { Start-Sleep -Milliseconds 30 } }; $r = @{ ok = $ok } }
      default { $r = @{ error = 'unknown op' } }
    }
  } catch { $r = @{ error = $_.Exception.Message } }
  $r.id = $id
  [Console]::Out.WriteLine(($r | ConvertTo-Json -Compress -Depth 4))
}
`

export interface WinFront { pid: number; window?: number }
export interface WinInsertRequest { text: string; target: { pid: number; window?: number }; quiet?: number; maxWait?: number; settle?: number; deadline?: number }
export type WinInsertResult = { outcome: 'pasted'; restored: boolean | 'changed' | 'empty' } | { outcome: DictationFailure; detail?: string }

export interface WinDriver {
  /** 按下快捷键时先拉起(编译 C# 的时间藏在说话里)。 */
  warm(): void
  /** 插件开着时常驻,不闲退(按键那一刻取前台不等冷启动)。 */
  keepWarm(on: boolean): void
  front(): Promise<WinFront | null>
  insert(req: WinInsertRequest): Promise<WinInsertResult>
  copy(text: string): Promise<boolean>
  dispose(): void
}

const IDLE_EXIT_MS = 120_000
const FAILURES: readonly string[] = ['target-changed', 'secure-field', 'still-typing', 'no-field', 'paste-failed']

export function createWinDriver(spawnPs: () => ChildProcessWithoutNullStreams = () => spawn('powershell.exe', [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
  '-EncodedCommand', Buffer.from(WIN_DRIVER_SCRIPT, 'utf16le').toString('base64'),
], { windowsHide: true })): WinDriver {
  let child: ChildProcessWithoutNullStreams | null = null
  let ready: Promise<void> | null = null
  let seq = 0
  let idle: ReturnType<typeof setTimeout> | null = null
  let pinned = false
  const waiting = new Map<number, { resolve(v: Record<string, unknown>): void; reject(e: Error): void }>()

  const stop = (): void => {
    if (idle) { clearTimeout(idle); idle = null }
    const c = child
    child = null
    ready = null
    for (const w of waiting.values()) w.reject(new Error('dictation helper exited'))
    waiting.clear()
    try { c?.kill() } catch { /* gone */ }
  }
  const start = (): Promise<void> => {
    if (ready) return ready
    const c = spawnPs()
    child = c
    ready = new Promise<void>((resolve, reject) => {
      const lines = createInterface({ input: c.stdout })
      lines.on('line', (line) => {
        let msg: Record<string, unknown>
        try { msg = JSON.parse(line.replace(/^\uFEFF/, '')) } catch { return }
        if (msg.ready === true) { resolve(); return }
        const id = typeof msg.id === 'number' ? msg.id : -1
        const w = waiting.get(id)
        if (!w) return
        waiting.delete(id)
        if (typeof msg.error === 'string') w.reject(new Error(msg.error))
        else w.resolve(msg)
      })
      c.on('error', (e) => { reject(e); if (child === c) stop() })
      c.on('exit', () => { reject(new Error('dictation helper exited')); if (child === c) stop() })
      c.stderr.on('data', () => { /* PowerShell 的进度 / 警告,不当回答 */ })
    })
    ready.catch(() => {})
    return ready
  }
  const armIdle = (): void => {
    if (idle) { clearTimeout(idle); idle = null }
    if (!pinned && child) idle = setTimeout(stop, IDLE_EXIT_MS)
  }
  /** killOnTimeout:超时时 worker 可能还卡在剪贴板提供方后面,杀掉它,免得之后又粘一次(deadline 已过,它本也不该再动)。 */
  const call = async (payload: Record<string, unknown>, timeoutMs: number, killOnTimeout = false): Promise<Record<string, unknown>> => {
    await start()
    const c = child
    if (!c) throw new Error('dictation helper not running')
    armIdle()
    const id = ++seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error('dictation helper timed out'))
        if (killOnTimeout && child === c) stop()
      }, timeoutMs)
      waiting.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      c.stdin.write(JSON.stringify({ ...payload, id }) + '\n', 'utf8')
    })
  }
  return {
    warm() { void start().then(armIdle, () => {}) },
    keepWarm(on) {
      pinned = on
      if (on) void start().then(armIdle, () => {})
      else armIdle()
    },
    async front() {
      const r = await call({ op: 'front' }, 15_000)
      const f = r.front as Record<string, unknown> | null
      if (!f || typeof f.pid !== 'number' || f.pid <= 0) return null
      return { pid: f.pid, ...(typeof f.window === 'number' && f.window !== 0 ? { window: f.window } : {}) }
    },
    async insert(req) {
      const budget = ((req.maxWait ?? 4) + 8) * 1000
      const r = await call({ op: 'insert', ...req, deadline: Date.now() + budget }, budget + 7_000, true)
      if (r.outcome === 'pasted') {
        const restored = r.restored === 'changed' || r.restored === 'empty' ? r.restored : r.restored === true
        return { outcome: 'pasted', restored }
      }
      const outcome = typeof r.outcome === 'string' && FAILURES.includes(r.outcome) ? r.outcome as DictationFailure : 'paste-failed'
      return { outcome, ...(typeof r.detail === 'string' ? { detail: r.detail } : {}) }
    },
    async copy(text) {
      const r = await call({ op: 'copy', text }, 15_000)
      return r.ok === true
    },
    dispose: stop,
  }
}
