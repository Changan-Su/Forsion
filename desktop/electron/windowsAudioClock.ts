import { execFile } from 'node:child_process'
import { release } from 'node:os'
import { join } from 'node:path'

/** Windows 11 otherwise ignores requested timer precision when our silent
 * recording window is minimized. This affects in-process Chromium audio clocks.
 * Honor existing requests, preserving other power policies; do not request a
 * higher timer frequency or change machine-wide power settings.
 */
export async function protectWindowsAudioClock(ownedProcessId = process.pid): Promise<{ changed: boolean; detail?: string }> {
  if (process.platform !== 'win32' || Number(release().split('.')[2]) < 22000) return { changed: false }
  if (!Number.isSafeInteger(ownedProcessId) || ownedProcessId <= 0) return { changed: false, detail: 'Audio process is unavailable' }
  const source = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ForsionAudioTimer {
  [StructLayout(LayoutKind.Sequential)] public struct State { public uint Version, ControlMask, StateMask; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int id);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessInformation(IntPtr h, int kind, ref State state, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetProcessInformation(IntPtr h, int kind, ref State state, uint size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static void Protect(int id) {
    IntPtr handle = OpenProcess(0x1200, false, id);
    if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      State state = new State { Version = 1 };
      if (!GetProcessInformation(handle, 4, ref state, 12)) throw new Win32Exception(Marshal.GetLastWin32Error());
      state.ControlMask |= 4; state.StateMask &= ~4u;
      if (!SetProcessInformation(handle, 4, ref state, 12)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally { CloseHandle(handle); }
  }
}
'@
[ForsionAudioTimer]::Protect(${ownedProcessId})
`
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  return new Promise(resolve => {
    execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 5000, maxBuffer: 16384 }, error => resolve(error ? { changed: false, detail: error.message.split('\n')[0] } : { changed: true }))
  })
}
