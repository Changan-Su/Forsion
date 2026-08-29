/**
 * 前台窗口采样接缝(host-only)——「现在焦点在哪个 app」这一件事,给插件用。
 *
 * 存在理由:renderer 里的插件读不到别的进程的窗口,所以 activitywatch 插件今天要挂一个外部
 * ActivityWatch(localhost:5600)。宿主出这一个接缝,那个插件就能把外部依赖去掉——按插件能力
 * 对等原则,宿主加接缝,不把功能焊进壳。
 *
 * 零依赖是刻意的:`get-windows` 拖 150 个包 / 14MB / 5 high+1 critical(全是 node-pre-gyp
 * 构建链)进分发包,而这里要的只是「前台 app 叫什么」——三个平台各一条系统自带命令就够。
 *   darwin: lsappinfo(系统自带,**零权限**,~10ms)。⚠️拿不到窗口标题——macOS 上标题属于
 *           Screen Recording 权限,任何实现都要那个授权,所以 darwin 恒 title=''。
 *   win32 : PowerShell + user32 P/Invoke。标题免费(无需授权)。
 *   linux : xprop(X11)。标题免费。Wayland 拿不到 → null(与 ActivityWatch 同样的天花板)。
 *
 * 默认拒:isEnabled() 为假时恒 null——开关是主进程配置 activeWindowEnabled(默认 false,开发者
 * 选项里开),不是 preload 里有没有这个方法(renderer 能直接 invoke 通道)。
 * idleSeconds 一并回传:采样式数据里,人离开后前台 app 不变,消费方**必须**据此丢掉挂机时段,
 * 否则挂机时长会全记到最后那个 app 头上(比 ActivityWatch 的事件流更差)。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { ActiveWindowSample } from '../shared/activeWindow'

export type { ActiveWindowSample }

const run = promisify(execFile)


/** 探针原始产出(不含 idle/platform,那两项由 sampler 补)。 */
export type RawWindow = { app: string; bundleId?: string; pid?: number; title: string }

// ── 解析器(纯函数;子进程输出的格式风险全在这里,测试打这一层)────────────────────

/** `lsappinfo info -only name,bundleid,pid <asn>` 的输出:每行 `"KEY"="VALUE"` 或 `"pid"=123`。 */
export function parseLsappinfo(text: string): RawWindow | null {
  const pick = (key: string): string | undefined => {
    const m = new RegExp(`"${key}"=("?)([^"\\n]*)\\1`).exec(text)
    return m ? m[2].trim() : undefined
  }
  const app = pick('LSDisplayName')
  if (!app) return null
  const pid = Number(pick('pid'))
  return { app, bundleId: pick('CFBundleIdentifier') || undefined, pid: Number.isFinite(pid) && pid > 0 ? pid : undefined, title: '' }
}

/** `xprop -root -notype _NET_ACTIVE_WINDOW` → 窗口 id(`0x...`);无活动窗口/Wayland → null。 */
export function parseXpropActiveId(text: string): string | null {
  const m = /_NET_ACTIVE_WINDOW[^\n]*?(0x[0-9a-fA-F]+)/.exec(text)
  // 0x0 = 没有活动窗口(刚切桌面/锁屏)
  return m && !/^0x0+$/.test(m[1]) ? m[1] : null
}

/** `xprop -id <id> -notype WM_CLASS _NET_WM_NAME WM_NAME` 的输出。 */
export function parseXpropWindow(text: string): RawWindow | null {
  // WM_CLASS = "google-chrome", "Google-chrome" —— 取第二个(实例名太随意,类名才是 app)
  const cls = /WM_CLASS\s*=\s*"([^"]*)"(?:\s*,\s*"([^"]*)")?/.exec(text)
  const app = (cls?.[2] || cls?.[1] || '').trim()
  if (!app) return null
  const title = /_NET_WM_NAME\s*=\s*"([\s\S]*?)"\s*$/m.exec(text)?.[1] ?? /WM_NAME\s*=\s*"([\s\S]*?)"\s*$/m.exec(text)?.[1] ?? ''
  return { app, title: title.trim() }
}

/** PowerShell 探针回的紧凑 JSON。 */
export function parseWindowsJson(text: string): RawWindow | null {
  try {
    const o = JSON.parse(text.trim()) as { app?: unknown; title?: unknown; pid?: unknown }
    const app = String(o.app ?? '').trim()
    if (!app) return null
    const pid = Number(o.pid)
    return { app, pid: Number.isFinite(pid) && pid > 0 ? pid : undefined, title: String(o.title ?? '').trim() }
  } catch {
    return null
  }
}

