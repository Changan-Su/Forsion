import { promises as fs, readdirSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import { IPC, gatePluginManifest, sanitizeOnboarding, sanitizeEvents, PLUGIN_CAPABILITIES, type ExternalPluginSource, type PluginBundleInfo } from '@amadeus-shared/ipc'
import { serializeDb, seedCalendarDb } from '@amadeus-shared/db/schema'
import { isSafePluginExt } from '@amadeus-shared/pluginFiles'
import { VaultManager } from './fs/vaultManager'
import { casRejected, registerVaultHandlers, VAULT_WRITE_EVENTS, type VaultFace } from './fs/vaultHandlers'
export type { VaultFace } from './fs/vaultHandlers'
import { VaultWatcher } from './fs/watcher'
import { VaultIndex } from './fs/vaultIndex'
import { adoptLegacyCloudState, currentCloudAccountId, readConfig, updateConfig, writeConfig } from './settings'
import { defaultWorkspaceDir, forsionHomeDir, isDevMode, tanguDataDir } from '../forsionHome'
import { getProduct } from '../productsRegistry'
import { effectivePluginId } from '../../shared/products'
import { isDevLoaded, readDevLoads } from '../devLoadStore'
import { builtinPluginIds, lockedPluginIds } from '../builtinPlugins'
import { logActivity, logNoteEdit } from '../activityLog'
import { loadTanguCreds } from '../forsionAuth'
import { fetchLinkMeta, searchImages } from './linkMeta'
import { cloudVaultDir, isManagedCloudVault, migrateCloudMirrorDir } from './cloudPaths'
import type { AmadeusSyncFactory } from './cloudSeam'
import { readPluginIconDataUrl } from '../pluginIcon'

const runFile = promisify(execFile)

// Electron 的 clipboard.writeBuffer 每调用一次都会清掉之前的 flavor;依次写 text / file-url 的
// 结果永远只剩最后一项。macOS 用 AppKit 的单枚 NSPasteboardItem 一次写齐所有表示,才能同时满足
// 「Forsion 内粘引用」与「外部 App 粘真实文件/图片」。参数从 argv 传入,不拼脚本、不执行用户文本。
const MAC_ATTACHMENT_CLIPBOARD_JXA = `ObjC.import('AppKit')
function run(argv) {
  const pb = $.NSPasteboard.generalPasteboard
  pb.clearContents
  const item = $.NSPasteboardItem.alloc.init
  item.setStringForType($(argv[0]), $.NSPasteboardTypeString)
  item.setStringForType($(argv[0]), $('application/x-forsion-attachment-reference'))
  item.setStringForType($(argv[1]), $('public.file-url'))
  item.setStringForType($(argv[1] + '\\r\\n'), $('text/uri-list'))
  item.setStringForType($(argv[2]), $.NSPasteboardTypeHTML)
  if (argv[3]) {
    const image = $.NSImage.alloc.initWithContentsOfFile($(argv[3]))
    if (image) item.setDataForType(image.TIFFRepresentation, $.NSPasteboardTypeTIFF)
  }
  pb.writeObjects($.NSArray.arrayWithObject(item))
}`

async function writeMacAttachmentClipboard(md: string, url: string, html: string, imagePath: string): Promise<boolean> {
  try {
    await runFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_ATTACHMENT_CLIPBOARD_JXA, '--', md, url, html, imagePath], { timeout: 5_000 })
    return true
  } catch {
    return false
  }
}


const SAMPLE_MANIFEST = `{
  "id": "hello-amadeus",
  "name": "Hello Amadeus",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "示例插件：演示命令、slash 项、主题与自定义视图四种贡献点。",
  "main": "main.js"
}
`

// The plugin body runs with \`ctx\` in scope and may return a disposer (see PluginContext).
const SAMPLE_MAIN = `// Hello Amadeus —— 示例插件。文件体即 setup(ctx)，可 return 一个清理函数。
// ⚠️ 命令/slash 的 id 处于全局命名空间（与其他插件共享），必须带自己的插件前缀，
//    如 'hello-amadeus-greet'——裸 id（'start'/'hello'）两个插件一撞就互相顶掉。
ctx.registerCommand({
  id: 'hello-amadeus-greet',
  title: 'Hello：打个招呼',
  keywords: 'hello hi 你好 shili',
  run: async () => {
    ctx.app.notify('你好，来自示例插件 👋')
    // 插件产出的文件写进自己的「工作文件夹」（设置页每个插件自动有一条，默认=插件名；整库可读写、越界被拒）
    if (ctx.app.workFolder) await ctx.app.writeFile(ctx.app.workFolder() + '/你好.md', '# 你好\\n\\n由示例插件写入。\\n')
  },
})
ctx.registerSlashItem({
  id: 'hello-amadeus-signature',
  label: '示例签名',
  icon: '✶',
  group: '示例',
  scaffold: '> —— 由 Amadeus 示例插件插入\\n\\n',
  keywords: 'sign 签名 shili sample',
})
// 主题 id 同样要独一无二（它就是 data-theme 的值，也是样式注入的键）。
ctx.registerTheme({
  id: 'sky',
  label: '天蓝',
  swatch: '#38bdf8',
  css: "[data-theme='sky'][data-mode='light']{--primary:#0284c7;--primary-2:#0369a1;--on-primary:#ffffff} [data-theme='sky'][data-mode='dark']{--primary:#38bdf8;--primary-2:#7dd3fc;--on-primary:#04283b}",
})
// 自定义视图：纯 DOM mount，宿主注册为 plugin:hello-amadeus:hello-board——
// Space 配方可用这个名字组合它；mount 里起的定时器/监听在返回的清理函数里收掉。
ctx.registerView({
  id: 'hello-board',
  title: 'Hello 面板',
  mount(el) {
    el.style.padding = '16px'
    el.textContent = '来自示例插件的自定义视图 ✶'
    return () => { /* 清理定时器/监听 */ }
  },
})
ctx.registerCommand({
  id: 'hello-amadeus-open-board',
  title: 'Hello：打开示例视图',
  keywords: 'board view 视图 shili',
  run: () => ctx.openView('hello-board'),
})
// 通知 + 全局状态栏（2026-07-23 起；老宿主没有这两个 API——可选链让插件在老宿主静默降级）。
// 通知：右上角卡片，来源自动标插件名，用户可在设置里按插件静音——当提示用，别当数据通道。
ctx.registerCommand({
  id: 'hello-amadeus-notify',
  title: 'Hello：弹一条通知',
  keywords: 'notify toast 通知 shili',
  run: () => ctx.notify?.('来自示例插件的通知 ✶', { level: 'success' }),
})
// 状态栏项：数据驱动（无需 React）；返回 handle 可随时 update；禁用插件时宿主自动清理。
const sbHandle = ctx.registerStatusItem?.({
  id: 'hello',
  side: 'right',
  text: '✶ hello',
  title: 'Hello Amadeus 示例状态项（点击打开示例视图）',
  onClick: () => ctx.openView('hello-board'),
})
// 轮询类插件把持续状态写进状态栏（sbHandle?.update({ text: '…' })），瞬时事件才用 notify。
void sbHandle
// Tangu 侧的只读探针：当前对话用的模型 / 当前 Space。
// ⚠️ ctx.tangu 在非 Tangu 宿主上**整个不存在**（纯 Amadeus 壳、unit 设备页）——一律可选链，
//    并且要有降级路径；直接 ctx.tangu.activeModel() 会让整个插件装载失败。
ctx.registerCommand({
  id: 'hello-amadeus-whichmodel',
  title: 'Hello：我在跟哪个模型说话？',
  keywords: 'model tangu 模型 shili',
  run: () => {
    const m = ctx.tangu?.activeModel()
    ctx.notify?.(m ? \`\${m.name}（\${m.id}）· Space=\${ctx.tangu?.activeSpace()}\` : '这个宿主没有 Tangu 对话')
  },
})
// 模型/Space 变了才回调（不是每次 store 变更）。退订宿主也会兜，但自己也收。
const offTangu = ctx.tangu?.subscribe(() => { /* 重画你的 UI */ })
// 想做「按某个裸字母弹出自己的全屏浮层」？两条纪律：浮层根要 -webkit-app-region:no-drag 且
// append 到 body；按键自挂 keydown（宿主热键表没有输入焦点闸，绑裸字母会在打字时触发）。
// 完整写法见技能 forsion-plugin 的「全屏浮层」节。
return () => { offTangu?.() }
`

