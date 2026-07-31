import { promises as fs, readdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { IPC, gatePluginManifest, sanitizeOnboarding, sanitizeEvents, type DbReadResult, type DrawingReadResult, type ExternalPluginSource, type PageProps, type PluginBundleInfo } from '@amadeus-shared/ipc'
import { dbFileSchema, parseDb, serializeDb, seedCalendarDb } from '@amadeus-shared/db/schema'
import { rewriteDbRefs } from '@amadeus-shared/db/rewriteDbRefs'
import { parseFmObject, setFmExtraOnSource } from '@amadeus-shared/db/pageFrontmatter'
import { extractFrontmatterExtra } from '@amadeus-shared/compiler/split'
import { loadPage, newPage, pageFileName, savePage } from '@amadeus-shared/compiler'
import type { PageManifest } from '@amadeus-shared/compiler'
import { VaultManager } from './fs/vaultManager'
import { VaultWatcher } from './fs/watcher'
import { VaultIndex } from './fs/vaultIndex'
import { withDbLock } from './fs/dbLock'
import { readConfig, writeConfig } from './settings'
import { defaultWorkspaceDir, forsionHomeDir } from '../forsionHome'
import { logActivity, logNoteEdit } from '../activityLog'
import { loadTanguCreds } from '../forsionAuth'
import { fetchLinkMeta, searchImages } from './linkMeta'
import { cloudVaultDir, legacyCloudVaultDir, migrateCloudMirrorDir, createSyncEngine } from './sync/engine'
import { createCollabMain, planOf, type SharedBindingPlan } from './sync/collabMain'
import { SYNC_IPC } from './sync/ipcKeys'
import {
  applyRemoteOpToEntries,
  buildScope,
  hash8,
  rewriteEntriesForMove,
  scopeMatches,
  validateCloudName,
  type ScopeSet,
} from './sync/entryRegistry'
import { deleteShadowFile } from './sync/shadow'
import type { CloudChange } from './sync/cloudClient'

const nowIso = (): string => new Date().toISOString()

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
  run: () => ctx.app.notify('你好，来自示例插件 👋'),
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
return () => {}
`

/** .db 写回票据 = 文件内容短哈希。用内容而非 mtime:程序化连写可能落在同一毫秒里。 */
function dbVersion(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

export function registerIpc(getWindow: () => BrowserWindow | null): {
  getVaultRoot: () => string | null
  restartSync: () => void
} {
  const vault = new VaultManager()
  const index = new VaultIndex(vault)
  let structureTimer: ReturnType<typeof setTimeout> | null = null

  // 文件变更回灌播给**所有**窗口:拖出的 detached 窗里同样有编辑器/画板/日历,
  // 只发主窗 = 那些窗永远显示旧内容(getWindow() 恒为主窗)。
  const notifyAll = (channel: string, payload?: unknown): void => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }

  // 云镜像迁移到隐藏目录:必须早于任何引擎创建/启动(整目录 rename,保 shadow 一致)。
  migrateCloudMirrorDir()

  // 云同步引擎:云 vault = 固定本地镜像目录(cloudVaultDir),独立于用户自选 vault,自带 watcher。
  // 引擎自己的写盘绕开 VaultManager 台账 → 活动 vault 是镜像时主 watcher 照常广播 →
  // 渲染端刷新/索引全部走既有通道;对账按 hash 幂等消回推环。
  // 多绑定:own 引擎(自己的云库,排除「与我共享/」)+ 每个已接受的页面共享一个引擎
  // (镜像到 与我共享/<title>-<hash8>/,离线可读、双向同步;写权限由服务端按角色判)。
  const collabMain = createCollabMain()
  const presenceRoster = new Map<string, { userId: string; username: string; page: string | null; at: number }>()
  const pushRoster = (): void => {
    const now = Date.now()
    for (const [k, p] of presenceRoster) if (now - p.at > 70_000) presenceRoster.delete(k)
    getWindow()?.webContents.send(SYNC_IPC.presence, [...presenceRoster.values()])
  }
  const engineDeps = {
    loadCreds: () => loadTanguCreds(),
    // pendingDeletions 恒发全引擎合计:设置页整包替换状态,若只带本引擎计数,别的引擎持有的
    // 待确认删除会被一条无关事件顶掉 → 确认按钮消失、删除卡死。
    onStatus: (s: unknown) =>
      getWindow()?.webContents.send(SYNC_IPC.status, {
        ...(s as object),
        pendingDeletions: totalPendingDeletions(),
        side: onCloudSide() ? 'cloud' : 'local',
      }),
    onPresence: (_vaultId: string, d: unknown) => {
      const p = d as { userId?: string; username?: string; page?: string | null; at?: number } | null
      if (!p?.userId) return
      presenceRoster.set(p.userId, { userId: p.userId, username: String(p.username ?? 'user'), page: p.page ?? null, at: Number(p.at) || Date.now() })
      pushRoster()
    },
    onPresenceRoster: (_vaultId: string, d: unknown) => {
      if (!Array.isArray(d)) return
      for (const raw of d) {
        const p = raw as { userId?: string; username?: string; page?: string | null; at?: number }
        if (p?.userId) presenceRoster.set(p.userId, { userId: p.userId, username: String(p.username ?? 'user'), page: p.page ?? null, at: Number(p.at) || Date.now() })
      }
      pushRoster()
    },
  }
  const sync = createSyncEngine(engineDeps)
  /** 与我共享的绑定引擎(key=planOf hash8)。 */
  const sharedEngines = new Map<string, { engine: ReturnType<typeof createSyncEngine>; plan: SharedBindingPlan }>()
  let sharedPlans: SharedBindingPlan[] = []

  const refreshSharedBindings = async (): Promise<void> => {
    let items: Awaited<ReturnType<typeof collabMain.sharedWithMe>>
    try {
      items = await collabMain.sharedWithMe()
    } catch {
      return // 未登录/离线:保持现状,下次再刷
    }
    const plans = items.map((it) => planOf(it))
    sharedPlans = plans
    const want = new Set(plans.map((p) => p.key))
    for (const [key, entry] of sharedEngines) {
      if (!want.has(key)) {
        entry.engine.stop()
        sharedEngines.delete(key) // 共享被撤/自退:停同步;本地镜像文件保留(用户数据不擅删)
      }
    }
    for (const plan of plans) {
      if (sharedEngines.has(plan.key)) continue
      const engine = createSyncEngine(engineDeps, {
        localRoot: path.join(cloudVaultDir(), ...plan.localRelDir.split('/')),
        shadowName: `amadeus-sync-share-${plan.key}`,
        vaultId: plan.vaultId,
        serverDir: plan.serverDir,
        inScope: plan.inScope,
      })
      sharedEngines.set(plan.key, { engine, plan })
      engine.start()
    }
  }

  /** 活动 vault 是否就是云镜像(胶囊滑块的 Cloud 侧)。 */
  const onCloudSide = (): boolean => vault.getRoot() === cloudVaultDir()

  // ── 按条目云同步:每个开过同步的本地 vault 一个绑定(localRoot=vault 根,serverDir=<云名>)。
  // own 镜像引擎不排除 <云名>/ 前缀 → 条目绑定推上去的内容被它当「另一台设备」拉进镜像,
  // 云端侧 UI 白得;两引擎靠 clientIdSuffix 区分回声。注册表在 AmadeusConfig.entrySync。
  type EntryEngineRec = { engine: ReturnType<typeof createSyncEngine>; scope: { current: ScopeSet }; cloudName: string }
  const entryEngines = new Map<string, EntryEngineRec>()
  const entryMarkersEnsured = new Set<string>()
  const emitEntryChange = (): void => {
    getWindow()?.webContents.send(SYNC_IPC.entryChange)
  }
  /** 远端结构事件(move/delete…)应用后跟进注册表,否则远端改名后 scope 失配静默停同步。 */
  const onEntryRemote = (vaultRoot: string, ev: CloudChange): void => {
    void (async () => {
      const rec = entryEngines.get(vaultRoot)
      if (!rec) return
      const strip = (p: string | null | undefined): string | null =>
        p && p.startsWith(`${rec.cloudName}/`) ? p.slice(rec.cloudName.length + 1) : null
      const rel = strip(ev.path)
      if (!rel) return
      const cfg = await readConfig()
      const v = (cfg.entrySync ?? []).find((x) => x.vaultRoot === vaultRoot)
      if (!v) return
      const r = applyRemoteOpToEntries(
        v.entries,
        ev.op as 'move' | 'rename-folder' | 'move-folder' | 'delete' | 'delete-folder',
        rel,
        strip(ev.newPath),
      )
      if (!r.changed) return
      v.entries = r.next
      await writeConfig({ entrySync: cfg.entrySync })
      rec.scope.current = buildScope(v.entries)
      emitEntryChange()
    })()
  }
  const entryEngineDeps = (vaultRoot: string): typeof engineDeps & { onRemoteApplied: (ev: CloudChange) => void } => ({
    ...engineDeps,
    onStatus: (s: unknown) =>
      getWindow()?.webContents.send(SYNC_IPC.status, {
        ...(s as object),
        pendingDeletions: totalPendingDeletions(),
        side: 'local',
        binding: vaultRoot,
      }),
    onRemoteApplied: (ev) => onEntryRemote(vaultRoot, ev),
  })
  const refreshEntryBindings = async (): Promise<void> => {
    const list = (await readConfig()).entrySync ?? []
    const want = new Map(list.map((v) => [v.vaultRoot, v]))
    for (const [root, rec] of entryEngines) {
      const v = want.get(root)
      if (v && v.cloudName === rec.cloudName) continue
      rec.engine.stop()
      entryEngines.delete(root)
      // 云名变更:serverDir 变了,旧 shadow 的服务端路径键全部失效,必须清掉重来。
      if (v) void deleteShadowFile(`amadeus-sync-entry-${hash8(root)}`)
    }
    for (const v of list) {
      const existing = entryEngines.get(v.vaultRoot)
      if (existing) {
        existing.scope.current = buildScope(v.entries)
        continue
      }
      const scope = { current: buildScope(v.entries) }
      const cloudName = v.cloudName
      const engine = createSyncEngine(entryEngineDeps(v.vaultRoot), {
        localRoot: v.vaultRoot,
        shadowName: `amadeus-sync-entry-${hash8(v.vaultRoot)}`,
        vaultId: 'first',
        serverDir: cloudName,
        clientIdSuffix: `entry-${hash8(v.vaultRoot)}`,
        requireRootExists: true,
        ignoreNames: ['.git', 'node_modules', '.trash'],
        inScope: (sp) => {
          if (sp === cloudName) return true // 根文件夹本身(mkdir 等结构事件)
          if (!sp.startsWith(`${cloudName}/`)) return false
          return scopeMatches(scope.current, sp.slice(cloudName.length + 1))
        },
      })
      entryEngines.set(v.vaultRoot, { engine, scope, cloudName })
      engine.start()
    }
    // 旧库标记补写:<云名>/.forsion-vault 是 web 端识别「同步 Vault 分区」的标记,标记机制
    // 之前开启的库没有。幂等(已存在=409 吞),每进程每云名只试一次;失败(离线)下次进程再试。
    for (const v of list) {
      if (entryMarkersEnsured.has(v.cloudName)) continue
      entryMarkersEnsured.add(v.cloudName)
      void (async () => {
        try {
          const vid = await collabMain.ensureOwnVault()
          await collabMain.call('PUT', `/vaults/${encodeURIComponent(vid)}/file`, { path: `${v.cloudName}/.forsion-vault`, content: '', baseSeq: 0 })
        } catch { /* 已存在/离线:无害 */ }
      })()
    }
  }
  /** 本地 vault 内移动/改名跟随:过渡期新旧路径并集进 scope(精确 move 两端过闸,.md 与 .fd
   *  是两次独立 hook,宽限期让后到的 .fd move 也走精确通道),再落盘收敛。 */
  const onLocalEntryMove = async (root: string, fromRel: string, toRel: string, rec: EntryEngineRec): Promise<void> => {
    const from = fromRel.replace(/\\/g, '/')
    const to = toRel.replace(/\\/g, '/')
    const cfg = await readConfig()
    const v = (cfg.entrySync ?? []).find((x) => x.vaultRoot === root)
    if (!v) {
      rec.engine.notifyLocalMove(from, to)
      return
    }
    const r = rewriteEntriesForMove(v.entries, from, to)
    if (!r.changed) {
      rec.engine.notifyLocalMove(from, to)
      return
    }
    rec.scope.current = buildScope([...v.entries, ...r.next])
    rec.engine.notifyLocalMove(from, to)
    v.entries = r.next
    await writeConfig({ entrySync: cfg.entrySync })
    emitEntryChange()
    setTimeout(() => {
      const cur = entryEngines.get(root)
      if (cur === rec) cur.scope.current = buildScope(v.entries)
    }, 10_000)
  }
  /** 按路径把应用内写事件路由到对应引擎(与我共享/<slug>/** → 该共享绑定;其余 → own)。 */
  const routeNotify = (rel: string): { engine: ReturnType<typeof createSyncEngine>; rel: string } => {
    const posix = rel.replace(/\\/g, '/')
    for (const { engine, plan } of sharedEngines.values()) {
      if (posix.startsWith(`${plan.localRelDir}/`)) return { engine, rel: posix.slice(plan.localRelDir.length + 1) }
    }
    return { engine: sync, rel: posix }
  }
  // 应用内写钩子:活动 vault=镜像 → 按前缀路由到 own/共享引擎;活动 vault=本地且开了按条目
  // 同步 → 转发该 vault 的条目绑定(move 必须走这里:光靠 chokidar 是 unlink+add,新路径若
  // 尚未跟进注册表就不在 scope,重命名会变成云端删除)。其余场景引擎自带 watcher 兜底。
  vault.setMutationHooks(
    (rel, kind) => {
      if (onCloudSide()) {
        const r = routeNotify(rel)
        r.engine.notifyLocal(r.rel, kind)
        return
      }
      entryEngines.get(vault.getRoot() ?? '')?.engine.notifyLocal(rel, kind)
    },
    (from, to) => {
      if (onCloudSide()) {
        const f = routeNotify(from)
        const t = routeNotify(to)
        if (f.engine === t.engine) f.engine.notifyLocalMove(f.rel, t.rel)
        else {
          f.engine.notifyLocal(f.rel, 'remove')
          t.engine.notifyLocal(t.rel, 'write')
        }
        return
      }
      const root = vault.getRoot() ?? ''
      const rec = entryEngines.get(root)
      if (rec) void onLocalEntryMove(root, from, to, rec)
    },
  )

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
        void index.build()
        notifyAll(IPC.structureChange)
      }, 300)
    },
    (dbPath) => {
      // 外部改 .db(如 agent 直连磁盘改日历)→ 通知渲染端热重载对应 dbStore 条目。
      notifyAll(IPC.dbChange, dbPath)
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

  /** 全部引擎(主镜像+共享+按条目)待确认删除合计:设置页据此显示删除保护提示。 */
  const totalPendingDeletions = (): number => {
    let n = sync.getStatus().pendingDeletions
    for (const { engine } of sharedEngines.values()) n += engine.getStatus().pendingDeletions
    for (const { engine } of entryEngines.values()) n += engine.getStatus().pendingDeletions
    return n
  }
  ipcMain.handle(SYNC_IPC.get, () => ({
    ...sync.getStatus(),
    pendingDeletions: totalPendingDeletions(),
    side: onCloudSide() ? 'cloud' : 'local',
  }))
  ipcMain.handle(SYNC_IPC.setEnabled, (_e, on: boolean) => sync.setEnabled(on))
  // 踢一遍所有同步引擎(主镜像 + 共享 + 按条目):auth-required/停摆的引擎会经 syncNow 内部转 restart
  // 重读凭据并拉起双向同步。手动「立即同步」用它。
  const kickAllSync = (): ReturnType<typeof sync.syncNow> => {
    void refreshSharedBindings() // 顺带发现新接受的共享
    for (const { engine } of sharedEngines.values()) void engine.syncNow()
    for (const { engine } of entryEngines.values()) void engine.syncNow()
    return sync.syncNow()
  }
  // 凭据变更专用(登录/登出/换账号,main.ts 经 restartSync 调):全体引擎硬重启(重读 auth.json、
  // 重建云端 client)。syncNow 不够——运行中的引擎会拿旧账号的 client 继续同步(错账号读写)。
  const restartAllSync = (): void => {
    void refreshSharedBindings()
    for (const { engine } of sharedEngines.values()) void engine.restart()
    for (const { engine } of entryEngines.values()) void engine.restart()
    void sync.restart()
  }
  ipcMain.handle(SYNC_IPC.syncNow, () => kickAllSync())
  // 删除保护放行:对所有引擎生效(有待确认删除的才会真正动作)。
  ipcMain.handle(SYNC_IPC.confirmDeletions, () => {
    for (const { engine } of sharedEngines.values()) engine.confirmMassDeletions()
    for (const { engine } of entryEngines.values()) engine.confirmMassDeletions()
    const st = sync.confirmMassDeletions()
    return { ...st, pendingDeletions: totalPendingDeletions(), side: onCloudSide() ? 'cloud' : 'local' }
  })

  // ── 按条目云同步 IPC 面 ────────────────────────────────────────────────────
  ipcMain.handle(SYNC_IPC.entryGet, async () => {
    const cfg = await readConfig()
    return { vaults: cfg.entrySync ?? [], activeRoot: vault.getRoot(), cloudRoot: cloudVaultDir() }
  })
  // 非活动侧(Local↔Cloud 另一侧)的日历只读快照:递归读该侧根下所有 .db 源文本,供 Calendar 汇总两侧。
  // 只读(不建 watcher/不写回);另一侧的编辑仍须切到那一侧。两侧物理是分开的两个磁盘根。
  ipcMain.handle(SYNC_IPC.otherSideDbs, async () => {
    const active = vault.getRoot()
    if (!active) return null
    const cloud = cloudVaultDir()
    const cfg = await readConfig()
    // 活动侧是云 → 另一侧是本地(localVault);活动侧是本地 → 另一侧是云镜像目录。
    const otherRoot = active === cloud ? (cfg.localVault && cfg.localVault !== cloud ? cfg.localVault : null) : cloud
    if (!otherRoot) return null
    const dbs: Array<{ rel: string; source: string }> = []
    const CAP = 500 // ponytail: 上限防病态目录;超了截断(日历库量级远低于此)
    const walk = async (dir: string, rel: string): Promise<void> => {
      if (dbs.length >= CAP) return
      let ents: import('node:fs').Dirent[]
      try {
        ents = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return // 另一侧根不存在(未登录云 / 无本地库)→ 空
      }
      for (const e of ents) {
        if (dbs.length >= CAP) break
        if (e.name.startsWith('.') || e.isSymbolicLink()) continue // 隐藏目录/软链不追
        const childRel = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) await walk(path.join(dir, e.name), childRel)
        else if (e.isFile() && /\.db$/i.test(e.name)) {
          try {
            dbs.push({ rel: childRel, source: await fs.readFile(path.join(dir, e.name), 'utf8') })
          } catch {
            /* 单文件读失败跳过 */
          }
        }
      }
    }
    await walk(otherRoot, '')
    return { root: otherRoot, vaultName: otherRoot === cloud ? '云端' : path.basename(otherRoot), dbs }
  })
  ipcMain.handle(
    SYNC_IPC.entryEnable,
    async (_e, payload: { entries: Array<{ path: string; kind: 'page' | 'folder' | 'asset' }>; cloudName?: string; merge?: boolean }) => {
      const root = vault.getRoot()
      if (!root || onCloudSide()) return { error: '仅本地 vault 可开启云同步' }
      const cfg = await readConfig()
      const list = cfg.entrySync ?? []
      let v = list.find((x) => x.vaultRoot === root)
      if (!v) {
        const name = (payload.cloudName ?? path.basename(root)).normalize('NFC').trim()
        const err = validateCloudName(name, list.map((x) => x.cloudName))
        if (err) return { error: err }
        if (!payload.merge) {
          // 云端根占用检测(同名文件夹或文件都算);merge=true 显式合并进现有云文件夹(换机重开)。
          try {
            const vid = await collabMain.ensureOwnVault()
            const tree = await collabMain.call<{ folders?: string[]; entries?: Array<{ path: string }> }>(
              'GET',
              `/vaults/${encodeURIComponent(vid)}/tree`,
            )
            const occupied =
              (tree.folders ?? []).some((f) => f === name || f.startsWith(`${name}/`)) ||
              (tree.entries ?? []).some((en) => en.path === name || en.path.startsWith(`${name}/`))
            if (occupied) return { conflict: name }
          } catch (err2) {
            return { error: (err2 as Error)?.message || '无法连接云端(首次开启需要在线)' }
          }
        }
        v = { vaultRoot: root, cloudName: name, entries: [] }
        list.push(v)
        // 云端 vault 分区标记(web 端借此识别「同步 Vault 文件夹」;点开头文件对桌面树/本地回流全隐身)。
        // 失败不阻断开启(web 少一个分区而已);已存在(merge/换机)409 同样吞掉。
        void (async () => {
          try {
            const vid = await collabMain.ensureOwnVault()
            await collabMain.call('PUT', `/vaults/${encodeURIComponent(vid)}/file`, { path: `${v!.cloudName}/.forsion-vault`, content: '', baseSeq: 0 })
          } catch { /* ignore */ }
        })()
      }
      for (const en of payload.entries ?? []) {
        const p = String(en.path ?? '').replace(/\\/g, '/').normalize('NFC')
        if (!p || v.entries.some((x) => x.path === p)) continue
        v.entries.push({ path: p, kind: en.kind === 'folder' || en.kind === 'asset' ? en.kind : 'page' })
      }
      await writeConfig({ entrySync: list })
      await refreshEntryBindings()
      void entryEngines.get(root)?.engine.syncNow()
      emitEntryChange()
      return { ok: true, cloudName: v.cloudName }
    },
  )
  ipcMain.handle(SYNC_IPC.entryDisable, async (_e, p: string) => {
    const root = vault.getRoot()
    const cfg = await readConfig()
    const v = (cfg.entrySync ?? []).find((x) => x.vaultRoot === root)
    if (!root || !v) return { ok: false }
    const norm = String(p ?? '').replace(/\\/g, '/').normalize('NFC')
    const before = v.entries.length
    v.entries = v.entries.filter((x) => x.path !== norm)
    if (v.entries.length === before) return { ok: false }
    await writeConfig({ entrySync: cfg.entrySync })
    await refreshEntryBindings() // scope 缩小=dropShadow 干净解绑;云端/镜像副本保留(撤共享同款纪律)
    emitEntryChange()
    return { ok: true }
  })
  ipcMain.handle(SYNC_IPC.entryClosure, (_e, rootRel: string, kind: 'page' | 'folder') =>
    index.relatedClosure(String(rootRel ?? ''), kind === 'folder' ? 'folder' : 'page'),
  )

  // ── collab(页面级共享/发布/presence):token 留主进程,渲染端经 window.amadeusCollab ──
  ipcMain.handle(SYNC_IPC.collabCall, async (_e, fn: string, args: unknown[]) => {
    const v = async (): Promise<string> => collabMain.ensureOwnVault()
    const a = (i: number): string => String((args ?? [])[i] ?? '')
    const obj = (i: number): any => (args ?? [])[i] ?? {}
    switch (fn) {
      case 'listVaults':
        return (await collabMain.call<{ vaults: unknown[] }>('GET', '/vaults')).vaults
      case 'activeVaultId':
        return v()
      case 'pageShare':
        return collabMain.call('GET', `/vaults/${encodeURIComponent(await v())}/page-shares?path=${encodeURIComponent(a(0))}`)
      case 'createPageShare':
        return collabMain.call('POST', `/vaults/${encodeURIComponent(await v())}/page-shares`, { path: a(0), ...obj(1) })
      case 'updatePageShare':
        return collabMain.call('PATCH', `/vaults/${encodeURIComponent(await v())}/page-shares/${encodeURIComponent(a(0))}`, obj(1))
      case 'revokePageShare':
        return collabMain.call('DELETE', `/vaults/${encodeURIComponent(await v())}/page-shares/${encodeURIComponent(a(0))}`)
      case 'setParticipantRole':
        return collabMain.call('PATCH', `/vaults/${encodeURIComponent(await v())}/page-shares/${encodeURIComponent(a(0))}/members/${encodeURIComponent(a(1))}`, { role: a(2) })
      case 'removeParticipant':
        return collabMain.call('DELETE', `/vaults/${encodeURIComponent(await v())}/page-shares/${encodeURIComponent(a(0))}/members/${encodeURIComponent(a(1))}`)
      case 'sharedWithMe': {
        const items = await collabMain.sharedWithMe()
        void refreshSharedBindings()
        return items
      }
      case 'leaveShare': {
        const me = collabMain.myUserId()
        if (!me) throw new Error('未登录')
        return collabMain.call('DELETE', `/vaults/${encodeURIComponent(await v())}/page-shares/${encodeURIComponent(a(0))}/members/${encodeURIComponent(me)}`)
      }
      case 'publishes':
        return collabMain.call('GET', `/vaults/${encodeURIComponent(await v())}/shares`)
      case 'listAllShares': {
        // Public View：跨全部 vault 汇总「我发布的公开链接 + 我创建的页面协作共享」。
        // 现有 publishes/pageShare 都只覆盖 own vault；这里显式遍历 listVaults 做跨库聚合。
        const vaults = (await collabMain.call<{ vaults: Array<{ id: string; name?: string }> }>('GET', '/vaults')).vaults || []
        const myId = collabMain.myUserId()
        const publishes: any[] = []
        const pageShares: any[] = []
        for (const vt of vaults) {
          try {
            const pr = await collabMain.call<{ shares?: any[] }>('GET', `/vaults/${encodeURIComponent(vt.id)}/shares`)
            for (const s of pr.shares || []) publishes.push({ ...s, vaultId: vt.id, vaultName: vt.name || '' })
          } catch (e) { console.warn('[connect] listAllShares publishes vault', vt.id, 'failed:', (e as Error)?.message) /* 某库不可达则跳过 */ }
          try {
            const ps = await collabMain.call<any>('GET', `/vaults/${encodeURIComponent(vt.id)}/page-shares`)
            const list = ps?.shares || ps?.pageShares || (Array.isArray(ps) ? ps : [])
            for (const s of list) {
              const owner = s.created_by ?? s.createdBy
              // 该端点已要求调用者是 vault owner → 缺 owner 字段时视为「我的」，别误丢（否则协作区恒空）。
              if (!myId || !owner || owner === myId) pageShares.push({ ...s, vaultId: vt.id, vaultName: vt.name || '' })
            }
          } catch (e) { console.warn('[connect] listAllShares pageShares vault', vt.id, 'failed:', (e as Error)?.message) /* 某库不可达则跳过 */ }
        }
        return { publishes, pageShares, linkBase: await collabMain.linkBase() }
      }
      case 'createPublish': {
        const r = await collabMain.call<{ token: string; mode: string; path: string }>('POST', `/vaults/${encodeURIComponent(await v())}/shares`, { mode: a(0), path: a(1) })
        return { ...r, url: `${await collabMain.linkBase()}/share/${r.token}` }
      }
      case 'revokePublish':
        return collabMain.call('DELETE', `/vaults/${encodeURIComponent(await v())}/shares/${encodeURIComponent(a(0))}`)
      // Public View 跨库撤销：显式带 vaultId（默认 own-vault 变体会撤错库、零行更新还假成功）。
      case 'revokePublishIn':
        return collabMain.call('DELETE', `/vaults/${encodeURIComponent(a(0))}/shares/${encodeURIComponent(a(1))}`)
      case 'revokePageShareIn':
        return collabMain.call('DELETE', `/vaults/${encodeURIComponent(a(0))}/page-shares/${encodeURIComponent(a(1))}`)
      case 'myUserId':
        return collabMain.myUserId()
      case 'linkBase':
        return collabMain.linkBase()
      case 'heartbeat':
        return collabMain.heartbeat(((args ?? [])[0] as string | null) ?? null, sharedPlans)
      default:
        throw new Error(`unknown collab fn: ${fn}`)
    }
  })

  // 胶囊滑块:Local ↔ Cloud 全局切活动 vault。lastVault 恒 = 活动根(agent 工具实时跟随),
  // localVault 记住本地侧根以便切回;云镜像根固定,不污染 localVault。
  ipcMain.handle(SYNC_IPC.switchSide, async (_e, side: 'local' | 'cloud') => {
    const cfg = await readConfig()
    if (side === 'cloud') {
      const dir = cloudVaultDir()
      await fs.mkdir(dir, { recursive: true })
      if (cfg.lastVault && cfg.lastVault !== dir) await writeConfig({ localVault: cfg.lastVault })
      await writeConfig({ lastVault: dir })
      return { ...(await activateRoot(dir, false)), side: 'cloud' }
    }
    const target = cfg.localVault && (await fs.stat(cfg.localVault).then((s) => s.isDirectory()).catch(() => false))
      ? cfg.localVault
      : null
    if (!target) return { ...(await ensureDefaultVault()), side: 'local' }
    await writeConfig({ lastVault: target })
    return { ...(await activateRoot(target, false)), side: 'local' }
  })

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

  ipcMain.handle(IPC.openVault, async () => {
    const root = await vault.openDialog()
    if (!root) return null
    await writeConfig({ lastVault: root, localVault: root, lastPage: undefined })
    return activateRoot(root, false)
  })

  ipcMain.handle(IPC.restoreVault, async () => {
    let { lastVault } = await readConfig()
    if (!lastVault) return ensureDefaultVault() // 首启:自带默认工作区 + 种子多维表(不再落欢迎页)
    // 云镜像已迁隐藏目录:曾记在旧可见位置的活动根改指新位置(迁移已搬走内容)。
    if (lastVault === legacyCloudVaultDir()) {
      lastVault = cloudVaultDir()
      await writeConfig({ lastVault })
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

  ipcMain.handle(IPC.listPages, () => vault.listPages())
  ipcMain.handle(IPC.listFiles, () => vault.listFiles())

  ipcMain.handle(IPC.loadPage, async (_e, pagePath: string) => {
    const page = await loadPage(vault.pageIO(pagePath), pagePath, nowIso())
    await rememberPage(pagePath)
    return page
  })

  // 只读加载(模板读取等):不写 lastPage,不当成「打开」;文件不存在直接报错——
  // 编译器 loadPage 缺文件会 newPage 落盘,只读语义下不允许悄悄造文件。
  ipcMain.handle(IPC.readPage, async (_e, pagePath: string) => {
    const io = vault.pageIO(pagePath)
    if (!(await io.exists(pageFileName(pagePath)))) throw new Error(`note not found: ${pagePath}`)
    return loadPage(io, pagePath, nowIso())
  })

  ipcMain.handle(IPC.newPage, async (_e, pagePath: string) => {
    const page = await newPage(vault.pageIO(pagePath), pagePath, nowIso())
    await rememberPage(pagePath)
    await index.update(pagePath)
    return page
  })

  ipcMain.handle(
    IPC.savePage,
    async (_e, pagePath: string, manifest: PageManifest, contents: Record<string, string>) => {
      const io = vault.pageIO(pagePath)
      // 活动日志 note.edit:保存前后各读一次盘算行差(文件小,开销可忽略;失败不阻断保存)。
      const oldText = await io.readFile(pageFileName(pagePath)).catch(() => '')
      await savePage(io, pagePath, manifest, { contents })
      await index.update(pagePath)
      try {
        const newText = await io.readFile(pageFileName(pagePath))
        logNoteEdit(pagePath, String(oldText ?? ''), String(newText ?? ''))
      } catch { /* 装饰性数据 */ }
    },
  )

  ipcMain.handle(
    IPC.renamePage,
    async (
      _e,
      oldPath: string,
      newName: string,
      manifest: PageManifest,
      contents: Record<string, string>,
    ) => {
      // Same folder only; sanitize the name (no path separators / traversal).
      const dir = path.dirname(oldPath)
      let base = newName.trim().replace(/[\\/]/g, '')
      if (!base) throw new Error('页面名不能为空')
      if (base.toLowerCase().endsWith('.md')) base = base.slice(0, -3)
      const newPath = dir === '.' ? `${base}.md` : `${dir}/${base}.md`
      if (newPath === oldPath) {
        return { newPath: oldPath, page: await loadPage(vault.pageIO(oldPath), oldPath, nowIso()) }
      }
      if (await vault.pathExists(newPath)) throw new Error('目标页面已存在')
      // v3 is single-file: persist in-flight edits, then move the one .md.
      await savePage(vault.pageIO(oldPath), oldPath, manifest, { contents })
      await vault.moveEntry(oldPath, newPath)
      await index.rename(oldPath, newPath)
      await rememberPage(newPath)
      const page = await loadPage(vault.pageIO(newPath), newPath, nowIso())
      return { newPath, page }
    },
  )

  ipcMain.handle(
    IPC.reconcilePage,
    async (_e, pagePath: string, _prevManifest: PageManifest, _prevContents: Record<string, string>) => {
      // v3 is single-file: an external edit just reloads (the .md is the single source).
      const page = await loadPage(vault.pageIO(pagePath), pagePath, nowIso())
      await index.update(pagePath)
      return page
    },
  )

  ipcMain.handle(
    IPC.saveAsset,
    (_e, pagePath: string, fileName: string, bytes: Uint8Array) =>
      vault.writeAsset(pagePath, fileName, bytes),
  )

  ipcMain.handle(IPC.saveVaultBytes, async (_e, filePath: string, bytes: Uint8Array) => {
    await vault.writeVaultBytes(filePath, bytes)
    logActivity('file.save', { f: filePath })
  })

  ipcMain.handle(IPC.readVaultBytes, (_e, filePath: string) => vault.readVaultBytes(filePath))

  ipcMain.handle(
    IPC.saveAttachment,
    async (_e, pagePath: string, fileName: string, bytes: Uint8Array, opts: { mode: 'attachments' | 'same' | 'vault'; folder: string }) => {
      const r = await vault.writeAttachment(pagePath, fileName, bytes, opts)
      // 活动日志:附件/非 md 文件落盘;.db 跳过(renderer 已记 base.create,免重复)。
      if (!/\.db$/i.test(fileName || '')) logActivity('file.save', { f: fileName })
      return r
    },
  )

  ipcMain.handle(IPC.openAttachment, async (_e, pagePath: string, ref: string) => {
    const abs = await vault.resolveAttachment(pagePath, ref)
    if (abs) await shell.openPath(abs)
  })

  // 树/侧栏点开:路径已知且精确 → 直接钳制解析,不走 markdown ref 的 decode/basename 兜底
  // (否则根级同名文件会开错、含字面 %xx 的文件名会被解码到不存在的路径)。
  ipcMain.handle(IPC.openVaultFile, async (_e, vaultRel: string) => {
    const err = await shell.openPath(vault.absPath(vaultRel))
    if (err) throw new Error(err)
  })

  // 导出 PDF:渲染端已把编辑器克隆挂到 #amx-print-root,@media print 只呈现它(见 amadeus-host.css);
  // printToPDF 走打印媒体查询,同文档内 amadeus-asset://、KaTeX 字体全部可用,无需隐藏窗口二次渲染。
  ipcMain.handle(IPC.exportPdf, async (_e, defaultName: string) => {
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

  // Database(.db JSON):read 按 ref 解析(与附件同一 basename 语义),write 按 read 返回的精确相对路径。
  ipcMain.handle(IPC.dbRead, async (_e, pagePath: string, ref: string): Promise<DbReadResult> => {
    const abs = await vault.resolveAttachment(pagePath, ref)
    if (!abs) return { status: 'missing' }
    const root = vault.getRoot()
    if (!root) return { status: 'missing' }
    const rel = path.relative(root, abs)
    let text: string
    try {
      text = await fs.readFile(abs, 'utf8')
    } catch {
      return { status: 'missing' }
    }
    const r = parseDb(text)
    return r.ok
      ? { status: 'ok', path: rel, data: r.data, version: dbVersion(text) }
      : { status: 'corrupt', path: rel, message: r.error }
  })

  ipcMain.handle(IPC.dbWrite, async (_e, dbPath: string, data: unknown) => {
    const parsed = dbFileSchema.parse(data) // 防御性校验:坏数据拒写,绝不落半截文件
    await vault.writeTextFile(dbPath, serializeDb(parsed))
  })

  // 比对交换写:baseVersion 与磁盘现状不符就**不写**,把最新 version 回给渲染端去重载+重放。
  // 目标是那条真实竞态 —— 渲染端 500ms 防抖握着旧快照落盘,把这期间引擎/自动化加的行整个抹掉
  // (反向亦然:引擎读改写覆盖用户刚敲的格子)。写本身仍走 vault 的原子 tmp+rename。
  //
  // 「读→比对→写」这三步**在本进程内**是原子的(单线程,中间没有 await 让给别的 handler),
  // 但引擎是另一个进程 —— 它完全可以插在比对与写之间。所以整段再裹一层跨进程锁,
  // 与引擎 `mutateDb` 用的是同一个锁文件(见 dbLock.ts 里的路径约定)。
  ipcMain.handle(IPC.dbWriteCas, async (_e, dbPath: string, data: unknown, baseVersion: string) => {
    const parsed = dbFileSchema.parse(data)
    try {
      return await withDbLock(vault.absPath(dbPath), async () => {
        let cur = ''
        try { cur = Buffer.from(await vault.readVaultBytes(dbPath)).toString('utf8') } catch { cur = '' } // 文件不在=新建,视为无冲突
        const curVersion = cur ? dbVersion(cur) : ''
        if (cur && curVersion !== baseVersion) return { ok: false, version: curVersion }
        const text = serializeDb(parsed)
        await vault.writeTextFile(dbPath, text)
        return { ok: true, version: dbVersion(text) }
      })
    } catch (e) {
      // 拿不到锁(对方持锁超过 5s)= 当作一次冲突回给渲染端:它会重读磁盘、重放 pendingOps、再写。
      // 这正是既有的冲突通道,不必新开一条错误路径;**绝不能**因为锁没拿到就直接写下去。
      console.warn('[amadeus] db:write-cas 未能取得跨进程锁,按冲突处理:', (e as Error)?.message)
      let cur = ''
      try { cur = Buffer.from(await vault.readVaultBytes(dbPath)).toString('utf8') } catch { cur = '' }
      return { ok: false, version: cur ? dbVersion(cur) : '' }
    }
  })

  // Excalidraw 画板(`.excalidraw.md`,Obsidian 插件同款格式;裸 `.excalidraw` 也认)。
  // 只搬字节:解析/序列化是纯函数,在渲染端与编辑器同侧(见 shared/amadeus/excalidraw)。
  ipcMain.handle(IPC.drawingRead, async (_e, pagePath: string, ref: string): Promise<DrawingReadResult> => {
    // Obsidian 链接省略 .md:`![[Foo.excalidraw]]` 实指 `Foo.excalidraw.md` → 原样先试,落空再补 .md。
    const abs =
      (await vault.resolveAttachment(pagePath, ref)) ?? (await vault.resolveAttachment(pagePath, `${ref}.md`))
    const root = vault.getRoot()
    if (!abs || !root) return { status: 'missing' }
    try {
      return { status: 'ok', path: path.relative(root, abs), source: await fs.readFile(abs, 'utf8') }
    } catch {
      return { status: 'missing' }
    }
  })

  // 必须走 writeTextFile 而非 saveVaultBytes:后者不记自写账本,而 .excalidraw.md 命中 watcher 的
  // `.md` 分支 → 每次自动保存都会被当成外部改动回弹。
  ipcMain.handle(IPC.drawingWrite, async (_e, drawingPath: string, source: string) => {
    await vault.writeTextFile(drawingPath, source)
  })

  // 通用 vault 文本读写(插件文件类型:ctx.app.readFile/writeFile)。读越界即 null;
  // 写同 drawingWrite 走 writeTextFile(记自写账本,插件保存不被 watcher 当外部改动回弹)。
  ipcMain.handle(IPC.readTextFile, async (_e, filePath: string): Promise<string | null> => {
    if (!vault.getRoot()) return null
    try {
      return await fs.readFile(vault.absPath(filePath), 'utf8')
    } catch {
      return null
    }
  })
  ipcMain.handle(IPC.writeTextFile, async (_e, filePath: string, text: string) => {
    await vault.writeTextFile(filePath, text)
  })

  // 「笔记视图」(Bases):行 = 目标文件夹直属笔记,frontmatter 是唯一真源。
  ipcMain.handle(IPC.listPageProps, async (_e, folder: string): Promise<PageProps[]> => {
    if (!vault.getRoot()) return []
    const prefix = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const inFolder = (await vault.listPages()).filter((p) => {
      if (prefix === '') return !p.includes('/') // 整库:仅顶层笔记
      if (!p.startsWith(`${prefix}/`)) return false
      return !p.slice(prefix.length + 1).includes('/') // 仅直属子级,不递归子文件夹
    })
    const out: PageProps[] = []
    for (const p of inFolder) {
      let raw: string
      try {
        raw = await fs.readFile(vault.absPath(p), 'utf8')
      } catch {
        continue
      }
      out.push({ path: p, title: path.basename(p).replace(/\.md$/i, ''), fm: parseFmObject(extractFrontmatterExtra(raw)) })
    }
    return out
  })

  ipcMain.handle(IPC.setPageFrontmatter, async (_e, pagePath: string, patch: Record<string, unknown>) => {
    let raw: string
    try {
      raw = await fs.readFile(vault.absPath(pagePath), 'utf8')
    } catch {
      return // 笔记不在(已被删)→ 静默跳过
    }
    await vault.writeTextFile(pagePath, setFmExtraOnSource(raw, patch)) // 原子写 + 自写账本 → watcher 不回声
    await index.update(pagePath)
  })

  ipcMain.handle(IPC.renamePageFile, async (_e, oldPath: string, newBaseName: string): Promise<string> => {
    const dir = path.dirname(oldPath)
    let base = newBaseName.trim().replace(/[\\/]/g, '')
    if (!base) throw new Error('笔记名不能为空')
    if (base.toLowerCase().endsWith('.md')) base = base.slice(0, -3)
    const newPath = dir === '.' ? `${base}.md` : `${dir}/${base}.md`
    if (newPath === oldPath) return oldPath
    if (await vault.pathExists(newPath)) throw new Error('目标笔记已存在')
    await vault.moveEntry(oldPath, newPath) // 纯移动:不落 v3,外来 .md 不被收编
    index.remove(oldPath)
    await index.update(newPath)
    return newPath
  })

  ipcMain.handle(IPC.renameDbFile, async (_e, oldPath: string, newBaseName: string): Promise<{ newPath: string; rewrittenPages: string[] }> => {
    const norm = (s: string): string => s.replace(/\\/g, '/')
    const oldRel = norm(oldPath)
    let base = newBaseName.trim().replace(/[\\/]/g, '')
    if (base.toLowerCase().endsWith('.db')) base = base.slice(0, -3)
    if (!base) throw new Error('名称不能为空')
    const dir = path.dirname(oldRel)
    const newPath = dir === '.' ? `${base}.db` : `${dir}/${base}.db`
    if (newPath === oldRel) return { newPath, rewrittenPages: [] }
    if (await vault.pathExists(newPath)) throw new Error('目标文件已存在')
    await vault.moveEntry(oldRel, newPath)

    // title 同步:name = 新 basename。parseDb 失败(损坏文件)只移动不动内容。
    try {
      const parsed = parseDb(await fs.readFile(vault.absPath(newPath), 'utf8'))
      if (parsed.ok && parsed.data.name !== base) {
        await vault.writeTextFile(newPath, serializeDb({ ...parsed.data, name: base }))
      }
    } catch { /* corrupt: 跳过 name 同步 */ }

    // 引用重写(纯函数 rewriteDbRefs,规则见其注释)。
    // ponytail: 朴素全库扫描,个人 vault 规模足够;[名](rel.db) 形式的 md 链接 v1 不重写。
    const rewrittenPages: string[] = []
    for (const p of await vault.listPages()) {
      const pRel = norm(p)
      let raw: string
      try { raw = await fs.readFile(vault.absPath(p), 'utf8') } catch { continue }
      const next = rewriteDbRefs(raw, { oldRel, newBase: `${base}.db`, pageDir: path.posix.dirname(pRel) })
      if (next !== raw) {
        await vault.writeTextFile(p, next)
        await index.update(p)
        notifyAll(IPC.externalChange, p)
        rewrittenPages.push(p)
      }
    }
    return { newPath, rewrittenPages }
  })

  ipcMain.handle(IPC.search, (_e, query: string) => index.search(query))
  ipcMain.handle(IPC.backlinks, (_e, pagePath: string) => index.backlinks(pagePath))
  ipcMain.handle(IPC.exclusiveAssets, (_e, pagePath: string) => index.exclusiveAssets(pagePath))
  ipcMain.handle(IPC.reindex, () => index.build())
  ipcMain.handle(IPC.listTags, () => index.listTags())
  ipcMain.handle(IPC.pagesByTag, (_e, tag: string) => index.pagesByTag(tag))

  ipcMain.handle(IPC.listFolders, () => vault.listFolders())

  ipcMain.handle(IPC.resolveEmbed, (_e, target: string) => {
    // The inline index already holds each block's content + owning note.
    const hit = index.resolveBlock(target)
    return hit ? { owner: hit.path, content: hit.content, type: hit.type } : null
  })

  ipcMain.handle(IPC.blockBacklinks, (_e, target: string) => index.blockBacklinks(target))

  ipcMain.handle(IPC.deletePage, async (_e, pagePath: string) => {
    await vault.removeEntry(pagePath) // v3: a note is a single .md
    index.remove(pagePath)
  })

  ipcMain.handle(IPC.movePage, async (_e, pagePath: string, destFolder: string) => {
    const fileName = pageFileName(pagePath)
    const dstRel = destFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const newPath = dstRel ? `${dstRel}/${fileName}` : fileName
    if (newPath === pagePath) return pagePath
    if (await vault.pathExists(newPath)) throw new Error('目标位置已存在同名文件')
    await vault.moveEntry(pagePath, newPath)
    // 树里的附件(非 .md)也走本通道移动:不进索引(index.update 会把二进制按 utf8 读成巨串)、不记 lastPage。
    if (newPath.endsWith('.md')) {
      index.remove(pagePath)
      await index.update(newPath)
      await rememberPage(newPath)
    }
    return newPath
  })

  ipcMain.handle(IPC.createFolder, async (_e, parentFolder: string, name: string) => {
    const clean = name.trim().replace(/[\\/]/g, '')
    if (!clean) throw new Error('文件夹名不能为空')
    const parent = parentFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const rel = parent ? `${parent}/${clean}` : clean
    if (await vault.pathExists(rel)) throw new Error('同名文件夹已存在')
    await vault.makeDir(rel)
    return rel
  })

  ipcMain.handle(IPC.renameFolder, async (_e, folderPath: string, newName: string) => {
    const clean = newName.trim().replace(/[\\/]/g, '')
    if (!clean) throw new Error('文件夹名不能为空')
    const parentDir = path.dirname(folderPath)
    const parentRel = parentDir === '.' ? '' : parentDir
    const newPath = parentRel ? `${parentRel}/${clean}` : clean
    if (newPath === folderPath) return folderPath
    if (await vault.pathExists(newPath)) throw new Error('同名文件夹已存在')
    await vault.moveEntry(folderPath, newPath)
    await index.build()
    return newPath
  })

  ipcMain.handle(IPC.deleteFolder, async (_e, folderPath: string) => {
    await vault.removeEntry(folderPath)
    await index.build()
  })

  ipcMain.handle(IPC.moveFolder, async (_e, folderPath: string, destFolder: string) => {
    const src = folderPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const name = src.split('/').pop()
    if (!name) throw new Error('文件夹路径不能为空')
    const dst = destFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const newPath = dst ? `${dst}/${name}` : name
    if (newPath === src) return src
    if (dst === src || dst.startsWith(`${src}/`)) throw new Error('不能移动到自身内部')
    if (await vault.pathExists(newPath)) throw new Error('目标位置已存在同名文件夹')
    await vault.moveEntry(src, newPath)
    await index.build()
    return newPath
  })

  // ── 回收站:移入/列出/恢复/彻底删/清空(.trash 点目录对扫描天然隐身,动索引的只有移入与恢复) ──
  ipcMain.handle(IPC.trashEntry, async (_e, rel: string) => {
    await vault.trashEntry(rel)
    await index.build()
  })
  ipcMain.handle(IPC.listTrash, async () => vault.listTrash())
  ipcMain.handle(IPC.restoreTrash, async (_e, name: string) => {
    const restored = await vault.restoreTrash(name)
    await index.build()
    return restored
  })
  ipcMain.handle(IPC.deleteTrashEntry, async (_e, name: string) => vault.deleteTrashEntry(name))
  ipcMain.handle(IPC.emptyTrash, async () => vault.emptyTrash())
  ipcMain.handle(IPC.pageIcons, () => index.pageIcons())
  ipcMain.handle(IPC.fetchLinkMeta, (_e, url: string) => fetchLinkMeta(url))
  ipcMain.handle(IPC.searchImages, (_e, q: string) => searchImages(q))

  // Forsion(UI)插件单一目录(market type='amadeus-plugin' 装到同目录)。vault 级装载已砍——
  // Amadeus 只是一个 Space,插件属于 Forsion 桌面本体,不属于某个 vault。
  const globalPluginsDir = (): string => path.join(forsionHomeDir(), 'plugins')

  // 插件 id 统一门禁:manifest id 合法用它,否则回退目录名,两者皆非法 → 拒载。发现与卸载共用同一
  // 规则,否则会出现「能列出/能运行、点卸载却被 id 校验拒绝」的卸不掉插件(codex P1-9);
  // 该 id 还进 localStorage 键与 Space 归属,必须先掐住。
  const SAFE_PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
  const pluginIdOf = (dirName: string, manifestId: unknown): string | null => {
    if (typeof manifestId === 'string' && SAFE_PLUGIN_ID.test(manifestId)) return manifestId
    return SAFE_PLUGIN_ID.test(dirName) ? dirName : null
  }

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

  // 校验插件声明的文件类型扩展名是否「安全专用」:防 `.md`/`.txt` 这类通用后缀把整库笔记从 listPages 排空(Codex #11)。
  // .md 派生必须是复合(`.<子类型>.md`,如 `.mindmap.md`);其它扩展名普通校验。
  const isSafePluginExt = (ext: unknown): ext is string => {
    if (typeof ext !== 'string') return false
    const e = ext.trim().toLowerCase()
    if (!e.startsWith('.') || e.length < 2 || e.length > 40) return false
    if (e === '.md' || e === '.markdown' || e === '.txt') return false
    return e.endsWith('.md') ? /^\.[a-z0-9][a-z0-9-]*\.md$/.test(e) : /^\.[a-z0-9][a-z0-9.-]*$/.test(e)
  }

  // 同步预扫插件目录的 manifest.json,收集并校验其 fileExtensions —— 只读 manifest,不依赖 main.js(插件坏了也保住
  // 扩展名保护,Codex #3);同步执行以便在任何 listPages 之前就绪,关掉「listPages 先于 listPlugins 注入」的启动竞态(Codex #2)。
  const collectPluginExts = (): string[] => {
    const exts = new Set<string>(readExtTombstones()) // 已卸载插件的扩展名豁免持久生效
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(globalPluginsDir(), { withFileTypes: true })
    } catch {
      return []
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

  ipcMain.handle(IPC.listPlugins, async (): Promise<ExternalPluginSource[]> => {
    const seen = new Set<string>()
    const out: ExternalPluginSource[] = []
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(globalPluginsDir(), { withFileTypes: true })
    } catch {
      return out
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      const pdir = path.join(globalPluginsDir(), e.name)
      try {
        const m = JSON.parse(await fs.readFile(path.join(pdir, 'manifest.json'), 'utf8')) as {
          id?: string
          name?: string
          version?: string
          description?: string
          main?: string
          apiVersion?: number
          minAppVersion?: string
          requiresApp?: string
          onboarding?: unknown
          fileExtensions?: unknown
          events?: unknown
        }
        const id = pluginIdOf(e.name, m.id)
        if (!id) {
          console.warn(`[amadeus] 插件目录 "${e.name}" 的 manifest id 与目录名均非法(须 kebab-case),拒载`)
          continue
        }
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
        const [readme, changelog] = await Promise.all([
          fs.readFile(path.join(pdir, 'README.md'), 'utf8').then((s) => s.slice(0, 65536), () => undefined),
          fs.readFile(path.join(pdir, 'CHANGELOG.md'), 'utf8').then((s) => s.slice(0, 65536), () => undefined),
        ])
        seen.add(id)
        out.push({
          id,
          name: m.name || e.name,
          version: m.version || '0.0.0',
          description: m.description,
          code,
          apiVersion: typeof m.apiVersion === 'number' ? m.apiVersion : 1,
          minAppVersion: typeof m.minAppVersion === 'string' ? m.minAppVersion : undefined,
          requiresApp: typeof m.requiresApp === 'string' ? m.requiresApp : undefined,
          readme,
          changelog,
          onboarding: sanitizeOnboarding(m.onboarding),
          events: sanitizeEvents(m.events),
          fileExtensions: Array.isArray(m.fileExtensions)
            ? m.fileExtensions.filter((x): x is string => typeof x === 'string' && !!x).slice(0, 8)
            : undefined,
          blocked: blocked ?? undefined,
          bundle,
        })
      } catch {
        /* skip malformed plugin */
      }
    }
    // 主进程 listPages 排除的扩展名 → 用独立的 manifest 预扫(不依赖各插件 main.js 是否可读,Codex #3),
    // 而非从 out 派生。按 manifest 声明豁免(与启用态无关):禁用/坏掉的插件也不能让其文件掉回笔记被 compiler 改写=毁档。
    vault.setPluginFileExtensions(collectPluginExts())
    return out
  })

  ipcMain.handle(IPC.openPluginsFolder, async () => {
    const dir = globalPluginsDir()
    await fs.mkdir(dir, { recursive: true })
    await shell.openPath(dir)
  })

  ipcMain.handle(IPC.revealInFileManager, async (_e, targetPath: string) => {
    // Clamp to the vault, then select the item in the OS file manager. showItemInFolder
    // opens the parent and highlights the entry — works for both files and folders.
    const abs = vault.absPath(targetPath)
    shell.showItemInFolder(abs)
  })

  ipcMain.handle(IPC.scaffoldPlugin, async () => {
    const pdir = path.join(globalPluginsDir(), 'hello-amadeus')
    await fs.mkdir(pdir, { recursive: true })
    await fs.writeFile(path.join(pdir, 'manifest.json'), SAMPLE_MANIFEST, 'utf8')
    await fs.writeFile(path.join(pdir, 'main.js'), SAMPLE_MAIN, 'utf8')
  })

  // 卸载 Forsion 插件:按 manifest id 定位目录(id 可与目录名不同;与 listPlugins 同一 pluginIdOf 门禁)整删。
  // 只动 ~/.forsion/plugins;内嵌 agent 已播种进引擎的按「播种一次」语义保留(活体),
  // 内嵌引擎插件需重启引擎后消失(调用方负责提示/重启)。
  ipcMain.handle(IPC.uninstallPlugin, async (_e, id: string) => {
    if (typeof id !== 'string' || !SAFE_PLUGIN_ID.test(id)) throw new Error('非法的插件标识')
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
    if (!target) throw new Error('插件不存在')
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

  // 启动即同步预扫插件扩展名 → 早于渲染端 restoreVault→listPages,关掉「.mindmap.md 被当页面加载」的启动竞态(Codex #2)。
  vault.setPluginFileExtensions(collectPluginExts())

  sync.start() // 云镜像同步独立于活动 vault,应用启动即拉起(未登录/显式停用时安静待命)
  void refreshSharedBindings() // 与我共享的绑定引擎(未登录时静默,syncNow/共享列表访问时再刷)
  void refreshEntryBindings() // 按条目同步绑定(注册表为空时零动作;vault 根不在时该绑定停在 error 态)

  return {
    getVaultRoot: () => vault.getRoot(),
    /** 登录成功后由 main 调:重读凭据、拉起云端双向同步(修「已登录仍显示登录提示 + 同步没开」)。 */
    restartSync: () => { restartAllSync() },
  }
}
