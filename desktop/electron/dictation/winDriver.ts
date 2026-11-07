/**
 * 听写往别的应用写字:Windows 那一半。一个常驻的 PowerShell(-STA,剪贴板要单线程套间)按行收 JSON、按行回 JSON:
 *   - 前台窗口:GetForegroundWindow + GetWindowThreadProcessId(HWND + pid)。
 *   - 密码框:UI Automation 焦点元素的 IsPassword(经典 Edit 的 ES_PASSWORD 与多数现代框都报这个;读不到当「不是」)。
 *   - 还在打字:GetLastInputInfo(含鼠标)+ GetAsyncKeyState 看 Shift / Ctrl / Alt / Win 有没有按着;等不到安静就不写。
 *   - 剪贴板:GetDataObject 把每种格式抄进新的 DataObject → SetText → Ctrl+V(keybd_event)→ 等一会儿 →
 *     GetClipboardSequenceNumber 没变才 SetDataObject 还原;变了不动。
 *   - 已知限制(写进 GitHub issue 交 Windows 实机验):UIPI —— 目标是管理员权限的窗口时按键会被系统丢掉,我们看不出来;
 *     延迟渲染的格式(有的应用复制时不真给数据)抄不下来就跳过。
 * Add-Type 编译一次 C# 要几百毫秒,所以进程在按下快捷键时拉起(用户说话的这几秒里编译完)、闲 2 分钟自己退。
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
function Test-Password {
  try { return [bool][System.Windows.Automation.AutomationElement]::FocusedElement.Current.IsPassword } catch { return $false }
}
function Retry($block) {
  for ($i = 0; $i -lt 10; $i++) { try { return & $block } catch { Start-Sleep -Milliseconds 30 } }
  return & $block
}
function Invoke-Insert($req) {
  $f = Get-Front
  if ($null -eq $req.target -or $f.pid -ne [int]$req.target.pid) { return @{ outcome = 'target-changed' } }
  if ($req.target.window -and $f.window -ne [int64]$req.target.window) { return @{ outcome = 'target-changed'; detail = 'window' } }
  if (Test-Password) { return @{ outcome = 'secure-field' } }
  $quiet = if ($req.quiet) { [int]($req.quiet * 1000) } else { 350 }
  $maxWait = if ($req.maxWait) { [int]($req.maxWait * 1000) } else { 4000 }
  $waited = 0
  while ([ForsionDictation]::IdleMs() -lt $quiet -or [ForsionDictation]::ModifiersDown()) {
    if ($waited -ge $maxWait) { return @{ outcome = 'still-typing' } }
    Start-Sleep -Milliseconds 50; $waited += 50
  }
  $f = Get-Front
  if ($f.pid -ne [int]$req.target.pid) { return @{ outcome = 'target-changed' } }
  if (Test-Password) { return @{ outcome = 'secure-field' } }
  $old = Retry { [System.Windows.Forms.Clipboard]::GetDataObject() }
  $snap = New-Object System.Windows.Forms.DataObject
  $formats = @()
  if ($null -ne $old) { $formats = $old.GetFormats($false) }
  foreach ($fmt in $formats) { try { $d = $old.GetData($fmt, $false); if ($null -ne $d) { $snap.SetData($fmt, $false, $d) } } catch {} }
  Retry { [System.Windows.Forms.Clipboard]::SetText([string]$req.text) } | Out-Null
  $mine = [ForsionDictation]::GetClipboardSequenceNumber()
  [ForsionDictation]::Paste()
  $settle = if ($req.settle) { [int]($req.settle * 1000) } else { 400 }
  Start-Sleep -Milliseconds $settle
  if ([ForsionDictation]::GetClipboardSequenceNumber() -ne $mine) { return @{ outcome = 'pasted'; restored = 'changed' } }
  if ($formats.Count -eq 0) { Retry { [System.Windows.Forms.Clipboard]::Clear() } | Out-Null; return @{ outcome = 'pasted'; restored = 'empty' } }
  Retry { [System.Windows.Forms.Clipboard]::SetDataObject($snap, $true) } | Out-Null
  return @{ outcome = 'pasted'; restored = $true }
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
      'copy' { Retry { [System.Windows.Forms.Clipboard]::SetText([string]$req.text) } | Out-Null; $r = @{ ok = $true } }
      default { $r = @{ error = 'unknown op' } }
    }
  } catch { $r = @{ error = $_.Exception.Message } }
  $r.id = $id
  [Console]::Out.WriteLine(($r | ConvertTo-Json -Compress -Depth 4))
}
`

export interface WinFront { pid: number; window?: number }
export interface WinInsertRequest { text: string; target: { pid: number; window?: number }; quiet?: number; maxWait?: number; settle?: number }
export type WinInsertResult = { outcome: 'pasted'; restored: boolean | 'changed' | 'empty' } | { outcome: DictationFailure; detail?: string }

export interface WinDriver {
  /** 按下快捷键时先拉起(编译 C# 的时间藏在说话里)。 */
  warm(): void
  front(): Promise<WinFront | null>
  insert(req: WinInsertRequest): Promise<WinInsertResult>
  copy(text: string): Promise<boolean>
  dispose(): void
}

const IDLE_EXIT_MS = 120_000
const FAILURES: readonly string[] = ['target-changed', 'secure-field', 'still-typing', 'paste-failed']

export function createWinDriver(spawnPs: () => ChildProcessWithoutNullStreams = () => spawn('powershell.exe', [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
  '-EncodedCommand', Buffer.from(WIN_DRIVER_SCRIPT, 'utf16le').toString('base64'),
], { windowsHide: true })): WinDriver {
  let child: ChildProcessWithoutNullStreams | null = null
  let ready: Promise<void> | null = null
  let seq = 0
  let idle: ReturnType<typeof setTimeout> | null = null
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
  const call = async (payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> => {
    await start()
    const c = child
    if (!c) throw new Error('dictation helper not running')
    if (idle) clearTimeout(idle)
    idle = setTimeout(stop, IDLE_EXIT_MS)
    const id = ++seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('dictation helper timed out')) }, timeoutMs)
      waiting.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      c.stdin.write(JSON.stringify({ ...payload, id }) + '\n', 'utf8')
    })
  }
  return {
    warm() { void start().catch(() => {}) },
    async front() {
      const r = await call({ op: 'front' }, 15_000)
      const f = r.front as Record<string, unknown> | null
      if (!f || typeof f.pid !== 'number' || f.pid <= 0) return null
      return { pid: f.pid, ...(typeof f.window === 'number' && f.window !== 0 ? { window: f.window } : {}) }
    },
    async insert(req) {
      const r = await call({ op: 'insert', ...req }, ((req.maxWait ?? 4) + 15) * 1000)
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