// ── 平台探针 ────────────────────────────────────────────────────────────────

const EXEC = { timeout: 4000, maxBuffer: 1 << 20, windowsHide: true } as const

const darwinProbe = async (): Promise<RawWindow | null> => {
  const asn = (await run('lsappinfo', ['front'], EXEC)).stdout.trim()
  if (!asn.startsWith('ASN:')) return null
  return parseLsappinfo((await run('lsappinfo', ['info', '-only', 'name,bundleid,pid', asn], EXEC)).stdout)
}

const linuxProbe = async (): Promise<RawWindow | null> => {
  const id = parseXpropActiveId((await run('xprop', ['-root', '-notype', '_NET_ACTIVE_WINDOW'], EXEC)).stdout)
  if (!id) return null
  return parseXpropWindow((await run('xprop', ['-id', id, '-notype', 'WM_CLASS', '_NET_WM_NAME', 'WM_NAME'], EXEC)).stdout)
}

// 常量脚本,不拼任何外部输入(无注入面)。⚠️`$pid` 是 PowerShell 保留变量,故用 $wpid。
const PS_SCRIPT = `
$s = @"
using System;using System.Text;using System.Runtime.InteropServices;
public class FsnW {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int p);
}
"@
Add-Type -TypeDefinition $s
$h = [FsnW]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][FsnW]::GetWindowText($h, $sb, 512)
$wpid = 0
[void][FsnW]::GetWindowThreadProcessId($h, [ref]$wpid)
$p = Get-Process -Id $wpid -ErrorAction SilentlyContinue
[Console]::Out.Write((@{ app = $(if ($p) { $p.ProcessName } else { '' }); title = $sb.ToString(); pid = $wpid } | ConvertTo-Json -Compress))
`

// ponytail: PowerShell 每次都要 Add-Type 现编 C#(~500ms/次 + 一个进程),所以采样间隔别低于
// 数秒。真要高频(或要省电)时的升级路径 = 换成一个常驻小 helper 进程;接缝形状不变。
// ⚠️win32/linux 两条分支在本机(darwin)无法实测,只有解析器有 fixture 测试。
const win32Probe = async (): Promise<RawWindow | null> =>
  parseWindowsJson((await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT], EXEC)).stdout)

const PROBES: Partial<Record<NodeJS.Platform, () => Promise<RawWindow | null>>> = {
  darwin: darwinProbe,
  linux: linuxProbe,
  win32: win32Probe,
}

// ── sampler ────────────────────────────────────────────────────────────────

/** 缓存下限:插件轮询再密也不会多开子进程(也挡住恶意插件把它当 CPU 燃烧器)。 */
export const MIN_SAMPLE_INTERVAL_MS = 2000

export interface SamplerDeps {
  /** 主进程配置 activeWindowEnabled;假 → 恒 null(默认拒的唯一实现点)。 */
  isEnabled(): boolean
  probe(): Promise<RawWindow | null>
  idleSeconds(): number
  now(): number
  platform: NodeJS.Platform
}

export function createSampler(deps: SamplerDeps): () => Promise<ActiveWindowSample | null> {
  let cachedAt = 0
  let cached: ActiveWindowSample | null = null
  let inflight: Promise<ActiveWindowSample | null> | null = null

  return async () => {
    if (!deps.isEnabled()) return null
    const now = deps.now()
    // 缓存命中也要刷 idle:窗口没变但人可能刚离开,消费方靠这个数丢挂机时段。
    if (now - cachedAt < MIN_SAMPLE_INTERVAL_MS) return cached && { ...cached, idleSeconds: deps.idleSeconds() }
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const raw = await deps.probe()
        cached = raw && { ...raw, idleSeconds: deps.idleSeconds(), platform: deps.platform }
      } catch {
        cached = null // 探针不可用(缺 xprop / Wayland / 命令被删):静默待机,下一轮重试
      }
      cachedAt = deps.now()
      inflight = null
      return cached
    })()
    return inflight
  }
}

/** 真机 sampler 的探针/平台部分(main.ts 注入 isEnabled + idleSeconds)。 */
export const nativeProbe = async (): Promise<RawWindow | null> =>
  (await (PROBES[process.platform]?.() ?? Promise.resolve(null))) ?? null
