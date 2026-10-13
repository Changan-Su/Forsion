/**
 * 应用 / 窗口引用的主进程半身(契约见 shared/appRefs.ts):列出可引用的窗口和应用、查一批引用此刻的状态、点击时切过去。
 *
 * 窗口相关全经 CU helper(本机辅助 App):`dockCandidates` 给屏上的窗口(带标题),`listApps` 给在跑的进程,
 * `listWindows` 给某个进程的全部窗口(含最小化 / 别的桌面),`focusWindow` 把一扇窗口提上来。
 * 应用清单来自 Spotlight(mdfind),启动 / 切到应用用 `open -b`,这两样不靠 helper —— helper 没装或没授权时
 * 仍能引用和打开应用,只是列不出窗口。这里是 macOS 的实现;Windows 另有一套(appRefsWin.ts:PowerShell,不靠 helper);
 * 再别的平台 list 回空、open 回 unsupported_platform。
 */
import { normalizeDockCandidates } from '../shared/appDock'
import { appRefKey, isAppRefId, normalizeAppRef, pickWindow, windowTitleScore, type AppRef, type AppRefApp, type AppRefList, type AppRefStatus, type AppRefWindow } from '../shared/appRefs'
import { createWinAppRefs, type WinRunOpts } from './appRefsWin'

export interface AppRefDeps {
  platform: NodeJS.Platform
  ownPid: number
  home: string
  /** 向 helper 问一条;helper 不在 / 不认识命令时 reject(带 code)。 */
  ask: (payload: Record<string, unknown>) => Promise<unknown>
  /** 确保 helper 在跑(只在用户主动打开选择器 / 点击窗口引用时调)。 */
  ensureHelper: () => Promise<void>
  /** execFile:回 stdout;非零退出 reject。opts(环境变量 / 超时)只有 Windows 那一半用。 */
  run: (file: string, args: string[], opts?: WinRunOpts) => Promise<string>
  now?: () => number
  /** Windows:exe 路径 → 图标 dataURL(macOS 的图标走 appIcons.ts)。 */
  fileIcon?: (exePath: string) => Promise<string | null>
}

export interface InstalledApp { name: string; path: string }

/** mdfind 两个 -attr 的输出 → bundle id → 应用。嵌在别的 .app 里的不算;同一 id 多份时优先应用 / 系统目录。 */
export function parseInstalledApps(out: string, home: string): Map<string, InstalledApp> {
  const preferred = ['/Applications/', '/System/Applications/', '/System/Library/CoreServices/', `${home}/Applications/`]
  const rank = (p: string): number => { const i = preferred.findIndex((d) => p.startsWith(d)); return i < 0 ? preferred.length : i }
  const best = new Map<string, InstalledApp>()
  for (const line of out.split('\n')) {
    const m = /^(\/.+\.app)\s+kMDItemCFBundleIdentifier = (\S+)\s+kMDItemDisplayName = (.*)$/.exec(line)
    if (!m || !isAppRefId(m[2]) || m[1].slice(0, -4).includes('.app/')) continue
    const shown = m[3].trim()
    const name = (shown && shown !== '(null)' ? shown : m[1].split('/').pop()!).replace(/\.app$/i, '')
    const cur = best.get(m[2])
    if (!cur || rank(m[1]) < rank(cur.path)) best.set(m[2], { name, path: m[1] })
  }
  return best
}

interface Running { id: string; name: string; pid: number }

function normalizeRunning(raw: unknown): Running[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 400).flatMap((item) => {
    const r = item as Record<string, unknown>
    const pid = typeof r?.pid === 'number' && Number.isInteger(r.pid) && r.pid > 0 ? r.pid : 0
    if (!pid || !isAppRefId(r.bundleId)) return []
    return [{ id: r.bundleId, name: typeof r.appName === 'string' ? r.appName.slice(0, 128) : '', pid }]
  })
}

interface AxWindow { title: string; windowId?: number; windowRef?: string }

function normalizeAxWindows(raw: unknown): AxWindow[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 100).flatMap((item) => {
    const r = item as Record<string, unknown>
    if (typeof r?.title !== 'string' || !r.title) return []
    return [{
      title: r.title.slice(0, 256),
      ...(typeof r.windowId === 'number' && r.windowId > 0 ? { windowId: r.windowId } : {}),
      ...(typeof r.windowRef === 'string' ? { windowRef: r.windowRef.slice(0, 256) } : {}),
    }]
  })
}

const INSTALLED_TTL_MS = 60_000

