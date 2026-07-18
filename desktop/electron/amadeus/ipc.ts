import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { IPC, gatePluginManifest, sanitizeOnboarding, type DbReadResult, type DrawingReadResult, type ExternalPluginSource, type PageProps } from '@amadeus-shared/ipc'
import { dbFileSchema, parseDb, serializeDb, seedCalendarDb } from '@amadeus-shared/db/schema'
import { rewriteDbRefs } from '@amadeus-shared/db/rewriteDbRefs'
import { parseFmObject, setFmExtraOnSource } from '@amadeus-shared/db/pageFrontmatter'
import { extractFrontmatterExtra } from '@amadeus-shared/compiler/split'
import { loadPage, newPage, pageFileName, savePage } from '@amadeus-shared/compiler'
import type { PageManifest } from '@amadeus-shared/compiler'
import { VaultManager } from './fs/vaultManager'
import { VaultWatcher } from './fs/watcher'
import { VaultIndex } from './fs/vaultIndex'
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
return () => {}
`

export function registerIpc(getWindow: () => BrowserWindow | null): {
  getVaultRoot: () => string | null
  restartSync: () => void
} {
  const vault = new VaultManager()
  const index = new VaultIndex(vault)
  let structureTimer: ReturnType<typeof setTimeout> | null = null

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
    onStatus: (s: unknown) => getWindow()?.webContents.send(SYNC_IPC.status, { ...(s as object), side: onCloudSide() ? 'cloud' : 'local' }),
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
      getWindow()?.webContents.send(SYNC_IPC.status, { ...(s as object), side: 'local', binding: vaultRoot }),
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
      getWindow()?.webContents.send(IPC.externalChange, pagePath)
    },
    () => {
      // External add/remove of pages or folders → debounce a reindex + notify the renderer.
      if (structureTimer) clearTimeout(structureTimer)
      structureTimer = setTimeout(() => {
        structureTimer = null
        void index.build()
        getWindow()?.webContents.send(IPC.structureChange)
      }, 300)
    },
    (dbPath) => {
      // 外部改 .db(如 agent 直连磁盘改日历)→ 通知渲染端热重载对应 dbStore 条目。
      getWindow()?.webContents.send(IPC.dbChange, dbPath)
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

  ipcMain.handle(SYNC_IPC.get, () => ({ ...sync.getStatus(), side: onCloudSide() ? 'cloud' : 'local' }))
  ipcMain.handle(SYNC_IPC.setEnabled, (_e, on: boolean) => sync.setEnabled(on))
  // 踢一遍所有同步引擎(主镜像 + 共享 + 按条目):auth-required/停摆的引擎会经 syncNow 内部转 restart
  // 重读凭据并拉起双向同步。手动「立即同步」与「登录后自动拉起」(main.ts auth:forsionLogin)共用此函数。
  const kickAllSync = (): ReturnType<typeof sync.syncNow> => {
    void refreshSharedBindings() // 顺带发现新接受的共享
    for (const { engine } of sharedEngines.values()) void engine.syncNow()
    for (const { engine } of entryEngines.values()) void engine.syncNow()
    return sync.syncNow()
  }
  ipcMain.handle(SYNC_IPC.syncNow, () => kickAllSync())

  // ── 按条目云同步 IPC 面 ────────────────────────────────────────────────────
  ipcMain.handle(SYNC_IPC.entryGet, async () => {
    const cfg = await readConfig()
    return { vaults: cfg.entrySync ?? [], activeRoot: vault.getRoot(), cloudRoot: cloudVaultDir() }
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
      case 'createPublish': {
        const r = await collabMain.call<{ token: string; mode: string; path: string }>('POST', `/vaults/${encodeURIComponent(await v())}/shares`, { mode: a(0), path: a(1) })
        return { ...r, url: `${await collabMain.linkBase()}/share/${r.token}` }
      }
      case 'revokePublish':
        return collabMain.call('DELETE', `/vaults/${encodeURIComponent(await v())}/shares/${encodeURIComponent(a(0))}`)
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
      ? { status: 'ok', path: rel, data: r.data }
      : { status: 'corrupt', path: rel, message: r.error }
  })

  ipcMain.handle(IPC.dbWrite, async (_e, dbPath: string, data: unknown) => {
    const parsed = dbFileSchema.parse(data) // 防御性校验:坏数据拒写,绝不落半截文件
    await vault.writeTextFile(dbPath, serializeDb(parsed))
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
        getWindow()?.webContents.send(IPC.externalChange, p)
        rewrittenPages.push(p)
      }
    }
    return { newPath, rewrittenPages }
  })

  ipcMain.handle(IPC.search, (_e, query: string) => index.search(query))
  ipcMain.handle(IPC.backlinks, (_e, pagePath: string) => index.backlinks(pagePath))
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
        }
        const id = m.id || e.name
        if (seen.has(id)) continue
        // 门禁:apiVersion 不匹配 / 应用太旧 → 列出但不可加载(blocked 徽章),code 不读不发。
        const blocked = gatePluginManifest(m, app.getVersion())
        const code = blocked ? '' : await fs.readFile(path.join(pdir, m.main || 'main.js'), 'utf8')
        // README 给设置详情页;blocked 也读(无害,帮用户了解这插件是什么)。
        const readme = await fs.readFile(path.join(pdir, 'README.md'), 'utf8').then((s) => s.slice(0, 65536), () => undefined)
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
          onboarding: sanitizeOnboarding(m.onboarding),
          blocked: blocked ?? undefined,
        })
      } catch {
        /* skip malformed plugin */
      }
    }
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

  sync.start() // 云镜像同步独立于活动 vault,应用启动即拉起(未登录/显式停用时安静待命)
  void refreshSharedBindings() // 与我共享的绑定引擎(未登录时静默,syncNow/共享列表访问时再刷)
  void refreshEntryBindings() // 按条目同步绑定(注册表为空时零动作;vault 根不在时该绑定停在 error 态)

  return {
    getVaultRoot: () => vault.getRoot(),
    /** 登录成功后由 main 调:重读凭据、拉起云端双向同步(修「已登录仍显示登录提示 + 同步没开」)。 */
    restartSync: () => { void kickAllSync() },
  }
}
