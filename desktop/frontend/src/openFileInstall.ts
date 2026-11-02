/** 外部文件打开的渲染层落点(仅桌面主窗):主进程把 Finder「打开方式」/ 拖到 Dock / 命令行参数送来的
 *  绝对路径推过来(electron/main.ts deliverOpenFile)。像 VS Code 打开工作区外的文件:**不导入笔记库**,
 *  库外一律进 wsfile 临时标签页(PDF 等预览、.md 就地编辑原子写回 + mtime 冲突保护,见 WsFileView)。
 *  本地库内的文件改走 Amadeus 原生视图 —— .md 交 openNote(画板 / 导图 / 插件类型它自己改道),
 *  别交 openFile:没插件认领的 .md 在那里会落到「交系统默认程序」,Forsion 是默认程序时就弹回自己。 */
import { useWorkspace } from '@lcl/engine'
import { usePageStore } from '@amadeus/store/pageStore'
import { openNote, openFile, opensAsTab } from './amadeusNav'
import { openWsFile, hostTargetFor } from './views/wsFileNav'
import { whenWorkspaceReady } from './deepLinkInstall'
import { whenAmadeusPluginsReady, ensureAmadeusReady } from './amadeusPlugins'
import { windowKind } from './windowKind'

const norm = (x: string): string => x.replace(/\\/g, '/').replace(/\/+$/, '')
const windowsPath = (x: string): boolean => /^(?:[a-z]:\/|\/\/[^/]+\/[^/]+\/)/i.test(x)

/** 绝对路径 → 本地库内的相对路径;不在库里(或当前是云端库)→ null。
 *  Windows 路径不分大小写(`c:\vault\a.md` 与库根 `C:\Vault` 是同一处),按盘符形态判。 */
function vaultRelOf(path: string): string | null {
  const ps = usePageStore.getState()
  if (ps.vaultSide !== 'local' || !ps.vaultRoot) return null
  const root = norm(ps.vaultRoot) + '/'
  const q = norm(path)
  const ci = windowsPath(root)
  return (ci ? q.toLowerCase().startsWith(root.toLowerCase()) : q.startsWith(root)) ? q.slice(root.length) : null
}

/** 库是懒引导的(Amadeus / 日历 / 聊天引用挂载过才恢复):本次启动没进过 Amadeus 时 vaultRoot 为空,
 *  库里的笔记会被当成库外开进 wsfile。先引导,等库根落地或恢复结束再判(封顶 5s,超时按库外开)。 */
function whenVaultKnown(timeoutMs = 5000): Promise<void> {
  ensureAmadeusReady()
  const known = (s: { vaultRoot: string | null; vaultLoading: boolean }): boolean => !!s.vaultRoot || !s.vaultLoading
  if (known(usePageStore.getState())) return Promise.resolve()
  return new Promise((resolve) => {
    const off = usePageStore.subscribe((s) => { if (known(s)) { clearTimeout(t); off(); resolve() } })
    const t = setTimeout(() => { off(); resolve() }, timeoutMs)
  })
}

/** 库内文件已开着的那个标签。各视图的身份键不同(notePath / pdfPath / filePath / drawingPath…),只比 `*Path` 键:
 *  wsfile 的 params 里有裸文件名 `name`,按全部值比会把库根下的 `a.md` 认成已开着的库外 `~/Desktop/a.md`。 */
function openTabOf(rel: string): string | undefined {
  const api = (useWorkspace.getState() as unknown as { api?: { panels: Array<{ id: string; params?: Record<string, unknown> }> } }).api
  const ci = windowsPath(norm(rel)) || windowsPath(norm(usePageStore.getState().vaultRoot || '') + '/')
  const same = (v: unknown): boolean => typeof v === 'string' && (ci ? norm(v).toLowerCase() === norm(rel).toLowerCase() : v === rel)
  return api?.panels.find((p) => !!p.params && Object.entries(p.params).some(([k, v]) => (/Path$/.test(k) || k === 'path') && same(v)))?.id
}

export function openExternalFile(path: string): void {
  const rel = vaultRelOf(path)
  // 已开着 → 直接聚焦那个标签;没开 → 新标签。别用 openNote / openFile 缺省的「就地换掉当前标签」:
  // 用户正看着的东西不该被 Finder 里的一次双击顶掉。
  const opened = openTabOf(rel ?? norm(path))
  if (opened) useWorkspace.getState().activateLeaf(opened)
  else if (rel && /\.md$/i.test(rel)) void openNote(rel, { newTab: true })
  else if (rel && opensAsTab(rel)) openFile(rel, { newTab: true }) // 库内 PDF 走「默认打开方式」(装了 Better PDF 的人进插件)
  else if (/\.pdf$/i.test(path)) openFile(norm(path), { newTab: true })
  else openWsFile(hostTargetFor(path, path.split(/[/\\]/).pop() || path))
}

export function installOpenFiles(): void {
  if (windowKind() !== 'main') return
  const w = window as unknown as {
    tangu?: { onOpenFile?: (cb: () => void) => () => void; drainOpenFiles?: () => Promise<string[]> }
  }
  const t = w.tangu
  if (!t?.onOpenFile || !t.drainOpenFiles) return // 文件关联是桌面壳能力,web/mobile 没有
  const pull = t.drainOpenFiles
  const drain = (): void => {
    void pull().then(async (ps) => {
      if (!ps.length) return
      await whenWorkspaceReady()
      await whenVaultKnown()
      await whenAmadeusPluginsReady().catch((e) => console.error('[open-file] plugin startup failed', e))
      for (const p of ps) openExternalFile(p)
    })
  }
  t.onOpenFile(drain) // 主进程只推一声,文件留在它的队列里(见 electron/main.ts deliverOpenFile)
  drain() // 冷启动 / 重载前积压的
}