export function createAppRefs(deps: AppRefDeps) {
  if (deps.platform === 'win32') return createWinAppRefs(deps)
  const now = deps.now ?? Date.now
  const mac = deps.platform === 'darwin'
  let installedAt = 0
  let installedCache = new Map<string, InstalledApp>()

  async function installed(): Promise<Map<string, InstalledApp>> {
    if (installedAt && now() - installedAt < INSTALLED_TTL_MS) return installedCache
    const dirs = ['/Applications', '/System/Applications', '/System/Library/CoreServices', `${deps.home}/Applications`]
    const out = await deps.run('/usr/bin/mdfind', [
      ...dirs.flatMap((d) => ['-onlyin', d]), '-attr', 'kMDItemCFBundleIdentifier', '-attr', 'kMDItemDisplayName',
      "kMDItemContentType == 'com.apple.application-bundle'",
    ]).catch(() => null)
    // mdfind 失败(Spotlight 关了 / 超时)不刷新缓存时间,下次再试
    if (out !== null) { installedCache = parseInstalledApps(out, deps.home); installedAt = now() }
    return installedCache
  }

  /** 这次运行里经手过的窗口引用 → 它当时是哪扇窗口(列候选、按快捷键时记下)。之后标题变了(浏览器换了标签页)照样认得出这一扇。
   *  重启之后、别的设备来的、Tangu 写的引用没有这条,退回按标题找(pickWindow)。 */
  const seen = new Map<string, { pid: number; windowId: number }>()
  function remember(id: string, title: string, pid: number, windowId: number): void {
    if (!title || !(pid > 0) || !(windowId > 0)) return
    const key = appRefKey({ kind: 'window', id, name: title })
    seen.delete(key) // 重新插到最后:满了丢最早的
    seen.set(key, { pid, windowId })
    if (seen.size > 500) seen.delete(seen.keys().next().value!)
  }

  const running = (): Promise<Running[]> => deps.ask({ cmd: 'listApps' }).then(normalizeRunning)
  const onScreen = (): Promise<Array<AppRefWindow & { pid: number; windowId: number }>> =>
    deps.ask({ cmd: 'dockCandidates', excludePids: [deps.ownPid] }).then((raw) =>
      normalizeDockCandidates(raw).flatMap((w) => (isAppRefId(w.bundleId) ? [{ id: w.bundleId, app: w.app, title: w.title, pid: w.pid, windowId: w.windowId }] : [])))

  /** 选择器的候选:屏上的窗口(前到后)+ 应用(在跑的在前,其余按名字)。 */
  async function list(): Promise<AppRefList> {
    if (!mac) return { windows: [], apps: [], error: 'unsupported_platform' }
    const apps = await installed()
    let error: string | undefined
    let wins: Awaited<ReturnType<typeof onScreen>> = []
    let run: Running[] = []
    try {
      await deps.ensureHelper()
      ;[wins, run] = await Promise.all([onScreen(), running()])
    } catch (err) {
      const code = (err as { code?: string }).code
      error = code === 'unknown_command' ? 'unsupported_helper' : code || 'unavailable'
    }
    const listed = new Set<string>()
    const windows = wins.flatMap((w) => {
      const key = `${w.id}|${w.title}`
      if (!w.title || listed.has(key)) return []
      listed.add(key)
      remember(w.id, w.title, w.pid, w.windowId) // 同名的记最前面那扇(候选里显示的也是它)
      return [{ id: w.id, app: w.app, title: w.title }]
    })
    // 「在跑」只认装着的应用和屏上有窗口的进程:listApps 里还有一大堆后台小进程,不该进候选
    const runningIds = new Set(run.filter((r) => apps.has(r.id)).map((r) => r.id))
    const byId = new Map<string, AppRefApp>()
    for (const w of wins) if (!byId.has(w.id)) { byId.set(w.id, { id: w.id, name: apps.get(w.id)?.name || w.app || w.id, running: true }); runningIds.add(w.id) }
    for (const [id, app] of apps) if (!byId.has(id)) byId.set(id, { id, name: app.name, running: runningIds.has(id) })
    const sorted = [...byId.values()].sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name))
    return { windows, apps: sorted, ...(error ? { error } : {}) }
  }

  /** 引用指的那扇窗口此刻在哪。依次:这次运行里记下的那一扇还在(标题变了也算)→ 屏上标题相同的 →
   *  把这个应用的全部窗口凑齐(最小化 / 别的桌面的经 AX 找)再挑(pickWindow:相同 > 唯一相近 > 只有一扇)。 */
  async function findWindow(ref: AppRef, run: Running[], wins: Awaited<ReturnType<typeof onScreen>>): Promise<{ pid: number; windowId?: number; windowRef?: string } | null> {
    type Found = { pid: number; windowId?: number; windowRef?: string; title: string }
    const mine = wins.filter((w) => w.id === ref.id)
    const known = seen.get(appRefKey(ref))
    const isKnown = (pid: number, windowId?: number): boolean => !!known && known.pid === pid && known.windowId === windowId
    const pick = (w: Found): { pid: number; windowId?: number; windowRef?: string } => ({ pid: w.pid, windowId: w.windowId, windowRef: w.windowRef })
    const onScreenHit = mine.find((w) => isKnown(w.pid, w.windowId)) ?? mine.find((w) => windowTitleScore(ref.name, w.title) === 2)
    if (onScreenHit) return { pid: onScreenHit.pid, windowId: onScreenHit.windowId }
    const all: Found[] = mine.filter((w) => w.title).map((w) => ({ pid: w.pid, windowId: w.windowId, title: w.title }))
    for (const pid of new Set(run.filter((r) => r.id === ref.id).map((r) => r.pid))) {
      for (const x of await deps.ask({ cmd: 'listWindows', pid }).then(normalizeAxWindows, () => [])) {
        if (isKnown(pid, x.windowId)) return { pid, windowId: x.windowId, windowRef: x.windowRef }
        if (!all.some((w) => w.pid === pid && w.windowId !== undefined && w.windowId === x.windowId)) all.push({ pid, windowId: x.windowId, windowRef: x.windowRef, title: x.title })
      }
    }
    const hit = pickWindow(ref.name, all)
    return hit ? pick(hit) : null
  }

  /** 一批引用此刻的状态(气泡 / 笔记里的芯片变灰、悬停卡的那一行字)。不拉起 helper:只是看一眼,不该弹出东西。 */
  async function status(raw: unknown): Promise<AppRefStatus[]> {
    const refs = (Array.isArray(raw) ? raw : []).slice(0, 64).map(normalizeAppRef)
    if (!mac) return refs.map((r) => ({ state: 'missing' as const, appName: r?.id ?? '' }))
    const apps = await installed()
    const [run, wins] = await Promise.all([running().catch(() => null), onScreen().catch(() => [])])
    const out: AppRefStatus[] = []
    for (const ref of refs) {
      if (!ref) { out.push({ state: 'missing', appName: '' }); continue }
      const isRunning = !!run?.some((r) => r.id === ref.id)
      const appName = apps.get(ref.id)?.name || run?.find((r) => r.id === ref.id)?.name || (ref.kind === 'app' ? ref.name : ref.id)
      if (!apps.has(ref.id) && !isRunning) out.push({ state: 'missing', appName })
      else if (ref.kind === 'app') out.push({ state: isRunning ? 'running' : 'idle', appName })
      else out.push({ state: run && (await findWindow(ref, run, wins)) ? 'live' : 'closed', appName })
    }
    return out
  }

  /** 点击:窗口还在 → 提上来并切到那个应用;不在 → 只打开应用。应用 → 启动或切过去。 */
  async function open(raw: unknown): Promise<{ ok: boolean; landed?: 'window' | 'app'; error?: string }> {
    const ref = normalizeAppRef(raw)
    if (!ref) return { ok: false, error: 'bad_ref' }
    if (!mac) return { ok: false, error: 'unsupported_platform' }
    let landed: 'window' | 'app' = 'app'
    if (ref.kind === 'window') {
      try {
        await deps.ensureHelper()
        const [run, wins] = await Promise.all([running(), onScreen()])
        const w = await findWindow(ref, run, wins)
        if (w) {
          const r = await deps.ask({ cmd: 'focusWindow', pid: w.pid, ...(w.windowId ? { windowId: w.windowId } : {}), ...(w.windowRef ? { windowRef: w.windowRef } : {}) }) as { focused?: boolean } | null
          if (r?.focused) landed = 'window'
        }
      } catch { /* helper 不可用 → 退到只打开应用 */ }
    }
    // isAppRefId 已保证 id 里没有空白和引号;execFile 不过 shell
    try { await deps.run('/usr/bin/open', ['-b', ref.id]) } catch { return { ok: false, error: 'not_installed' } }
    return { ok: true, landed }
  }

  /** 紧挨在 Forsion 后面的那扇窗口(快捷键「引用我刚才在看的」)。没有带标题的窗口 → 退成引用那个应用。 */
  async function frontmost(): Promise<AppRef | null> {
    if (!mac) return null
    try {
      await deps.ensureHelper()
      const w = (await onScreen())[0]
      if (!w) return null
      remember(w.id, w.title, w.pid, w.windowId)
      return w.title ? { kind: 'window', id: w.id, name: w.title } : { kind: 'app', id: w.id, name: w.app || w.id }
    } catch { return null }
  }

  return { list, status, open, frontmost, remember }
}