export function registerIpc(getWindow: () => BrowserWindow | null, cloudFactory: AmadeusSyncFactory | null = null): {
  getVaultRoot: () => string | null
  restartSync: () => Promise<void>
  stopSync: () => Promise<void>
  readExternalPlugins: () => Promise<ExternalPluginSource[]>
  vaultFace: VaultFace
} {
  const vault = new VaultManager({
    openDirectory: async () => {
      const res = await dialog.showOpenDialog({ title: '打开智库文件夹', properties: ['openDirectory', 'createDirectory'] })
      return res.canceled ? null : res.filePaths[0] ?? null
    },
    logActivity,
  })
  const index = new VaultIndex(vault)
  let structureTimer: ReturnType<typeof setTimeout> | null = null

  // 文件变更回灌播给**所有**窗口:拖出的 detached 窗里同样有编辑器/画板/日历,
  // 只发主窗 = 那些窗永远显示旧内容(getWindow() 恒为主窗)。
  // 2026-08-24 起同时扇出给 Unit 设备页的 SSE 订阅(watcher 外部改动、改名引用重写都借此到远端);
  // SSE 事件带 origin(写入者的 clientId / 'host'=B 的渲染层 / null=watcher 等无主来源),
  // 远端桥按 origin 丢自己的回声 —— 路径时间窗方案有预臂竞态+误吞真改动,已废(Codex P1)。
  const vaultEventSubs = new Set<(channel: string, payload: unknown, origin: string | null) => void>()
  const emitRemote = (channel: string, payload: unknown, origin: string | null): void => {
    for (const s of [...vaultEventSubs]) { try { s(channel, payload, origin) } catch { /* 订阅者自理 */ } }
  }
  const notifyWindows = (channel: string, payload?: unknown): void => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
  const notifyAll = (channel: string, payload?: unknown): void => {
    notifyWindows(channel, payload)
    emitRemote(channel, payload, null)
  }
  // 渲染层的路径广播(树上改名 / 挪走 / 删除)转给**其它**窗口:标签、scope、多维表白板条目的跟随都只在
  // 发起窗口的 realm 里跑,structureChange 又不带路径 → 分离窗 / Mini 卡一直攥着旧路径。发起窗口已处理过,不回发。
  // 直接挂 ipcMain,不走下面的 handle():那个会进 /vault/rpc 派发表,远端设备不该能往本机窗口里灌路径广播。
  ipcMain.handle(IPC.pathGone, (e, event) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && w.webContents !== e.sender) w.webContents.send(IPC.pathGone, event)
  })
  /**
   * 写通道 → 回灌事件映射。为什么需要它:savePage 一类的写不广播(本窗自己知道),watcher 又按
   * 自写账本压掉主进程落盘 —— 设备互联后「另一端」就永远听不到。两个派发口各补一半:
   *   渲染层 IPC 起源 → 只发 SSE 给远端(本机各窗维持既有静默,不动外部回灌 P0 契约);
   *   RPC 起源(远端写) → 本机窗口回灌 + SSE(带写入者 origin,远端桥据此丢自己的回声)。
   * 笔记写(savePage / 外科 fm / v4 的 writeTextFile)一律 externalChange —— 编辑器只听这一条;非笔记文件
   * 走 fileChange 给插件 watchFile。判据 = vault.isPagePath(评审 G1-04:v4 笔记曾被映射成 fileChange)。
   * ⚠️ reconcilePage 是只读重载(本身就是 externalChange 的响应),映射它=回灌风暴+带新打字的
   *    窗口被旧盘面回灌丢字,绝不能进这张表(Codex P1)。
   */

  // vault 面 handler 统一注册口:落 ipcMain + 进派发表(unitWeb 的 /vault/rpc 走 callVault)。
  // A detached renderer may still hold a document from a previous cloud root.
  // Its late relative-path IPC must fail instead of targeting the new root.
  const rendererRoots = new Map<number, string | null>()
  const remoteRoots = new Map<string, string | null>()
  const pendingVaultWrites = new Set<Promise<unknown>>()
  const writesVault = (channel: string): boolean => !!VAULT_WRITE_EVENTS[channel] ||
    channel === IPC.reconcilePage || channel === IPC.patchMark
  const vaultHandlers = new Map<string, (e: unknown, ...args: any[]) => unknown>()
  const isPagePath = (rel: string): boolean => vault.isPagePath(rel)
  const handle = (channel: string, fn: (e: unknown, ...args: any[]) => unknown): void => {
    vaultHandlers.set(channel, fn)
    ipcMain.handle(channel, async (e, ...a) => {
      const mayBind = channel === IPC.restoreVault || channel === IPC.openVault
      if (!mayBind && rendererRoots.has(e.sender.id) && rendererRoots.get(e.sender.id) !== vault.getRoot()) {
        throw new Error('The active vault changed; reload the current account before editing')
      }
      const operation = Promise.resolve(fn(e, ...a))
      if (writesVault(channel)) pendingVaultWrites.add(operation)
      try {
        const r = await operation
        if (mayBind && r) rendererRoots.set(e.sender.id, (r as { root: string }).root)
        const ev = casRejected(channel, r) ? undefined : VAULT_WRITE_EVENTS[channel]?.(a, isPagePath) // 被拒的 CAS 没写,不叫人回灌
        if (ev) emitRemote(ev[0], ev[1], 'host')
        return r
      } finally { pendingVaultWrites.delete(operation) }
    })
  }

  // 云镜像迁移到隐藏目录:必须早于任何引擎创建/启动(整目录 rename,保 shadow 一致)。
  migrateCloudMirrorDir()

  const watcher = new VaultWatcher(
    vault,
    (pagePath) => {
      void index.update(pagePath) // keep search/backlinks/embeds fresh on external edits
      notifyAll(IPC.externalChange, pagePath)
    },
    () => {
      // External add/remove of pages or folders → debounce a reindex + notify the renderer.
      if (structureTimer) clearTimeout(structureTimer)
      structureTimer = setTimeout(() => {
        structureTimer = null
        // 等索引换完表再广播:渲染端被叫醒就去拉 pageIcons,早发一拍拿到的是改动前的表
        // (外部改名后新路径没图标,要等下一次刷新)。
        void index.build().catch(() => {}).then(() => notifyAll(IPC.structureChange))
      }, 300)
    },
    (dbPath) => {
      // 外部改 .db(如 agent 直连磁盘改日历)→ 通知渲染端热重载对应 dbStore 条目。
      notifyAll(IPC.dbChange, dbPath)
    },
    (filePath) => {
      // 外部改其余文件(插件片段库 .js 之类)→ 渲染端 ctx.app.watchFile 按路径分发。
      notifyAll(IPC.fileChange, filePath)
    },
  )

  const rememberPage = (pagePath: string): Promise<void> => writeConfig({ lastPage: pagePath })

  /** 切到某个根:统一收口(setRoot + watcher + index + 返回渲染端所需载荷)。 */
  const activateRoot = async (root: string, keepLastPage: boolean): Promise<{ root: string; pages: string[]; folders: string[]; lastPage?: string }> => {
    vault.setRoot(root)
    watcher.start(root)
    const pages = await vault.listPages()
    const folders = await vault.listFolders()
    await index.build()
    const { lastPage } = await readConfig()
    return {
      root,
      pages,
      folders,
      lastPage: keepLastPage && lastPage && pages.includes(lastPage) ? lastPage : undefined,
    }
  }

  /** 首启无 lastVault:自带默认工作区 ~/Forsion/Amadeus(dev→~/Forsion-Dev/Amadeus)+ 种子 Calendar.db。
   *  幂等:目录已存在不动,Calendar.db 已存在不覆盖(用户后来选过别的 vault 则走不到这里)。 */
  const ensureDefaultVault = async (): Promise<{ root: string; pages: string[]; folders: string[] }> => {
    const root = path.join(defaultWorkspaceDir(), 'Amadeus')
    await fs.mkdir(root, { recursive: true })
    vault.setRoot(root)
    try {
      await fs.access(path.join(root, 'Calendar.db'))
    } catch {
      await vault.writeTextFile('Calendar.db', serializeDb(seedCalendarDb()))
    }
    await writeConfig({ lastVault: root, localVault: root, lastPage: undefined })
    return activateRoot(root, false)
  }

  handle(IPC.openVault, async () => {
    const root = await vault.openDialog()
    if (!root) return null
    await writeConfig({ lastVault: root, localVault: root, lastPage: undefined })
    return activateRoot(root, false)
  })

  handle(IPC.restoreVault, async () => {
    let { lastVault } = await readConfig()
    if (!lastVault) return ensureDefaultVault() // 首启:自带默认工作区 + 种子多维表(不再落欢迎页)
    // A saved cloud root may belong to a previous account (or the old unowned
    // mirror). Never mount it for a different account, including signed-out boot.
    if (isManagedCloudVault(lastVault) && (!cloud || !currentCloudAccountId() || lastVault !== cloudVaultDir())) {
      const cfg = await readConfig()
      if (!cfg.localVault || isManagedCloudVault(cfg.localVault)) return ensureDefaultVault()
      lastVault = cfg.localVault
      await writeConfig({ lastVault, lastPage: undefined })
    }
    try {
      const stat = await fs.stat(lastVault)
      if (!stat.isDirectory()) return null
    } catch {
      // 活动根曾是云镜像但目录还没建(如换机):兜底重建再进
      if (lastVault === cloudVaultDir()) {
        await fs.mkdir(lastVault, { recursive: true })
        return activateRoot(lastVault, true)
      }
      return null
    }
    return activateRoot(lastVault, true)
  })

  // 发给「发起窗口以外」的本机窗口(v4 笔记写盘后的跨窗回灌,G1-01)。只认渲染层起源:Unit RPC 的
  // origin 是 null,那条的本机广播由 vaultFace.call 按 VAULT_WRITE_EVENTS 负责,这里不重复发。
  const notifyPeers = (origin: unknown, channel: string, payload?: unknown): void => {
    const sender = (origin as { sender?: unknown } | null)?.sender
    if (!sender) return
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && w.webContents !== sender) w.webContents.send(channel, payload)
  }
  registerVaultHandlers({ vault, index, handle, rememberPage, notifyAll, notifyPeers, logActivity, logNoteEdit })

  handle(IPC.openAttachment, async (_e, pagePath: string, ref: string) => {
    const abs = await vault.resolveAttachment(pagePath, ref)
    if (abs) await shell.openPath(abs)
  })

  // 附件复制是双口径:渲染层的 copy 事件先写 markdown 引用(库内粘贴无复制文件),随后主进程
  // 把同一剪贴板补成原生图片 / 文件 URL(库外聊天、文档、Finder 等直接拿到附件本体)。
  // `reference` 由当前 PM 选区序列化,绝不在主进程猜 `![[...]]` / `![](...)` 的磁盘形态。
  handle(IPC.copyAttachment, async (_e, pagePath: string, ref: string, reference: string) => {
    const abs = await vault.resolveAttachment(pagePath, ref)
    const md = typeof reference === 'string' ? reference.trim() : ''
    if (!abs || !md) return false
    const stat = await fs.stat(abs).catch(() => null)
    if (!stat?.isFile()) return false
    const url = pathToFileURL(abs).toString()
    const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const image = nativeImage.createFromPath(abs)
    const html = image.isEmpty()
      ? `<a href="${esc(url)}">${esc(path.basename(abs))}</a>`
      : `<img src="${esc(url)}" alt="${esc(path.basename(abs))}">`
    if (process.platform === 'darwin' && await writeMacAttachmentClipboard(md, url, html, image.isEmpty() ? '' : abs)) return true

    // 非 macOS 先保证文本 + HTML + 原生图片能共存;Electron 没有跨平台的 file-list 写入 API。
    // 不再追加 writeBuffer —— 它会把前面三种格式全部清掉。
    clipboard.clear()
    clipboard.write({
      text: md,
      html,
      ...(image.isEmpty() ? {} : { image }),
    })
    return true
  })

  // 树/侧栏点开:路径已知且精确 → 直接钳制解析,不走 markdown ref 的 decode/basename 兜底
  // (否则根级同名文件会开错、含字面 %xx 的文件名会被解码到不存在的路径)。
  handle(IPC.openVaultFile, async (_e, vaultRel: string) => {
    const err = await shell.openPath(vault.absPath(vaultRel))
    if (err) throw new Error(err)
  })

  // 导出 PDF:渲染端已把编辑器克隆挂到 #amx-print-root,@media print 只呈现它(见 amadeus-host.css);
  // printToPDF 走打印媒体查询,同文档内 amadeus-asset://、KaTeX 字体全部可用,无需隐藏窗口二次渲染。
  handle(IPC.exportPdf, async (_e, defaultName: string) => {
    const win = getWindow()
    if (!win) return null
    const safe = (defaultName || 'note').replace(/[\\/:*?"<>|]/g, ' ').trim() || 'note'
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `${safe}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    if (canceled || !filePath) return null
    const data = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
    await fs.writeFile(filePath, data)
    shell.showItemInFolder(filePath)
    return filePath
  })

  // 导出 CSV(多维表当前视图):文本已由渲染层算好(含 BOM),这里只负责保存对话框 + 落盘。
  // ⚠️ 落点是**用户自己选的路径**,不经 vault —— 所以不走 vault.writeTextFile 那套(它会钳到库内)。
  handle(IPC.exportCsv, async (_e, defaultName: string, csv: string) => {
    const win = getWindow()
    if (!win) return null
    const safe = (defaultName || 'database').replace(/[\\/:*?"<>|]/g, ' ').trim() || 'database'
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `${safe}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    })
    if (canceled || !filePath) return null
    await fs.writeFile(filePath, typeof csv === 'string' ? csv : '', 'utf8')
    shell.showItemInFolder(filePath)
    return filePath
  })

  handle(IPC.fetchLinkMeta, (_e, url: string) => fetchLinkMeta(url))
  handle(IPC.searchImages, (_e, q: string) => searchImages(q))

  // Forsion(UI)插件单一目录(market type='amadeus-plugin' 装到同目录)。vault 级装载已砍——
  // Amadeus 只是一个 Space,插件属于 Forsion 桌面本体,不属于某个 vault。
  const globalPluginsDir = (): string => path.join(forsionHomeDir(), 'plugins')

  // 插件 id 统一门禁:manifest id 合法用它,否则回退目录名,两者皆非法 → 拒载。发现与卸载共用同一
  // 规则,否则会出现「能列出/能运行、点卸载却被 id 校验拒绝」的卸不掉插件(codex P1-9);
  // 该 id 还进 localStorage 键与 Space 归属,必须先掐住。
  const SAFE_PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
  const pluginIdOf = effectivePluginId // 单源:与产物注册表同一条规则(shared/products.ts)

  // 卸载墓碑:被卸载插件声明过的文件扩展名**永久**留在 listPages 排除集(毁档防线不随卸载失效——
  // 库里的数据文件还在,掉回笔记被 compiler 改写=毁档,codex P1-1)。文件在共享域顶层,
  // 用户确认迁移/清理数据后可手动删除。
  const extTombstonesFile = (): string => path.join(forsionHomeDir(), 'plugins-ext-tombstones.json')
  const readExtTombstones = (): string[] => {
    try {
      const v = JSON.parse(readFileSync(extTombstonesFile(), 'utf8')) as unknown
      return Array.isArray(v) ? v.filter(isSafePluginExt) : []
    } catch {
      return []
    }
  }

  // 同步预扫插件目录的 manifest.json,收集并校验其 fileExtensions —— 只读 manifest,不依赖 main.js(插件坏了也保住
  // 扩展名保护,Codex #3);同步执行以便在任何 listPages 之前就绪,关掉「listPages 先于 listPlugins 注入」的启动竞态(Codex #2)。
  const collectPluginExts = (): string[] => {
    const exts = new Set<string>(readExtTombstones()) // 已卸载插件的扩展名豁免持久生效
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(globalPluginsDir(), { withFileTypes: true })
    } catch {
      return [...exts] // 插件目录没了,墓碑(已卸载插件的后缀豁免)照样要生效 —— 返回 [] 会让那些文件掉回笔记管线
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      try {
        const m = JSON.parse(readFileSync(path.join(globalPluginsDir(), e.name, 'manifest.json'), 'utf8')) as {
          fileExtensions?: unknown
        }
        if (Array.isArray(m.fileExtensions))
          for (const x of m.fileExtensions) if (isSafePluginExt(x)) exts.add(x.trim().toLowerCase())
      } catch {
        /* skip malformed */
      }
    }
    return [...exts]
  }

  // 捆绑包(bundle)内嵌内容清点:标志文件识别,manifest 无新增字段。引擎插件取 tangu-plugin.json 的真 id
  // (目录名可与 id 不同;启停级联/引擎列表去重都按 id 对齐),其余三类取目录名 slug。
  const collectBundleInfo = async (pdir: string): Promise<PluginBundleInfo | undefined> => {
    const subDirs = async (sub: string): Promise<string[]> => {
      try {
        return (await fs.readdir(path.join(pdir, sub), { withFileTypes: true }))
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => e.name)
      } catch {
        return [] // 子目录不存在 = 该类内容为空
      }
    }
    const withMarker = async (sub: string, marker: string): Promise<string[]> => {
      const out: string[] = []
      for (const name of await subDirs(sub)) {
        try { await fs.access(path.join(pdir, sub, name, marker)); out.push(name) } catch { /* 无标志文件跳过 */ }
      }
      return out.sort()
    }
    const enginePlugins: string[] = []
    for (const name of await subDirs('tangu-plugins')) {
      try {
        const m = JSON.parse(await fs.readFile(path.join(pdir, 'tangu-plugins', name, 'tangu-plugin.json'), 'utf8')) as { id?: string }
        enginePlugins.push(m.id || name)
      } catch { /* 无/坏 manifest 跳过(引擎侧同样不认) */ }
    }
    enginePlugins.sort()
    const [agents, skills, spaces] = await Promise.all([
      withMarker('agents', 'config.toml'),
      withMarker('skills', 'SKILL.md'),
      withMarker('spaces', 'space.json'),
    ])
    return enginePlugins.length || agents.length || skills.length || spaces.length
      ? { enginePlugins, agents, skills, spaces }
      : undefined
  }

  /** Agent 自建 Space 插件(2026-09-11):`<tanguDataDir>/agents/<slug>/Space/{manifest.json,main.js}` 当外置插件装载。
   *  · id 固定 `agent-<slug>`(manifest 写什么都不认,防顶掉真插件;主根同 id 先扫先赢);
   *  · capabilities / fileExtensions / requiresApp / onboarding / events / bundle 一律不带 —— 没有「用户点安装」这一步授权,
   *    引擎也只认一个 bundle 根(子目录放了也不生效);不可卸载,想不用关开关;
   *  · 目录空 / 无 Space → 不列;有 main.js 但 manifest 缺失或坏 → 列出为 blocked:'invalid' 带原因,让桌面把失败回写给 agent
   *    (agentSpaceSync),而不是静默消失。只有桌面 IPC 路径带它(unit 设备页不带:Space 主槽在桌面)。 */
  const readAgentSpacePlugins = async (seen: Set<string>): Promise<ExternalPluginSource[]> => {
    const out: ExternalPluginSource[] = []
    const root = path.join(tanguDataDir(), 'agents')
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(root, { withFileTypes: true })
    } catch {
      return out
    }
    type SpaceManifest = { name?: unknown; nameEn?: unknown; version?: unknown; description?: unknown; descriptionEn?: unknown; main?: unknown; apiVersion?: unknown; minAppVersion?: unknown }
    for (const e of entries) {
      if (!e.isDirectory() || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(e.name)) continue
      const id = `agent-${e.name}`
      if (seen.has(id)) continue
      const sdir = path.join(root, e.name, 'Space')
      let m: SpaceManifest | null = null
      let invalid = ''
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(path.join(sdir, 'manifest.json'), 'utf8'))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid = 'manifest.json must be a JSON object'
        else m = parsed as SpaceManifest
      } catch (err) {
        try { await fs.access(path.join(sdir, 'main.js')) } catch { continue } // 没有 Space(目录空)→ 不列
        invalid = `manifest.json missing or unparsable: ${err instanceof Error ? err.message : String(err)}`
      }
      const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)
      const blocked = invalid ? 'invalid' : gatePluginManifest({ apiVersion: m?.apiVersion, minAppVersion: m?.minAppVersion }, app.getVersion())
      let code = ''
      if (!blocked) {
        const mainName = str(m?.main, 120)
        const rel = mainName && !mainName.includes('..') && !path.isAbsolute(mainName) ? mainName : 'main.js'
        try {
          code = await fs.readFile(path.join(sdir, rel), 'utf8')
        } catch (err) {
          invalid = `${rel} unreadable: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      const [readme, changelog, iconUrl] = await Promise.all([
        fs.readFile(path.join(sdir, 'README.md'), 'utf8').then((s) => s.slice(0, 65536), () => undefined),
        fs.readFile(path.join(sdir, 'CHANGELOG.md'), 'utf8').then((s) => s.slice(0, 65536), () => undefined),
        readPluginIconDataUrl(sdir),
      ])
      seen.add(id)
      out.push({
        id,
        name: str(m?.name, 120) || `${e.name} Space`,
        version: str(m?.version, 40) || '0.0.0',
        description: str(m?.description, 2000),
        nameEn: str(m?.nameEn, 120),
        descriptionEn: str(m?.descriptionEn, 2000),
        iconUrl,
        code: invalid ? '' : code,
        apiVersion: typeof m?.apiVersion === 'number' ? m.apiVersion : 1,
        minAppVersion: str(m?.minAppVersion, 40),
        readme,
        changelog,
        blocked: invalid ? 'invalid' : blocked ?? undefined,
        blockedReason: invalid || undefined,
        agent: e.name,
      })
    }
    return out
  }

  /** Coding Space 的托管项目根(~/Forsion/Project;dev 家 = ~/Forsion-Dev/Project)。与 main.ts 的
   *  `projectsRoot` 同一推导(defaultWorkspaceDir() + 'Project'),别在这里硬编码 ~。 */
  const projectsRootDir = (): string => path.join(defaultWorkspaceDir(), 'Project')

  /**
   * Forsion Sandbox 的**开发态插件来源**(2026-09-21):托管根下开了 `devLoad` 的插件项目,免安装直接进插件宿主。
   * 纪律:
   *  · **不是隔离沙箱** —— 跑在真应用、真笔记库,权限与已安装插件完全相同(所以 capabilities / onboarding / events
   *    一律照发,开发者才测得出自己声明的能力);「安全」由「用户自己在自己的项目上开了这个开关」承担,UI 如实写明。
   *  · 判据是**磁盘上有没有 manifest.json**,不是 product.kind:清单写坏的那一刻 detectKind 会把项目判回 web/unknown,
   *    按 kind 过滤等于「JSON 打错一个逗号,插件从列表里凭空消失、安装版还悄悄顶上来」。没有 manifest.json 才算不是插件。
   *  · 清单坏 / main 读不到 → 列出为 blocked:'invalid' 带原因(与 agent Space 同款),绝不静默消失。
   *  · 声明了 fileExtensions → blocked:'dev-fileext' 且**不读代码**:扩展名保护(collectPluginExts → listPages 排除)
   *    只扫全局 plugins 目录,开发副本造出来的自定义类型文件没人护着,会被笔记 compiler 改写 = 毁档。
   *  · bundle 一律不收:内嵌 agent/技能/引擎插件是「安装」这一步的播种动作,开发态加载不该往引擎里种东西。
   */
  const readDevPlugins = async (seen: Set<string>): Promise<ExternalPluginSource[]> => {
    const out: ExternalPluginSource[] = []
    // ⚠️来源名单 = **宿主家目录里的授权**(devLoadStore),不是项目 sidecar 里的标志:项目目录不可信,
    //   克隆 / 解压来的文件夹自带一个 `devLoad:true` 就能零点击以插件权限执行 —— 第一版就是这么漏的(评审 HIGH)。
    //   授权按「产物 id + 授权当时的真实根」双钥匙核对;复制出来的项目(id 被重铸)与搬了家的 sidecar 都对不上。
    const products: NonNullable<Awaited<ReturnType<typeof getProduct>>>[] = []
    const authorizedPluginId = new Map<string, string | null>() // 产物 id → 授权当时的生效插件 id(清单写坏期间沿用)
    const loads = readDevLoads(forsionHomeDir())
    for (const [pid, grant] of Object.entries(loads)) {
      const product = await getProduct(projectsRootDir(), pid).catch(() => null) // 托管根不存在 / 扫不动 → 当没有
      // 按目录身份(dev+ino)核,不比路径:项目文件夹改了名授权照旧;同 id 的 sidecar 搬进别的文件夹不算。
      if (product && isDevLoaded(loads, product)) { products.push(product); authorizedPluginId.set(product.id, grant.pluginId) }
    }
    products.sort((a, b) => b.updatedAt - a.updatedAt) // 两个项目声明同一个插件 id 时先到先得,顺序得确定
    type DevManifest = {
      id?: unknown; name?: unknown; nameEn?: unknown; version?: unknown; description?: unknown; descriptionEn?: unknown
      main?: unknown; apiVersion?: unknown; minAppVersion?: unknown; requiresApp?: unknown
      capabilities?: unknown; onboarding?: unknown; events?: unknown; fileExtensions?: unknown
    }
    for (const product of products) {
      const pdir = product.root
      let m: DevManifest | null = null
      let invalid = ''
      let raw: string
      try {
        raw = await fs.readFile(path.join(pdir, 'manifest.json'), 'utf8')
      } catch {
        continue // 没有清单 = 这个项目压根不是 Forsion 插件(web 项目误开了开关)→ 不列
      }
      try {
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid = 'manifest.json must be a JSON object'
        else m = parsed as DevManifest
      } catch (err) {
        invalid = `manifest.json unparsable: ${err instanceof Error ? err.message : String(err)}`
      }
      // 清单读不出来时**沿用授权当时的 id**:否则少一个逗号,身份就从 `my-plugin` 漂成目录名 `cool-project`,
      // 被影子住的安装版悄悄回来、开发副本的报错挂到一个没人看的 id 上(Codex 评审)。
      const id = (m ? pluginIdOf(path.basename(pdir), m.id) : null) ?? authorizedPluginId.get(product.id) ?? pluginIdOf(path.basename(pdir), undefined)
      if (!id) {
        console.warn(`[amadeus] 开发态项目 "${path.basename(pdir)}" 的 manifest id 与目录名均非法(须 kebab-case),拒载`)
        continue
      }
      if (seen.has(id)) continue // 两个项目声明同一个插件 id:先扫到的赢(scanProducts 按 updatedAt 倒序,确定)
      const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)
      const declaresExts = Array.isArray(m?.fileExtensions) && m.fileExtensions.some((x) => typeof x === 'string' && !!x)
      let blocked: ExternalPluginSource['blocked'] | null = invalid
        ? 'invalid'
        : gatePluginManifest({ apiVersion: m?.apiVersion, minAppVersion: m?.minAppVersion }, app.getVersion())
          ?? (declaresExts ? 'dev-fileext' : null)
      let code = ''
      if (!blocked) {
        const mainName = str(m?.main, 120) || 'main.js'
        const rel = !mainName.includes('..') && !path.isAbsolute(mainName) ? mainName : 'main.js'
        try {
          code = await fs.readFile(path.join(pdir, rel), 'utf8')
        } catch (err) {
          invalid = `${rel} unreadable: ${err instanceof Error ? err.message : String(err)}`
          blocked = 'invalid'
        }
      }
      const [readme, changelog, iconUrl] = await Promise.all([
        fs.readFile(path.join(pdir, 'README.md'), 'utf8').then((s) => s.slice(0, 65536), () => undefined),
        fs.readFile(path.join(pdir, 'CHANGELOG.md'), 'utf8').then((s) => s.slice(0, 65536), () => undefined),
        readPluginIconDataUrl(pdir),
      ])
      seen.add(id)
      out.push({
        id,
        name: str(m?.name, 120) || product.name,
        version: str(m?.version, 40) || '0.0.0',
        description: str(m?.description, 2000),
        nameEn: str(m?.nameEn, 120),
        descriptionEn: str(m?.descriptionEn, 2000),
        iconUrl,
        code: blocked ? '' : code,
        apiVersion: typeof m?.apiVersion === 'number' ? m.apiVersion : 1,
        minAppVersion: str(m?.minAppVersion, 40),
        requiresApp: str(m?.requiresApp, 120),
        capabilities: Array.isArray(m?.capabilities)
          ? PLUGIN_CAPABILITIES.filter((c) => (m.capabilities as unknown[]).includes(c))
          : undefined,
        readme,
        changelog,
        onboarding: sanitizeOnboarding(m?.onboarding),
        events: sanitizeEvents(m?.events),
        // fileExtensions 刻意不透出:声明了就已经 blocked,再把它传下去只会让下游误以为这套后缀受保护。
        blocked: blocked ?? undefined,
        blockedReason: invalid || (blocked === 'dev-fileext'
          ? 'fileExtensions are only protected for installed plugins; install this plugin to claim custom file types'
          : undefined),
        dev: true,
        devRoot: pdir,
        devProductId: product.id,
        // preinstalled 一律不给:开发副本哪怕与随 App 播种的插件同 id,也不是那份内置包(标了就没有任何按钮可点)。
      })
    }
    return out
  }

  /** 外置插件全量读取(manifest 门禁 + bundle 收集 + 代码/文档)。IPC listPlugins 与
   *  unitHost 的 /__unit/plugins 自服面共用 —— 设备互联把同一份插件面分发给远端渲染器。
   *  opts.agents:附带 agent 自建 Space 插件;opts.dev:附带开发态来源(**只有桌面 IPC 传 true**)。 */
  const readExternalPlugins = async (opts: { agents?: boolean; dev?: boolean } = {}): Promise<ExternalPluginSource[]> => {
    const seen = new Set<string>()
    const out: ExternalPluginSource[] = []
    // 开发态来源**先扫**:同 id 时先扫先赢(seen),于是开发副本遮蔽安装版 —— 这正是「改完立刻看到自己的版本」。
    const devSources = opts.dev ? await readDevPlugins(seen) : []
    const devById = new Map(devSources.map((s) => [s.id, s]))
    out.push(...devSources)
    let entries: import('node:fs').Dirent[] = []
    try {
      entries = await fs.readdir(globalPluginsDir(), { withFileTypes: true })
    } catch {
      // 全局插件目录还不存在(一个插件都没装):开发态来源照样要发出去,不能在这里整条返回。
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      const pdir = path.join(globalPluginsDir(), e.name)
      try {
        const m = JSON.parse(await fs.readFile(path.join(pdir, 'manifest.json'), 'utf8')) as {
          id?: string
          name?: string
          nameEn?: string
          version?: string
          description?: string
          descriptionEn?: string
          main?: string
          apiVersion?: number
          minAppVersion?: string
          requiresApp?: string
          capabilities?: unknown
          onboarding?: unknown
          fileExtensions?: unknown
          events?: unknown
        }
        const id = pluginIdOf(e.name, m.id)
        if (!id) {
          console.warn(`[amadeus] 插件目录 "${e.name}" 的 manifest id 与目录名均非法(须 kebab-case),拒载`)
          continue
        }
        // 开发副本正顶着这个 id:告诉渲染层「你遮住了一份安装版」(Studio 要显示,卸载也要据此拒绝),
        // 必须赶在下面那句 seen 去重之前 —— 开发态 id 已经在 seen 里了,晚一行就永远标不上。
        const shadowed = devById.get(id)
        if (shadowed) { shadowed.shadowsInstalled = true; continue }
        if (seen.has(id)) continue
        // 门禁:apiVersion 不匹配 / 应用太旧 → 列出但不可加载(blocked 徽章),code 不读不发。
        const blocked = gatePluginManifest(m, app.getVersion())
        const bundle = await collectBundleInfo(pdir)
        // main.js 仅在「未显式声明 main 且确是捆绑包」时可省(空代码 no-op);显式声明的 main 读不到 /
        // 非捆绑包缺 main 仍整体拒载——否则坏插件伪装成「已启用的空壳」,功能静默缺失(codex P2-2)。
        let code = ''
        if (!blocked) {
          try {
            code = await fs.readFile(path.join(pdir, m.main || 'main.js'), 'utf8')
          } catch (err) {
            if (m.main || !bundle) throw err
          }
        }
        // README 给设置详情页;blocked 也读(无害,帮用户了解这插件是什么)。CHANGELOG 同款,渲染成「更新日志」段。
        const [readme, changelog, iconUrl] = await Promise.all([
          fs.readFile(path.join(pdir, 'README.md'), 'utf8').then((s) => s.slice(0, 65536), () => undefined),
          fs.readFile(path.join(pdir, 'CHANGELOG.md'), 'utf8').then((s) => s.slice(0, 65536), () => undefined),
          readPluginIconDataUrl(pdir),
        ])
        seen.add(id)
        out.push({
          id,
          name: m.name || e.name,
          version: m.version || '0.0.0',
          description: m.description,
          // 英文镜像:纯展示用,坏了就当没有(中文 canonical 永远兜底)。
          nameEn: typeof m.nameEn === 'string' && m.nameEn.trim() ? m.nameEn.trim().slice(0, 120) : undefined,
          descriptionEn: typeof m.descriptionEn === 'string' && m.descriptionEn.trim() ? m.descriptionEn.trim().slice(0, 2000) : undefined,
          iconUrl,
          code,
          apiVersion: typeof m.apiVersion === 'number' ? m.apiVersion : 1,
          minAppVersion: typeof m.minAppVersion === 'string' ? m.minAppVersion : undefined,
          requiresApp: typeof m.requiresApp === 'string' ? m.requiresApp : undefined,
          // 敏感能力:只认白名单里的字符串,别的静默丢(插件写什么都不能凭空造出接缝)。
          capabilities: Array.isArray(m.capabilities)
            ? PLUGIN_CAPABILITIES.filter((c) => (m.capabilities as unknown[]).includes(c))
            : undefined,
          readme,
          changelog,
          onboarding: sanitizeOnboarding(m.onboarding),
          events: sanitizeEvents(m.events),
          fileExtensions: Array.isArray(m.fileExtensions)
            ? m.fileExtensions.filter((x): x is string => typeof x === 'string' && !!x).slice(0, 8)
            : undefined,
          blocked: blocked ?? undefined,
          bundle,
          preinstalled: builtinPluginIds().has(id) || undefined, // 随 App 播种的捆绑包(electron/builtinPlugins.ts)
          locked: lockedPluginIds().has(id) || undefined, // 其中带主进程半身的(Forsion Extend):不给启停开关
        })
      } catch {
        /* skip malformed plugin */
      }
    }
    // 主进程 listPages 排除的扩展名 → 用独立的 manifest 预扫(不依赖各插件 main.js 是否可读,Codex #3),
    // 而非从 out 派生。按 manifest 声明豁免(与启用态无关):禁用/坏掉的插件也不能让其文件掉回笔记被 compiler 改写=毁档。
    vault.setPluginFileExtensions(collectPluginExts())
    if (opts.agents) out.push(...(await readAgentSpacePlugins(seen))) // 主根之后:同 id 主根先赢
    return out
  }
  handle(IPC.listPlugins, () => readExternalPlugins({ agents: true, dev: true }))

  handle(IPC.openPluginsFolder, async () => {
    const dir = globalPluginsDir()
    await fs.mkdir(dir, { recursive: true })
    await shell.openPath(dir)
  })

  // ── 插件私有数据 blob(ctx.loadData / ctx.saveData)。~/.forsion/plugins-data/<id>.json。
  // 为什么不复用 registerSetting:那是「每键一个字符串塞 localStorage」,装不下几十 KB 的
  // 片段库,也没有原子性。为什么不落 vault:插件数据跟着**应用**走,不跟着某个笔记库走
  // (换库不该丢配置),与 plugins/ 目录同域。
  // ⚠️id 必须过 SAFE_PLUGIN_ID —— 它直接拼进文件名,`../` 就是任意写。
  const pluginDataFile = (id: unknown): string | null =>
    typeof id === 'string' && SAFE_PLUGIN_ID.test(id)
      ? path.join(forsionHomeDir(), 'plugins-data', `${id}.json`)
      : null

  handle(IPC.pluginDataRead, async (_e, id: string): Promise<string | null> => {
    const f = pluginDataFile(id)
    if (!f) return null
    try {
      return await fs.readFile(f, 'utf8')
    } catch {
      return null // 没写过 = null,与「读失败」同一出口:插件侧只需一条 `?? 默认值`
    }
  })

  handle(IPC.pluginDataWrite, async (_e, id: string, text: string): Promise<void> => {
    const f = pluginDataFile(id)
    if (!f) throw new Error('非法插件 id')
    await fs.mkdir(path.dirname(f), { recursive: true })
    // 原子写:直接覆盖会在崩溃/断电时留下半截 JSON,而这里存的是用户手写的片段库。
    const tmp = `${f}.tmp-${process.pid}-${Date.now()}`
    await fs.writeFile(tmp, String(text ?? ''), 'utf8')
    await fs.rename(tmp, f)
  })

  handle(IPC.revealInFileManager, async (_e, targetPath: string) => {
    // Clamp to the vault, then select the item in the OS file manager. showItemInFolder
    // opens the parent and highlights the entry — works for both files and folders.
    const abs = vault.absPath(targetPath)
    shell.showItemInFolder(abs)
  })

  handle(IPC.scaffoldPlugin, async () => {
    const pdir = path.join(globalPluginsDir(), 'hello-amadeus')
    await fs.mkdir(pdir, { recursive: true })
    await fs.writeFile(path.join(pdir, 'manifest.json'), SAMPLE_MANIFEST, 'utf8')
    await fs.writeFile(path.join(pdir, 'main.js'), SAMPLE_MAIN, 'utf8')
  })

  // 卸载 Forsion 插件:按 manifest id 定位目录(id 可与目录名不同;与 listPlugins 同一 pluginIdOf 门禁)整删。
  // 只动 ~/.forsion/plugins;内嵌 agent 已播种进引擎的按「播种一次」语义保留(活体),
  // 内嵌引擎插件需重启引擎后消失(调用方负责提示/重启)。
  handle(IPC.uninstallPlugin, async (_e, id: string) => {
    if (typeof id !== 'string' || !SAFE_PLUGIN_ID.test(id)) throw new Error('invalid-plugin-id') // 原因码,渲染层 ipcErrorText 译
    // ⚠️开发副本正遮蔽同 id 的安装版时必须拒绝:这里只扫全局目录,删掉的是**安装版**,而跑着的是开发副本 ——
    // 用户看到「已卸载」,插件却还在;等哪天撤下开发副本,它才凭空消失(且没有任何提示)。先撤开发副本再卸载。
    // 消息前缀 `dev-shadowed:` 是给渲染层认的机器码(用户可见文案在设置页按当前语言渲染)。
    if ((await readDevPlugins(new Set())).some((s) => s.id === id)) {
      throw new Error(`dev-shadowed: unload the development copy of "${id}" before uninstalling the installed one`)
    }
    const root = globalPluginsDir()
    let target: string | null = null
    let entries: import('node:fs').Dirent[] = []
    try {
      entries = await fs.readdir(root, { withFileTypes: true })
    } catch { /* 目录不存在 → 下面按未找到报错 */ }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      let manifestId: unknown
      try {
        manifestId = (JSON.parse(await fs.readFile(path.join(root, e.name, 'manifest.json'), 'utf8')) as { id?: string }).id
      } catch { /* manifest 坏/缺:按目录名兜底 */ }
      if (pluginIdOf(e.name, manifestId) === id) { target = path.join(root, e.name); break }
    }
    if (!target) throw new Error('plugin-not-found')
    // 墓碑:声明过的扩展名永久保留豁免(库里数据文件还在,掉回笔记=毁档),再删目录。
    try {
      const m = JSON.parse(await fs.readFile(path.join(target, 'manifest.json'), 'utf8')) as { fileExtensions?: unknown }
      const claimed = Array.isArray(m.fileExtensions)
        ? m.fileExtensions.filter(isSafePluginExt).map((x) => x.trim().toLowerCase())
        : []
      if (claimed.length) {
        const merged = [...new Set([...readExtTombstones(), ...claimed])].sort()
        await fs.writeFile(extTombstonesFile(), JSON.stringify(merged, null, 2), 'utf8')
      }
    } catch { /* manifest 坏/缺 → 无可声明 */ }
    await fs.rm(target, { recursive: true, force: true })
    vault.setPluginFileExtensions(collectPluginExts()) // 重算(含墓碑):保护不随卸载失效
  })

  // ctx.tangu.startChat 的 send:true 归属判定(2026-09-19)。bundle.agents 只说明「插件目录里有 agents/<slug>/」,
  // 不说明引擎播种的是它 —— 同 slug 已存在(用户自建 / 默认 xyra / 别家插件先播)时 seedBundleAgents 永不覆盖,
  // 插件却照样能对别人的 Agent 直发。引擎只在**新播种**时写 agents/<slug>/.bundle-origin = bundle 目录名
  // (tangu-agent/src/plugins/bundles.ts 的 BUNDLE_ORIGIN_FILE,改一边必须改另一边),这里拿它比本插件的目录名。
  // 目录按 readExternalPlugins 同一口径定位(manifest 可解析 + pluginIdOf,先扫先赢;manifest id 可与目录名不同,
  // 两侧都用目录名)。agents 根 = tanguDataDir()/agents(= backendManager 传给引擎的 TANGU_HOME)。
  // 任何异常 / 缺标记(含本修复之前播种的老 agent)→ false,渲染层降级为预填(fail closed)。
  const BUNDLE_AGENT_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/ // = 引擎 bundles.ts 的 SAFE_SLUG
  const pluginDirNameOf = async (id: string): Promise<string | null> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(globalPluginsDir(), { withFileTypes: true })
    } catch {
      return null
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      try {
        const m = JSON.parse(await fs.readFile(path.join(globalPluginsDir(), e.name, 'manifest.json'), 'utf8')) as { id?: unknown }
        if (pluginIdOf(e.name, m?.id) === id) return e.name
      } catch { /* manifest 坏/缺:readExternalPlugins 同样不列 */ }
    }
    return null
  }
  handle(IPC.bundleAgentOwned, async (_e, pluginId: unknown, slug: unknown): Promise<boolean> => {
    if (typeof pluginId !== 'string' || !SAFE_PLUGIN_ID.test(pluginId)) return false
    if (typeof slug !== 'string' || !BUNDLE_AGENT_SLUG.test(slug)) return false
    try {
      const dirName = await pluginDirNameOf(pluginId)
      if (!dirName) return false
      const marker = path.join(tanguDataDir(), 'agents', slug, '.bundle-origin')
      const st = await fs.lstat(marker)
      if (!st.isFile() || st.size > 256) return false
      return (await fs.readFile(marker, 'utf8')).trim() === dirName
    } catch {
      return false
    }
  })

  // 启动即同步预扫插件扩展名 → 早于渲染端 restoreVault→listPages,关掉「.mindmap.md 被当页面加载」的启动竞态(Codex #2)。
  vault.setPluginFileExtensions(collectPluginExts())

  // 云同步 + collab(Forsion Extend 0.4 起,cloudSeam.ts):vault / watcher / index 都建好了才递接缝、拿回引擎面并启动。
  // 没装 Extend(缺包 / 验签失败 / 老版本)= 本机没有云同步:11 个通道没人接,preload 不暴露 amadeusSync / amadeusCollab,渲染层自动隐藏。
  const cloud = cloudFactory?.({
    readCreds: () => { const c = loadTanguCreds(); return { cloudUrl: c.cloudUrl || '', token: c.token || '' } },
    accountId: currentCloudAccountId,
    homeDir: forsionHomeDir,
    workspaceDir: defaultWorkspaceDir,
    userDataDir: () => app.getPath('userData'),
    isDevMode,
    readConfig, writeConfig, updateConfig, adoptLegacyCloudState,
    cloudVaultDir, isManagedCloudVault,
    vaultRoot: () => vault.getRoot(),
    setMutationHooks: (onMutate, onMove, onBeforeMove) => vault.setMutationHooks(onMutate, onMove, onBeforeMove),
    activateRoot,
    ensureDefaultVault,
    bindRenderer: (senderId, root) => { rendererRoots.set(senderId, root) },
    awaitPendingVaultWrites: async () => { while (pendingVaultWrites.size) await Promise.allSettled([...pendingVaultWrites]) },
    relatedClosure: (rootRel, kind) => index.relatedClosure(rootRel, kind),
    notifyAll,
    onBeforeQuit: (cb) => { app.once('before-quit', cb); return () => { app.removeListener('before-quit', cb) } },
    log: (m) => console.warn(m),
  }) ?? null
  cloud?.start() // 云镜像同步独立于活动 vault,应用启动即拉起(未登录/显式停用时安静待命)

  return {
    getVaultRoot: () => vault.getRoot(),
    /** 登录成功后由 main 调:重读凭据、拉起云端双向同步(修「已登录仍显示登录提示 + 同步没开」)。 */
    restartSync: () => cloud?.restartAllSync() ?? Promise.resolve(),
    stopSync: () => cloud?.stopAllSync() ?? Promise.resolve(),
    readExternalPlugins,
    // Unit 设备页的本地 vault 面(unitWeb /vault/*):白名单在 unitWeb.ts(default-deny),这里只管派发。
    vaultFace: {
      call: async (channel, args, origin) => {
        const fn = vaultHandlers.get(channel)
        if (!fn) throw new Error(`unknown vault channel: ${channel}`)
        const key = origin ?? 'remote'
        const mayBind = channel === IPC.restoreVault || channel === IPC.openVault
        if (!mayBind && remoteRoots.has(key) && remoteRoots.get(key) !== vault.getRoot()) {
          throw new Error('The active vault changed; reload the current account before editing')
        }
        const operation = Promise.resolve(fn(null, ...args))
        if (writesVault(channel)) pendingVaultWrites.add(operation)
        try {
          const r = await operation
          if (mayBind && r) remoteRoots.set(key, (r as { root: string }).root)
          const ev = casRejected(channel, r) ? undefined : VAULT_WRITE_EVENTS[channel]?.(args, isPagePath) // 同上
          if (ev) {
            notifyWindows(ev[0], ev[1])
            emitRemote(ev[0], ev[1], origin ?? null)
          }
          return r
        } finally { pendingVaultWrites.delete(operation) }
      },
      onEvent: (cb) => { vaultEventSubs.add(cb); return () => { vaultEventSubs.delete(cb) } },
      assetAbs: (page, ref) => vault.resolveAttachment(page ?? '', ref),
      absPath: (rel) => vault.absPath(rel),
      root: () => vault.getRoot(),
    },
  }
}
