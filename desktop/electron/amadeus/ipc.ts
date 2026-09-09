import { promises as fs, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { IPC, gatePluginManifest, sanitizeOnboarding, sanitizeEvents, PLUGIN_CAPABILITIES, type ExternalPluginSource, type PluginBundleInfo } from '@amadeus-shared/ipc'
import { serializeDb, seedCalendarDb } from '@amadeus-shared/db/schema'
import { isSafePluginExt } from '@amadeus-shared/pluginFiles'
import { VaultManager } from './fs/vaultManager'
import { registerVaultHandlers, VAULT_WRITE_EVENTS, type VaultFace } from './fs/vaultHandlers'
export type { VaultFace } from './fs/vaultHandlers'
import { VaultWatcher } from './fs/watcher'
import { VaultIndex } from './fs/vaultIndex'
import { cloudAccountNamespace, currentCloudAccountId, readConfig, writeConfig } from './settings'
import { defaultWorkspaceDir, forsionHomeDir } from '../forsionHome'
import { builtinPluginIds } from '../builtinPlugins'
import { logActivity, logNoteEdit } from '../activityLog'
import { loadTanguCreds } from '../forsionAuth'
import { fetchLinkMeta, searchImages } from './linkMeta'
import { cloudVaultDir, isManagedCloudVault, migrateCloudMirrorDir, createSyncEngine } from './sync/engine'
import { createCollabMain, planOf, type SharedBindingPlan } from './sync/collabMain'
import { mirrorVaultNames } from './sync/mirrorVaults'
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
import { cloudVaultMarkerPath, coversPath, rewritePathList } from '@amadeus-shared/entrySync'
import { deleteShadowFile } from './sync/shadow'
import type { CloudChange } from './sync/cloudClient'
import { readPluginIconDataUrl } from '../pluginIcon'


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

export function registerIpc(getWindow: () => BrowserWindow | null): {
  getVaultRoot: () => string | null
  restartSync: () => Promise<void>
  stopSync: () => Promise<void>
  readExternalPlugins: () => Promise<ExternalPluginSource[]>
  vaultFace: VaultFace
} {
  const vault = new VaultManager({
    openDirectory: async () => {
      const res = await dialog.showOpenDialog({ title: '打开 Vault 文件夹', properties: ['openDirectory', 'createDirectory'] })
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
  /**
   * 写通道 → 回灌事件映射。为什么需要它:savePage 一类的写不广播(本窗自己知道),watcher 又按
   * 自写账本压掉主进程落盘 —— 设备互联后「另一端」就永远听不到。两个派发口各补一半:
   *   渲染层 IPC 起源 → 只发 SSE 给远端(本机各窗维持既有静默,不动外部回灌 P0 契约);
   *   RPC 起源(远端写) → 本机窗口回灌 + SSE(带写入者 origin,远端桥据此丢自己的回声)。
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
        const ev = VAULT_WRITE_EVENTS[channel]?.(a)
        if (ev) emitRemote(ev[0], ev[1], 'host')
        return r
      } finally { pendingVaultWrites.delete(operation) }
    })
  }

  // 云镜像迁移到隐藏目录:必须早于任何引擎创建/启动(整目录 rename,保 shadow 一致)。
  migrateCloudMirrorDir()

  // 云同步引擎:云 vault = 固定本地镜像目录(cloudVaultDir),独立于用户自选 vault,自带 watcher。
  // 引擎自己的写盘绕开 VaultManager 台账 → 活动 vault 是镜像时主 watcher 照常广播 →
  // 渲染端刷新/索引全部走既有通道;对账按 hash 幂等消回推环。
  // 多绑定:own 引擎(自己的云库,排除「与我共享/」)+ 每个已接受的页面共享一个引擎
  // (镜像到 与我共享/<title>-<hash8>/,离线可读、双向同步;写权限由服务端按角色判)。
  let syncEpoch = 0
  let syncReady = false
  let collabMain = createCollabMain()
  const presenceRoster = new Map<string, { userId: string; username: string; page: string | null; at: number }>()
  const pushRoster = (): void => {
    const now = Date.now()
    for (const [k, p] of presenceRoster) if (now - p.at > 70_000) presenceRoster.delete(k)
    notifyAll(SYNC_IPC.presence, [...presenceRoster.values()])
  }
  const engineDeps = {
    loadCreds: () => loadTanguCreds(),
    // pendingDeletions 恒发全引擎合计:设置页整包替换状态,若只带本引擎计数,别的引擎持有的
    // 待确认删除会被一条无关事件顶掉 → 确认按钮消失、删除卡死。
    onStatus: (s: unknown) =>
      notifyAll(SYNC_IPC.status, {
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
  const scopedEngineDeps = (): typeof engineDeps => {
    const epoch = syncEpoch
    return {
      ...engineDeps,
      onStatus: (status) => { if (epoch === syncEpoch) engineDeps.onStatus(status) },
      onPresence: (vaultId, data) => { if (epoch === syncEpoch) engineDeps.onPresence(vaultId, data) },
      onPresenceRoster: (vaultId, data) => { if (epoch === syncEpoch) engineDeps.onPresenceRoster(vaultId, data) },
    }
  }
  let sync = createSyncEngine(scopedEngineDeps())
  /** 与我共享的绑定引擎(key=planOf hash8)。 */
  const sharedEngines = new Map<string, { engine: ReturnType<typeof createSyncEngine>; plan: SharedBindingPlan }>()
  let sharedPlans: SharedBindingPlan[] = []

  const refreshSharedBindings = async (): Promise<void> => {
    if (!syncReady || !currentCloudAccountId()) return
    const epoch = syncEpoch
    const session = collabMain
    let items: Awaited<ReturnType<typeof collabMain.sharedWithMe>>
    try {
      items = await session.sharedWithMe()
    } catch {
      return // 未登录/离线:保持现状,下次再刷
    }
    if (epoch !== syncEpoch || !syncReady) return
    const plans = items.map((it) => planOf(it))
    sharedPlans = plans
    const want = new Set(plans.map((p) => p.key))
    for (const [key, entry] of sharedEngines) {
      if (!want.has(key)) {
        await entry.engine.stop()
        if (epoch !== syncEpoch) return
        sharedEngines.delete(key) // 共享被撤/自退:停同步;本地镜像文件保留(用户数据不擅删)
      }
    }
    for (const plan of plans) {
      if (sharedEngines.has(plan.key)) continue
      const engine = createSyncEngine(scopedEngineDeps(), {
        localRoot: path.join(cloudVaultDir(), ...plan.localRelDir.split('/')),
        shadowName: `amadeus-sync-${cloudAccountNamespace()}-share-${plan.key}`,
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
    notifyAll(SYNC_IPC.entryChange)
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
      if (entryEngines.get(vaultRoot) !== rec) return
      const v = (cfg.entrySync ?? []).find((x) => x.vaultRoot === vaultRoot)
      if (!v) return
      const op = ev.op as 'move' | 'rename-folder' | 'move-folder' | 'delete' | 'delete-folder'
      const newRel = strip(ev.newPath)
      const r = applyRemoteOpToEntries(v.entries, op, rel, newRel)
      // exclude 也要跟着改名,否则被排除的子页面一改名就悄悄回到同步范围。
      const x = newRel ? rewritePathList(v.exclude ?? [], rel, newRel) : { changed: false, next: v.exclude ?? [] }
      if (!r.changed && !x.changed) return
      v.entries = r.next
      if (x.changed) v.exclude = x.next
      await writeConfig({ entrySync: cfg.entrySync }, cfg.cloudAccountId)
      rec.scope.current = buildScope(v.entries, v.exclude ?? [])
      emitEntryChange()
    })()
  }
  const entryEngineDeps = (vaultRoot: string) => {
    const epoch = syncEpoch
    return {
      ...scopedEngineDeps(),
      onStatus: (status: unknown) => {
        if (epoch !== syncEpoch) return
        notifyAll(SYNC_IPC.status, {
          ...(status as object), pendingDeletions: totalPendingDeletions(), side: 'local', binding: vaultRoot,
        })
      },
      onRemoteApplied: (ev: CloudChange) => { if (epoch === syncEpoch) onEntryRemote(vaultRoot, ev) },
    }
  }
  const refreshEntryBindings = async (): Promise<void> => {
    if (!syncReady || !currentCloudAccountId()) return
    const epoch = syncEpoch
    const session = collabMain
    const accountConfig = await readConfig()
    const list = accountConfig.entrySync ?? []
    if (epoch !== syncEpoch || !syncReady) return
    const want = new Map(list.map((v) => [v.vaultRoot, v]))
    for (const [root, rec] of entryEngines) {
      const v = want.get(root)
      if (v && v.cloudName === rec.cloudName) continue
      await rec.engine.stop()
      if (epoch !== syncEpoch) return
      entryEngines.delete(root)
      // 云名变更:serverDir 变了,旧 shadow 的服务端路径键全部失效,必须清掉重来。
      if (v) await deleteShadowFile(`amadeus-sync-${cloudAccountNamespace()}-entry-${hash8(root)}`)
      if (epoch !== syncEpoch) return
    }
    for (const v of list) {
      const existing = entryEngines.get(v.vaultRoot)
      if (existing) {
        existing.scope.current = buildScope(v.entries, v.exclude ?? [])
        continue
      }
      const scope = { current: buildScope(v.entries, v.exclude ?? []) }
      const cloudName = v.cloudName
      const engine = createSyncEngine(entryEngineDeps(v.vaultRoot), {
        localRoot: v.vaultRoot,
        shadowName: `amadeus-sync-${cloudAccountNamespace()}-entry-${hash8(v.vaultRoot)}`,
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
    if (accountConfig.cloudSync?.enabled === false) return
    // 旧库标记补写:<云名>/.forsion-vault.md 是 web/移动端识别「同步 Vault 分区」的标记,标记机制
    // 之前开启的库没有。幂等(已存在=409 吞),每进程每云名只试一次;失败(离线)下次进程再试。
    for (const v of list) {
      if (entryMarkersEnsured.has(v.cloudName)) continue
      void (async () => {
        try {
          const vid = await session.ensureOwnVault()
          await session.call('PUT', `/vaults/${encodeURIComponent(vid)}/file`, { path: cloudVaultMarkerPath(v.cloudName), content: '', baseSeq: 0 })
          epoch === syncEpoch && entryMarkersEnsured.add(v.cloudName)
        } catch (e) {
          // 409=已存在,同样算就位;其余(离线/500)不落标记,下次 refresh 再试(别在发请求前就置位)。
          if ((e as { status?: number })?.status === 409) epoch === syncEpoch && entryMarkersEnsured.add(v.cloudName)
        }
      })()
    }
  }
  /** 本地 vault 内移动/改名跟随:过渡期新旧路径并集进 scope(精确 move 两端过闸,.md 与 .fd
   *  是两次独立 hook,宽限期让后到的 .fd move 也走精确通道),再落盘收敛。 */
  const onLocalEntryMove = async (root: string, fromRel: string, toRel: string, rec: EntryEngineRec): Promise<void> => {
    const from = fromRel.replace(/\\/g, '/')
    const to = toRel.replace(/\\/g, '/')
    const cfg = await readConfig()
    if (entryEngines.get(root) !== rec) return
    const v = (cfg.entrySync ?? []).find((x) => x.vaultRoot === root)
    if (!v) {
      rec.engine.notifyLocalMove(from, to)
      return
    }
    const r = rewriteEntriesForMove(v.entries, from, to)
    const x = rewritePathList(v.exclude ?? [], from, to)
    if (!r.changed && !x.changed) {
      rec.engine.notifyLocalMove(from, to)
      return
    }
    // 排除项取新旧并集:过渡期两端都不许过闸(否则改名瞬间被排除的子页面会被推上云)。
    rec.scope.current = buildScope([...v.entries, ...r.next], [...(v.exclude ?? []), ...x.next])
    rec.engine.notifyLocalMove(from, to)
    v.entries = r.next
    v.exclude = x.next
    await writeConfig({ entrySync: cfg.entrySync }, cfg.cloudAccountId)
    emitEntryChange()
    setTimeout(() => {
      const cur = entryEngines.get(root)
      if (cur === rec) cur.scope.current = buildScope(v.entries, v.exclude ?? [])
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
  ipcMain.handle(SYNC_IPC.setEnabled, async (_e, on: boolean) => {
    if (!syncReady) throw new Error('Cloud account is changing')
    const epoch = syncEpoch
    await sync.setEnabled(on)
    if (epoch !== syncEpoch) return sync.getStatus()
    await Promise.all([...sharedEngines.values(), ...entryEngines.values()].map(({ engine }) => engine.restart()))
    return { ...sync.getStatus(), pendingDeletions: totalPendingDeletions(), side: onCloudSide() ? 'cloud' : 'local' }
  })
  // 踢一遍所有同步引擎(主镜像 + 共享 + 按条目):auth-required/停摆的引擎会经 syncNow 内部转 restart
  // 重读凭据并拉起双向同步。手动「立即同步」用它。
  const kickAllSync = (): ReturnType<typeof sync.syncNow> => {
    if (!syncReady) return Promise.resolve(sync.getStatus())
    void refreshSharedBindings() // 顺带发现新接受的共享
    for (const { engine } of sharedEngines.values()) void engine.syncNow()
    for (const { engine } of entryEngines.values()) void engine.syncNow()
    return sync.syncNow()
  }
  /** Invalidate every old session before credentials can change. Old mirrors and
   * local notes stay on disk; only account-owned jobs/caches are retired. */
  const stopAllSync = async (): Promise<void> => {
    ++syncEpoch
    syncReady = false
    collabMain.stop()
    const stopping = [sync.stop(), ...[...sharedEngines.values()].map(({ engine }) => engine.stop()),
      ...[...entryEngines.values()].map(({ engine }) => engine.stop())]
    sharedEngines.clear()
    entryEngines.clear()
    sharedPlans = []
    entryMarkersEnsured.clear()
    presenceRoster.clear()
    pushRoster()
    await Promise.all(stopping)
    // Each existing write must finish against its original root.
    while (pendingVaultWrites.size) await Promise.allSettled([...pendingVaultWrites])
    if (vault.getRoot() && isManagedCloudVault(vault.getRoot()!)) {
      const cfg = await readConfig()
      const root = cfg.localVault && !isManagedCloudVault(cfg.localVault) ? cfg.localVault : path.join(defaultWorkspaceDir(), 'Amadeus')
      await fs.mkdir(root, { recursive: true })
      await writeConfig({ lastVault: root, localVault: root, lastPage: undefined })
      await activateRoot(root, false)
    }
    emitEntryChange()
  }
  const restartAllSync = async (): Promise<void> => {
    await stopAllSync()
    collabMain = createCollabMain()
    sync = createSyncEngine(scopedEngineDeps())
    syncReady = true
    await Promise.all([sync.restart(), refreshSharedBindings(), refreshEntryBindings()])
    emitEntryChange()
    notifyAll(SYNC_IPC.status, { ...sync.getStatus(), pendingDeletions: totalPendingDeletions(), side: onCloudSide() ? 'cloud' : 'local' })
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
    const cloudRoot = cloudVaultDir()
    // mirrorVaults:注册表是每机本地配置,换台设备恒为空 → 分区名还得从镜像里的标记文件推(与 web 同判据)。
    return { vaults: cfg.entrySync ?? [], activeRoot: vault.getRoot(), cloudRoot, mirrorVaults: await mirrorVaultNames(cloudRoot) }
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
    async (
      _e,
      payload: {
        entries: Array<{ path: string; kind: 'page' | 'folder' | 'asset' }>
        /** 弹窗里取消勾选的子页面(被条目覆盖但不要同步)。 */
        exclude?: string[]
        /** 弹窗里勾上的子页面:显式解除历史排除(不送的话上次剔除的会一直排除着)。 */
        include?: string[]
        cloudName?: string
        merge?: boolean
      },
    ) => {
      const epoch = syncEpoch
      const session = collabMain
      if (!syncReady || !currentCloudAccountId()) return { error: 'Sign in to enable cloud sync' }
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
            const vid = await session.ensureOwnVault()
            const tree = await session.call<{ folders?: string[]; entries?: Array<{ path: string }> }>(
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
            const vid = await session.ensureOwnVault()
            await session.call('PUT', `/vaults/${encodeURIComponent(vid)}/file`, { path: cloudVaultMarkerPath(v!.cloudName), content: '', baseSeq: 0 })
          } catch { /* ignore */ }
        })()
      }
      const norm = (p: unknown): string => String(p ?? '').replace(/\\/g, '/').normalize('NFC')
      const added = new Set<string>()
      for (const en of payload.entries ?? []) {
        const p = norm(en.path)
        if (!p) continue
        added.add(p)
        if (v.entries.some((x) => x.path === p)) continue
        v.entries.push({ path: p, kind: en.kind === 'folder' || en.kind === 'asset' ? en.kind : 'page' })
      }
      // 本次显式开启的路径 + 勾上的子页面退出排除名单;取消勾选的子页面进名单。
      const excl = (payload.exclude ?? []).map(norm).filter(Boolean)
      const inc = new Set([...added, ...(payload.include ?? []).map(norm).filter(Boolean)])
      v.exclude = [...new Set([...(v.exclude ?? []).filter((p) => !inc.has(p)), ...excl])]
      // 取消勾选的若本身还是显式条目,必须一并摘掉 —— coversPath 里精确条目压过 exclude,
      // 留着它 = 用户取消了勾选却照传不误。
      const exclSet = new Set(excl)
      v.entries = v.entries.filter((e) => !exclSet.has(e.path))
      if (epoch !== syncEpoch || !syncReady) return { error: 'Cloud account changed; retry from the current account' }
      await writeConfig({ entrySync: list }, cfg.cloudAccountId)
      if (epoch !== syncEpoch) return { error: 'Cloud account changed; retry from the current account' }
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
    // 仍被上级条目覆盖(子页面/文件夹子树)→ 记进 exclude,否则在子页面上点「关闭云同步」毫无反应。
    if (coversPath(v.entries, v.exclude, norm)) v.exclude = [...new Set([...(v.exclude ?? []), norm])]
    else if (v.entries.length === before) return { ok: false }
    await writeConfig({ entrySync: cfg.entrySync }, cfg.cloudAccountId)
    await refreshEntryBindings() // scope 缩小=dropShadow 干净解绑;云端/镜像副本保留(撤共享同款纪律)
    emitEntryChange()
    return { ok: true }
  })
  ipcMain.handle(SYNC_IPC.entryClosure, (_e, rootRel: string, kind: 'page' | 'folder') =>
    index.relatedClosure(String(rootRel ?? ''), kind === 'folder' ? 'folder' : 'page'),
  )

  // ── collab(页面级共享/发布/presence):token 留主进程,渲染端经 window.amadeusCollab ──
  ipcMain.handle(SYNC_IPC.collabCall, async (_e, fn: string, args: unknown[]) => {
    const session = collabMain
    const v = async (): Promise<string> => session.ensureOwnVault()
    const a = (i: number): string => String((args ?? [])[i] ?? '')
    const obj = (i: number): any => (args ?? [])[i] ?? {}
    switch (fn) {
      case 'listVaults':
        return (await session.call<{ vaults: unknown[] }>('GET', '/vaults')).vaults
      case 'activeVaultId':
        return v()
      case 'pageShare':
        return session.call('GET', `/vaults/${encodeURIComponent(await v())}/page-shares?path=${encodeURIComponent(a(0))}`)
      case 'createPageShare':
        return session.call('POST', `/vaults/${encodeURIComponent(await v())}/page-shares`, { path: a(0), ...obj(1) })
      case 'updatePageShare':
        return session.call('PATCH', `/vaults/${encodeURIComponent(await v())}/page-shares/${encodeURIComponent(a(0))}`, obj(1))
      case 'revokePageShare':
        return session.call('DELETE', `/vaults/${encodeURIComponent(await v())}/page-shares/${encodeURIComponent(a(0))}`)
      case 'setParticipantRole':
        return session.call('PATCH', `/vaults/${encodeURIComponent(await v())}/page-shares/${encodeURIComponent(a(0))}/members/${encodeURIComponent(a(1))}`, { role: a(2) })
      case 'removeParticipant':
        return session.call('DELETE', `/vaults/${encodeURIComponent(await v())}/page-shares/${encodeURIComponent(a(0))}/members/${encodeURIComponent(a(1))}`)
      case 'sharedWithMe': {
        const items = await session.sharedWithMe()
        void refreshSharedBindings()
        return items
      }
      case 'leaveShare': {
        const me = session.myUserId()
        if (!me) throw new Error('未登录')
        return session.call('DELETE', `/vaults/${encodeURIComponent(await v())}/page-shares/${encodeURIComponent(a(0))}/members/${encodeURIComponent(me)}`)
      }
      case 'publishes':
        return session.call('GET', `/vaults/${encodeURIComponent(await v())}/shares`)
      case 'listAllShares': {
        // Public View：跨全部 vault 汇总「我发布的公开链接 + 我创建的页面协作共享」。
        // 现有 publishes/pageShare 都只覆盖 own vault；这里显式遍历 listVaults 做跨库聚合。
        const vaults = (await session.call<{ vaults: Array<{ id: string; name?: string }> }>('GET', '/vaults')).vaults || []
        const myId = session.myUserId()
        const publishes: any[] = []
        const pageShares: any[] = []
        for (const vt of vaults) {
          try {
            const pr = await session.call<{ shares?: any[] }>('GET', `/vaults/${encodeURIComponent(vt.id)}/shares`)
            for (const s of pr.shares || []) publishes.push({ ...s, vaultId: vt.id, vaultName: vt.name || '' })
          } catch (e) { console.warn('[connect] listAllShares publishes vault', vt.id, 'failed:', (e as Error)?.message) /* 某库不可达则跳过 */ }
          try {
            const ps = await session.call<any>('GET', `/vaults/${encodeURIComponent(vt.id)}/page-shares`)
            const list = ps?.shares || ps?.pageShares || (Array.isArray(ps) ? ps : [])
            for (const s of list) {
              const owner = s.created_by ?? s.createdBy
              // 该端点已要求调用者是 vault owner → 缺 owner 字段时视为「我的」，别误丢（否则协作区恒空）。
              if (!myId || !owner || owner === myId) pageShares.push({ ...s, vaultId: vt.id, vaultName: vt.name || '' })
            }
          } catch (e) { console.warn('[connect] listAllShares pageShares vault', vt.id, 'failed:', (e as Error)?.message) /* 某库不可达则跳过 */ }
        }
        return { publishes, pageShares, linkBase: await session.linkBase() }
      }
      case 'createPublish': {
        const r = await session.call<{ token: string; mode: string; path: string }>('POST', `/vaults/${encodeURIComponent(await v())}/shares`, { mode: a(0), path: a(1) })
        return { ...r, url: `${await session.linkBase()}/share/${r.token}` }
      }
      case 'revokePublish':
        return session.call('DELETE', `/vaults/${encodeURIComponent(await v())}/shares/${encodeURIComponent(a(0))}`)
      // Public View 跨库撤销：显式带 vaultId（默认 own-vault 变体会撤错库、零行更新还假成功）。
      case 'revokePublishIn':
        return session.call('DELETE', `/vaults/${encodeURIComponent(a(0))}/shares/${encodeURIComponent(a(1))}`)
      case 'revokePageShareIn':
        return session.call('DELETE', `/vaults/${encodeURIComponent(a(0))}/page-shares/${encodeURIComponent(a(1))}`)
      case 'myUserId':
        return session.myUserId()
      case 'linkBase':
        return session.linkBase()
      case 'heartbeat':
        return session.heartbeat(((args ?? [])[0] as string | null) ?? null, sharedPlans)
      default:
        throw new Error(`unknown collab fn: ${fn}`)
    }
  })

  // 胶囊滑块:Local ↔ Cloud 全局切活动 vault。lastVault 恒 = 活动根(agent 工具实时跟随),
  // localVault 记住本地侧根以便切回;云镜像根固定,不污染 localVault。
  ipcMain.handle(SYNC_IPC.switchSide, async (event, side: 'local' | 'cloud') => {
    const cfg = await readConfig()
    if (side === 'cloud') {
      if (!syncReady || !currentCloudAccountId()) throw new Error('Sign in to open cloud notes')
      const dir = cloudVaultDir()
      await fs.mkdir(dir, { recursive: true })
      if (cfg.lastVault && !isManagedCloudVault(cfg.lastVault)) await writeConfig({ localVault: cfg.lastVault })
      await writeConfig({ lastVault: dir })
      const info = await activateRoot(dir, false)
      rendererRoots.set(event.sender.id, dir)
      return { ...info, side: 'cloud' }
    }
    const target = cfg.localVault && (await fs.stat(cfg.localVault).then((s) => s.isDirectory()).catch(() => false))
      ? cfg.localVault
      : null
    if (!target) {
      const info = await ensureDefaultVault()
      rendererRoots.set(event.sender.id, info.root)
      return { ...info, side: 'local' }
    }
    await writeConfig({ lastVault: target })
    const info = await activateRoot(target, false)
    rendererRoots.set(event.sender.id, target)
    return { ...info, side: 'local' }
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
    if (isManagedCloudVault(lastVault) && (!currentCloudAccountId() || lastVault !== cloudVaultDir())) {
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

  registerVaultHandlers({ vault, index, handle, rememberPage, notifyAll, logActivity, logNoteEdit })

  handle(IPC.openAttachment, async (_e, pagePath: string, ref: string) => {
    const abs = await vault.resolveAttachment(pagePath, ref)
    if (abs) await shell.openPath(abs)
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

  /** 外置插件全量读取(manifest 门禁 + bundle 收集 + 代码/文档)。IPC listPlugins 与
   *  unitHost 的 /__unit/plugins 自服面共用 —— 设备互联把同一份插件面分发给远端渲染器。 */
  const readExternalPlugins = async (): Promise<ExternalPluginSource[]> => {
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
        })
      } catch {
        /* skip malformed plugin */
      }
    }
    // 主进程 listPages 排除的扩展名 → 用独立的 manifest 预扫(不依赖各插件 main.js 是否可读,Codex #3),
    // 而非从 out 派生。按 manifest 声明豁免(与启用态无关):禁用/坏掉的插件也不能让其文件掉回笔记被 compiler 改写=毁档。
    vault.setPluginFileExtensions(collectPluginExts())
    return out
  }
  handle(IPC.listPlugins, () => readExternalPlugins())

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

  syncReady = true
  sync.start() // 云镜像同步独立于活动 vault,应用启动即拉起(未登录/显式停用时安静待命)
  void refreshSharedBindings() // 与我共享的绑定引擎(未登录时静默,syncNow/共享列表访问时再刷)
  void refreshEntryBindings() // 按条目同步绑定(注册表为空时零动作;vault 根不在时该绑定停在 error 态)

  return {
    getVaultRoot: () => vault.getRoot(),
    /** 登录成功后由 main 调:重读凭据、拉起云端双向同步(修「已登录仍显示登录提示 + 同步没开」)。 */
    restartSync: restartAllSync,
    stopSync: stopAllSync,
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
          const ev = VAULT_WRITE_EVENTS[channel]?.(args)
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
