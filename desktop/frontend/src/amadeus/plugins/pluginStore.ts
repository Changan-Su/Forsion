// The plugin host. Holds the plugin registry, the persisted "disabled" preference, the
// runtime active set, and the live contribution registries (slash items / commands /
// themes) that the UI subscribes to. Built-in plugins are registered on init(); external
// (Forsion) plugins are discovered from ~/.forsion/plugins/ and evaluated here.
//
import { registerFont as registerHostFont } from '../../fontPresets'

// Trust model: external plugins run with the curated `ctx.app` API (and, like Obsidian,
// full renderer scope). Only install plugins you trust.

import { create } from 'zustand'
import { noteOf, usePageStore } from '../store/pageStore'
import { useUiStore } from '../store/uiStore'
import { setTheme as applyAccent, toggleMode } from '../theme/ThemeManager'
import { amadeus } from '../api'
import { BUILTIN_PLUGINS } from './builtins'
import { registerPropertyType as registerPropType, unregisterPropertyType as unregisterPropType } from '../blocks/database/propertyTypes'
import { isBuiltinFileType } from '@amadeus-shared/builtinTypes'
import { createBlockSurface } from './blockSurface'
import { addEditorExtension, clearEditorExtensions } from './editorExtensions'
import { registerPluginSeries, track, unregisterPluginAchievements } from '../../achievements/store'
import { act } from '../../activity/log'
import { notifyApp } from '../../stores/notificationStore'
import { currentLocale, registerMessages, subscribeLocale, translate } from '../../i18n'
import { readTangu } from './tanguSeam'
import { AUTO_WORK_FOLDER_KEY } from './display'
// 自动化播种 / 禁用即关规则:backendService 依赖图干净(http / agentRunService / localInbox,均不引 appStore),
// 可静态 import;cfg 必须经 tanguSeam 探针的 waitBackend 拿(appStore 与本模块有 import 环)。
import { getMuseTriggers, saveMuseTrigger } from '../../services/backendService'
import { buildPluginTriggerUpserts, isPluginOwnedRule, normalizeVaultRel } from './pluginAutomation'
import { MUTATE_DB_RETRIES, mutateDbCas } from './pluginDb'
import { useDbStore } from '../store/dbStore'
import { kickAutomation } from '../store/automationKick'
import { triggerToUpsert } from '../../views/automation/lib'
import { memberOf, useCalendarConfig } from '../store/calendarConfigStore'
import type {
  AmadeusPlugin,
  CommandContribution,
  EmbedRendererContribution,
  FileCreatorContribution,
  FileTypeContribution,
  PanelContribution,
  PluginAppApi,
  PluginContext,
  PropertyTypeContribution,
  SettingContribution,
  SettingsViewContribution,
  SlashContribution,
  StatusItemContribution,
  ThemeContribution,
  ViewContribution,
  ListSourceContribution,
  PluginAutomationRule,
} from './types'
import { gatePluginManifest, type ExternalPluginSource } from '@amadeus-shared/ipc'
import { compileDashboardRecipe } from '@amadeus-shared/dashboardRecipe'

// 宿主自己产出的用户可见文案(插件贡献的文案由插件自己带双语,见 display.ts 的语言解析单点)。
// 命名空间 `pluginhost.*` 是本文件专属,别处不要复用。
registerMessages({
  'pluginhost.workFolder.label': { zh: '工作文件夹', en: 'Working folder' },
  'pluginhost.workFolder.desc': {
    zh: '本插件在笔记库内读写文件的文件夹(相对库根;留空恢复默认=插件名)',
    en: 'Folder inside the vault where this plugin reads and writes files (relative to the vault root; leave empty to fall back to the plugin name)',
  },
  'pluginhost.setupFailed': { zh: '插件「{name}」加载失败', en: 'Plugin "{name}" failed to load' },
  'pluginhost.sampleCreated': { zh: '已创建示例插件 hello-amadeus', en: 'Created the sample plugin hello-amadeus' },
})

const DISABLED_KEY = 'amadeus.plugins.disabled'

/** 外置插件来源:**unit 设备页**(B 端渲染,方案 §11.4 —— 本页就是某台设备曝出来的网页)从该设备的
 *  `unit/plugins` 面拉(相对 base:局域网直连与 server 隧道子路径同一写法);其余环境走
 *  window.amadeus.listPlugins(desktop IPC / web 云桥)。设备页的壳构建与设备端 App 可能不同版本,
 *  按**壳自己的**版本再过一遍门禁 —— 被闸的照常列出(blocked 徽章),绝不静默消失。 */
async function resolveExternalSources(): Promise<ExternalPluginSource[]> {
  const unitPage = (window as unknown as { __FORSION_UNIT_PAGE__?: unknown }).__FORSION_UNIT_PAGE__
  if (unitPage) {
    const token = (window as unknown as { __FORSION_UNIT_TOKEN__?: string }).__FORSION_UNIT_TOKEN__ || ''
    const r = await fetch(new URL('unit/plugins', document.baseURI), {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
    if (!r.ok) throw new Error(`unit plugins HTTP ${r.status}`)
    const j = (await r.json()) as { plugins?: ExternalPluginSource[] }
    const { CHANGELOG } = await import('../../changelog')
    const myVersion = CHANGELOG[0]?.version || '0.0.0'
    return (j.plugins || []).map((src) => {
      const blocked = gatePluginManifest({ apiVersion: src.apiVersion, minAppVersion: src.minAppVersion }, myVersion) ?? src.blocked
      return blocked ? { ...src, blocked, code: '' } : src
    })
  }
  return amadeus.listPlugins()
}

interface Owned<T> {
  pluginId: string
  item: T
  /** 状态条项专用:本次注册的实例牌(handle 只认牌不认 id)。disable→enable 后旧 handle
   *  持的是旧牌,更新/摘除都打不中新实例(插件在飞的异步任务不会污染重启后的注册)。 */
  token?: object
}

interface PluginState {
  plugins: AmadeusPlugin[]
  /** Persisted preference: ids the user has explicitly turned off (default = enabled). */
  disabledIds: string[]
  /** Runtime: plugins whose setup() has run. */
  activeIds: string[]
  slashItems: Owned<SlashContribution>[]
  commands: Owned<CommandContribution>[]
  themes: Owned<ThemeContribution>[]
  panels: Owned<PanelContribution>[]
  statusItems: Owned<StatusItemContribution>[]
  propertyTypes: Owned<PropertyTypeContribution>[]
  settings: Owned<SettingContribution>[]
  settingsViews: Owned<SettingsViewContribution>[]
  views: Owned<ViewContribution>[]
  listSources: Owned<ListSourceContribution>[]
  fileTypes: Owned<FileTypeContribution>[]
  embedRenderers: Owned<EmbedRendererContribution>[]
  fileCreators: Owned<FileCreatorContribution>[]
  /** 宿主注入的视图打开器(桌面壳=workspace.openView);无工作台的宿主保持 null,ctx.openView 即 no-op。 */
  viewOpener: ((type: string, loc?: 'main' | 'left' | 'right') => void) | null
  setViewOpener(fn: ((type: string, loc?: 'main' | 'left' | 'right') => void) | null): void
  disposers: Record<string, (() => void) | undefined>
  initialized: boolean
  /** 注册并按偏好启用一组插件;缺省 = 全部 builtins(独立版);桌面壳传自己的选择性子集。 */
  init(plugins?: AmadeusPlugin[]): void
  enable(id: string): void
  disable(id: string): void
  toggle(id: string): void
  isActive(id: string): boolean
  loadExternal(): Promise<void>
  reloadExternal(): Promise<void>
  openPluginsFolder(): void
  scaffoldSample(): Promise<void>
}

/** 文件夹名消毒:插件显示名可能含路径非法字符;清完为空则退回 fallback(插件 id,天然合法)。 */
function sanitizeFolderName(name: string, fallback: string): string {
  const s = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim()
  return s || fallback
}

/** 宿主自动塞进每个启用插件的「工作文件夹」设置行(见 enable())。文案在 enable() 那一刻求值,
 *  切语言后由文件末尾的订阅就地重刷 —— 认的是**对象身份**(下面这个 WeakSet)而不是 key:
 *  插件可以用同 key registerSetting 顶掉这一行(见 registerSetting 的去重),按 key 重刷会把
 *  插件自己写的文案抹成宿主的。 */
const autoWorkFolderRows = new WeakSet<SettingContribution>()
function workFolderSetting(pluginName: string, pluginId: string): SettingContribution {
  return relabelWorkFolder({
    key: AUTO_WORK_FOLDER_KEY,
    type: 'text',
    default: sanitizeFolderName(pluginName, pluginId),
    label: '',
  })
}
/** 换一份当前语言的文案(key/default 原样带过);新对象照样登记进 WeakSet,下次切语言还认得。 */
function relabelWorkFolder(prev: SettingContribution): SettingContribution {
  const item: SettingContribution = {
    ...prev,
    label: translate('pluginhost.workFolder.label'),
    description: translate('pluginhost.workFolder.desc'),
  }
  autoWorkFolderRows.add(item)
  return item
}

/** 路径归一:主进程在 Windows 上用 `path.relative()` 返回 `\` 分隔 —— 平台差异不许传给第三方插件
 *  (仓库自己为此打过补丁,见 amadeus/lib/fd.ts)。 */
const toSlash = (p: string): string => String(p ?? '').replace(/\\/g, '/')

/** 枚举是**整库递归扫盘 + 排序 + 跨进程传输**,「插件自己分页」减不掉这份成本(codex 评审指出)。
 *  多个插件在同一屏内反复要清单是常态,这里做 single-flight + 1.5s 短缓存:并发合成一次调用,
 *  刚拿到的结果短时间内复用。缓存**不跨库**:pageStore 的 vaultRoot 变了立刻作废。 */
const listCache: Record<'pages' | 'files', { at: number; root: string; p: Promise<string[]> } | undefined> = {
  pages: undefined,
  files: undefined,
}
function listCached(kind: 'pages' | 'files'): Promise<string[]> {
  const fn = kind === 'pages' ? amadeus?.listPages : amadeus?.listFiles
  if (!fn) return Promise.resolve([])
  const root = usePageStore.getState().vaultRoot || ''
  const hit = listCache[kind]
  if (hit && hit.root === root && Date.now() - hit.at < 1500) return hit.p
  const p = Promise.resolve(fn.call(amadeus))
    .then((xs) => (xs || []).map(toSlash))
    .catch(() => []) // 没有活动库时主进程 requireRoot() 会抛 —— 统一成空数组
  listCache[kind] = { at: Date.now(), root, p }
  return p
}

// ── ctx.app.watchFile 的分发器(2026-08-15)。主进程一条广播(非 .md/.db 文件的外部内容改动),
//    渲染端按路径分给订阅者。**接线是懒的**:第一个订阅者出现才挂 IPC 监听,最后一个走了就摘掉 ——
//    没人用这条能力时不留常驻监听。
const fileWatchers = new Map<string, Set<() => void>>()
let fileWatchOff: (() => void) | null = null
/** 路径归一到与 readFile 同一形态(vault 相对、`/` 分隔、无前导斜杠);大小写按平台原样不动。 */
const normRel = (p: unknown): string => toSlash(String(p ?? '')).replace(/^\/+/, '')

function watchVaultFile(rel: string, cb: () => void): () => void {
  const key = normRel(rel)
  if (!key || typeof cb !== 'function') return () => {}
  if (!fileWatchOff) {
    fileWatchOff = amadeus?.onFileExternalChange?.((changed) => {
      for (const fn of Array.from(fileWatchers.get(normRel(changed)) ?? [])) {
        try { fn() } catch (e) { console.error('[amadeus] watchFile 回调抛错', e) }
      }
    }) ?? null
  }
  let bucket = fileWatchers.get(key)
  if (!bucket) fileWatchers.set(key, (bucket = new Set()))
  bucket.add(cb)
  return () => {
    const b = fileWatchers.get(key)
    if (!b) return
    b.delete(cb)
    if (!b.size) fileWatchers.delete(key)
    if (!fileWatchers.size && fileWatchOff) {
      fileWatchOff()
      fileWatchOff = null
    }
  }
}

/** 每个插件一份 app API。块表面是**可吊销**的(见 blockSurface.tsx 的信任边界说明):
 *  teardown 时调 revoke,插件开的订阅/挂的 React root 一并收掉,之后它在飞的异步任务也改不动用户文件。 */
function makeAppApi(pluginId: string, getName: () => string): { api: PluginAppApi; revokeSurface: () => void } {
  const surface = createBlockSurface(pluginId)
  // 块表面有 alive 闸,ctx.app 的**直通副作用面**(写盘/换页/开文件)此前没有 —— 插件禁用后残留的
  // setTimeout / 在飞 promise 照样能 writeFile 落盘,与 teardown 注释「收完 API 整体变哑」直接矛盾
  // (评审 P1,2026-08-14)。同款纪律补齐:吊销后副作用方法变 no-op 并说一声。
  let alive = true
  const ok = (): boolean => {
    if (!alive) console.warn(`[amadeus] 插件 ${pluginId} 已停用,ctx.app 副作用调用被忽略`)
    return alive
  }
  // 文件订阅与语言订阅同一条纪律:插件自己能退订,但最终责任人是宿主 —— 停用时统一收掉,
  // 否则被禁用的插件还在被外部改动唤醒(它的回调里往往就是一次 readFile + 重建内部状态)。
  const fileUnsubs = new Set<() => void>()
  const api: PluginAppApi = {
    // 两条路由通用(v4 不设 activePage;正文也不进 store —— 一律取块表面那份统一派生,别再各写各的)。
    getActivePage: () => noteOf(usePageStore.getState()),
    getActivePageText: () => surface.api.getPage().text,
    loadPage: (p) => { if (ok()) void usePageStore.getState().loadPage(p) },
    createPage: () => { if (ok()) void usePageStore.getState().createPage() },
    toggleMode: () => void toggleMode(),
    setTheme: (t) => applyAccent(t),
    openSearch: () => useUiStore.getState().setPalette('search'),
    openSwitcher: () => useUiStore.getState().setPalette('switch'),
    ...surface.api, // 真块表面(mountBlocks/getPage/…):内置与外置插件同一份能力,见 blockSurface.tsx
    notify: (m) => useUiStore.getState().notify(m),
    readFile: (p) => amadeus.readTextFile(p),
    writeFile: (p, text) => (ok() ? amadeus.writeTextFile(p, text) : Promise.resolve()),
    // 多维表比对交换写口(2026-09-02):与 dbStore 同一条 db:write-cas 路。写成功后让渲染端已加载的
    // 那份热重载(否则表格要等 VaultWatcher 一拍),并踢一下引擎(让盯这张表的 db_changed 规则 ~2s 内看到)。
    // ⚠️活性判两处:入口一次挡住「已禁用还来调」,`isLive` 闭包挡住「调用中途被禁用」——
    // readDatabase / 冲突重读 / 等写各是一次 await,只判入口的话吊销后的插件照样能落盘(codex 二轮 high)。
    mutateDb: async (p, fn) => {
      if (!ok()) return { ok: false, error: 'plugin disabled' }
      const r = await mutateDbCas(amadeus, p, fn, MUTATE_DB_RETRIES, () => alive)
      if (r.ok) {
        void useDbStore.getState().reloadByPath(normalizeVaultRel(p)).catch(() => {})
        kickAutomation()
      }
      return r
    },
    // 桥缺席(web/移动端/台架)时**整条方法不挂** —— 挂一个永不触发的空壳会让插件的
    // `if (ctx.app.watchFile) …else 轮询` 走错分支,配置改了永远热重载不了。
    ...(amadeus?.onFileExternalChange
      ? {
          watchFile: (p: string, cb: () => void): (() => void) => {
            if (!alive) return () => {}
            const off = watchVaultFile(p, cb)
            const wrapped = (): void => { off(); fileUnsubs.delete(wrapped) }
            fileUnsubs.add(wrapped)
            return wrapped
          },
        }
      : {}),
    // 工作文件夹(相对 vault 根):读标准设置 plugin.<id>.workFolder;没设或非法(空段/./..)→ 插件显示名。
    workFolder: () => {
      let v = ''
      try { v = localStorage.getItem(`plugin.${pluginId}.workFolder`) || '' } catch { /* ignore */ }
      v = v.trim().replace(/^\/+|\/+$/g, '')
      const bad = !v || v.split('/').some((seg) => !seg.trim() || seg === '.' || seg === '..')
      return bad ? sanitizeFolderName(getName(), pluginId) : v
    },
    // 打开文件类型视图在 amadeusNav(它引 pluginStore 的 matchFileType)→ 动态 import 破静态环。
    openFile: (p) => { if (ok()) void import('../../amadeusNav').then((m) => m.openFile(p)) },
    // 只读 vault 查询面(2026-08-14,codex 评审后的口径):纯透传主进程既有 IPC,没有写口。
    // 三条统一语义 —— **桥缺席(web/台架未垫)或没有活动库都给空数组,绝不 reject**:
    // 插件侧的可选链只挡得住「宿主没这个方法」,挡不住「方法在但 window.amadeus 是 undefined」,
    // 也挡不住主进程 requireRoot() 抛。一半空值一半异常是最难写对的 API。
    listPages: () => listCached('pages'),
    listFiles: () => listCached('files'),
    searchVault: async (q) => {
      if (!amadeus?.search) return []
      try {
        const hits = await amadeus.search(String(q ?? ''))
        return (hits || []).map((h) => ({ ...h, path: toSlash(h.path) }))
      } catch { return [] }
    },
    // 库绝对路径:读渲染进程已有的 pageStore 状态,**不调 restoreVault**(那会重开库,有副作用)。
    vaultRoot: () => usePageStore.getState().vaultRoot || null,
    // 在系统文件管理器里定位库内路径(2026-08-29+)。桥缺席时**整条方法不挂**,同 watchFile 的
    // 纪律 —— 挂个空壳会让插件的「有这个方法就画按钮」分支画出一颗点了没反应的按钮。
    ...(amadeus?.revealInFileManager
      ? { reveal: (p: string): void => { if (ok()) void amadeus.revealInFileManager(p).catch(() => {}) } }
      : {}),
  }
  return {
    api,
    revokeSurface: () => {
      alive = false
      surface.revoke()
      for (const u of Array.from(fileUnsubs)) {
        try { u() } catch (e) { console.error(`[amadeus] plugin "${pluginId}" watchFile unsubscribe failed`, e) }
      }
      fileUnsubs.clear()
    },
  }
}

function injectThemeStyle(id: string, css: string): void {
  const elId = `amadeus-plugin-theme-${id}`
  let el = document.getElementById(elId) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = elId
    document.head.appendChild(el)
  }
  el.textContent = css
}
function removeThemeStyle(id: string): void {
  document.getElementById(`amadeus-plugin-theme-${id}`)?.remove()
}
function readDisabled(): string[] {
  try {
    const v = localStorage.getItem(DISABLED_KEY)
    return v ? (JSON.parse(v) as string[]) : []
  } catch {
    return []
  }
}
function writeDisabled(ids: string[]): void {
  try {
    localStorage.setItem(DISABLED_KEY, JSON.stringify(ids))
  } catch {
    /* ignore */
  }
}

/** 读持久化的禁用插件 id(直读 localStorage,不依赖 store 是否已 init)。
 *  供 userSpaces 在启动装载时过滤「被禁用插件的内嵌 Space」——那一刻插件宿主可能还没装配。 */
export function readDisabledPluginIds(): string[] {
  return readDisabled()
}

/** Wrap an external source as a plugin whose setup() evaluates its code with `ctx`. */
function toPlugin(src: ExternalPluginSource): AmadeusPlugin {
  return {
    id: src.id,
    name: src.name,
    nameEn: src.nameEn,
    version: src.version,
    description: src.description,
    descriptionEn: src.descriptionEn,
    iconUrl: src.iconUrl,
    builtin: false,
    apiVersion: src.apiVersion,
    minAppVersion: src.minAppVersion,
    requiresApp: src.requiresApp,
    capabilities: src.capabilities,
    readme: src.readme,
    changelog: src.changelog,
    onboarding: src.onboarding,
    blocked: src.blocked,
    bundle: src.bundle,
    events: src.events,
    setup: (ctx) => {
      const fn = new Function('ctx', src.code) as (c: PluginContext) => unknown
      const d = fn(ctx)
      return typeof d === 'function' ? (d as () => void) : undefined
    },
  }
}

/** 插件文件后缀的形态判定(registerFileType 与 viewSurface 的 loadPage 闸共用)。 */
export function isValidPluginExt(e: string): boolean {
  if (!e.startsWith('.') || e.length < 2) return false
  if (/\.md$/i.test(e)) return /^\.[^.].*\.md$/i.test(e) // md 类必须复合后缀 '.X.md'
  return true
}

/** 视图级页表面(viewSurface)的吊销登记:插件禁用时 fileTypes 切片一变,React 重渲 → effect
 *  cleanup 会把视图表面收掉,但那是**异步**的 —— teardown 里同步吊销才封死「禁用后在飞的插件
 *  代码还能写文件」的空窗。视图正常卸载时自己 dereg,这里只兜插件层的收尸。 */
const viewTeardowns = new Map<string, Set<() => void>>()
export function addPluginViewTeardown(pluginId: string, fn: () => void): () => void {
  let bucket = viewTeardowns.get(pluginId)
  if (!bucket) viewTeardowns.set(pluginId, (bucket = new Set()))
  bucket.add(fn)
  return () => { viewTeardowns.get(pluginId)?.delete(fn) }
}

/** ctx.automation / ctx.calendar 共用的「等库恢复」。vault 是懒恢复的(bootstrapEngine:「vault 恢复仍然懒」),
 *  外置插件 setup 那一刻 pageStore.vaultRoot 多半还是 null —— 同步判 null 就拒,等于 ERP 那类插件永远种不下规则。
 *  已恢复即刻 resolve;否则订阅 pageStore 直到有 root 或超时(null)。 */
function waitVaultRoot(timeoutMs: number): Promise<string | null> {
  const now = usePageStore.getState().vaultRoot
  if (now) return Promise.resolve(now)
  return new Promise((resolve) => {
    let done = false
    const finish = (v: string | null): void => {
      if (done) return
      done = true
      off()
      clearTimeout(timer)
      resolve(v)
    }
    const off = usePageStore.subscribe((st) => { if (st.vaultRoot) finish(st.vaultRoot) })
    const timer = setTimeout(() => finish(null), Math.max(0, timeoutMs))
  })
}
/** 后端 + 库两件事共用一个 60s 窗口(托管模式后端启动可能要十几秒;库恢复要等左栏/日历挂载)。 */
const ENSURE_WAIT_MS = 60_000
const errMsg = (e: unknown): string => String((e as { message?: unknown })?.message || e)

/** 每插件最近一次 ensure 的记录(重放的输入):rules 原样留着,后端下次就绪时对 ok=false 的重放一次。 */
export interface PluginEnsureState {
  rules: PluginAutomationRule[]
  /** 这次 ensure 结束的时刻(ms)。 */
  at: number
  ok: boolean
  errors: string[]
  /** 已自动重放的次数(插件自己再调 ensure 归零)。 */
  replays: number
  /** 上一次自动重放起跑的时刻;节流按它算(不按 at:waitBackend 超时 60s 后引擎几秒内就绪是最常见的路,
   *  按 at 节流会把它永远挡住 —— 没有第二个边沿来救)。 */
  lastReplayAt: number
  /** 正在飞(原始 ensure 或重放尚未结束)→ 边沿来了也不叠一次。 */
  pending: boolean
}
const lastEnsure = new Map<string, PluginEnsureState>()
/** 同一插件两次自动重放至少隔 30s;最多重放 3 次(之后只能靠插件重载 / 命令面板「重新登记」)。 */
const ENSURE_REPLAY_MIN_GAP_MS = 30_000
const ENSURE_REPLAY_MAX = 3
export function getPluginEnsureState(pluginId: string): PluginEnsureState | null {
  return lastEnsure.get(pluginId) ?? null
}

/** 「待停用」墓碑(2026-09-02,codex 二轮 high):用户禁用插件那一刻后端不在(或拉/发失败)——
 *  引擎里那份 `plugin:<id>:` 规则仍是 enabled,后端恢复后照跑数据库动作,而 UI 上插件早已是禁用态。
 *  与 ensure 的失败态同一套思路:记一条,后端 !ok→ok 边沿重试(节流 ≥30s、上限 3 次)。
 *  **不存在成功态** —— 关成了就删记录;记录还在 = 「规则尚未停用」,这就是对外的可见量。
 *  ⚠️墓碑作废条件是插件被**重新启用**:用户刚打开的插件,绝不能让上一轮的欠账把它的规则关掉。 */
export interface PluginDisableState {
  /** 这次尝试结束的时刻(ms)。 */
  at: number
  errors: string[]
  replays: number
  lastReplayAt: number
  /** 正在飞(原始 disable 或重放尚未结束)→ 边沿来了也不叠一次。 */
  pending: boolean
}
// ponytail: 墓碑住内存,重启即丢 —— 落 localStorage + 装配时重放是下一步,本轮先把就绪边沿这条路接上。
const pendingDisable = new Map<string, PluginDisableState>()
/** 非 null = 这个插件的自动化规则**还没停用**(供设置页/排障露出;与 getPluginEnsureState 同一条路)。 */
export function getPluginDisableState(pluginId: string): PluginDisableState | null {
  return pendingDisable.get(pluginId) ?? null
}

/** 每插件一条规则串行链:ensure 的「逐条 upsert」与 disable 的「拉全量 → 逐条关」不许交错。
 *  交错的后果是静默的:disable 先拉到名单(那时 ensure 还没发),ensure 随后把规则全 upsert 成 enabled:true,
 *  最终用户看到插件是禁用的、引擎里规则却是开的 —— 正是 codex 抓的那条。链只按 id 分,不引依赖。 */
const ruleChains = new Map<string, Promise<unknown>>()
function serialByPlugin<T>(pluginId: string, task: () => Promise<T>): Promise<T> {
  const next = (ruleChains.get(pluginId) ?? Promise.resolve()).then(task, task)
  ruleChains.set(pluginId, next.catch(() => {})) // 链本身不许因为某一环失败就断掉
  return next
}

/** 就绪边沿订阅只挂一份,且跟着探针对象走:探针换了(测试 / 重装配)就退掉旧的重挂 —— 挂在旧探针上的订阅永远收不到新边沿。 */
let readySub: { probe: object; off: () => void } | null = null
function ensureReadySubscription(): void {
  const probe = readTangu()
  if (readySub && readySub.probe === probe) return
  readySub?.off()
  readySub = null
  if (!probe?.subscribeReady) return
  readySub = { probe, off: probe.subscribeReady(onBackendReadyEdge) }
}

/** 后端 !ok→ok 边沿的唯一入口:两笔欠账都在这里补 —— 没种下的规则(ensure)与没停用的规则(disable)。 */
function onBackendReadyEdge(): void {
  replayFailedEnsures()
  replayPendingDisables()
}

/** 对「上次 ensure 失败、没在飞、离上次重放 ≥30s、重放未满 3 次」的插件各重放一次。
 *  重放条件是「上次失败」而不是「后端就绪」:引擎重启不丢规则,成功过的不用再发。
 *  「仍启用」不在这里判:禁用 = teardown 同步删记录(再启用而 setup 不再 ensure 也不会把旧规则集发出去),
 *  等待窗口里被禁用由 ensurePluginAutomationOnce 的 activeIds 闸让位 —— 这里再判一遍是测不出来的死代码。 */
function replayFailedEnsures(): void {
  const now = Date.now()
  for (const [pluginId, st] of lastEnsure) {
    if (st.ok || st.pending) continue
    if (st.replays >= ENSURE_REPLAY_MAX || now - st.lastReplayAt < ENSURE_REPLAY_MIN_GAP_MS) continue
    st.replays += 1
    st.lastReplayAt = now
    void ensurePluginAutomation(pluginId, st.rules, true).then((r) => {
      if (!r.ok) console.warn(`[amadeus] plugin "${pluginId}" 自动化规则重放仍失败(${st.replays}/${ENSURE_REPLAY_MAX})`, r.errors)
    })
  }
}

/** `ctx.automation.ensure` 的宿主侧:等库 → 构造/校验(纯函数)→ 等后端 → 逐条 upsert,收 errors,**不抛**。
 *  vault 为 null(超时仍没开库)→ 整批不发:引擎会把空 vault 静默回落成它自己认的库,规则被钉到错的库上极难归因。
 *  结果记进 lastEnsure;失败的在后端下次就绪边沿由 replayFailedEnsures 重放(replay=true 时不清零计数)。 */
async function ensurePluginAutomation(pluginId: string, rules: PluginAutomationRule[], replay = false): Promise<{ ok: boolean; errors: string[] }> {
  ensureReadySubscription()
  const prev = replay ? lastEnsure.get(pluginId) : null
  const st: PluginEnsureState = { rules, at: Date.now(), ok: false, errors: [], replays: prev?.replays ?? 0, lastReplayAt: prev?.lastReplayAt ?? 0, pending: true }
  lastEnsure.set(pluginId, st)
  const r = await ensurePluginAutomationOnce(pluginId, rules)
  // 等待期间插件被禁用又启用、或自己又调了 ensure → 记录已换人,这份结果不覆盖它
  if (lastEnsure.get(pluginId) === st) Object.assign(st, { at: Date.now(), ok: r.ok, errors: r.errors, pending: false })
  return r
}

async function ensurePluginAutomationOnce(pluginId: string, rules: PluginAutomationRule[]): Promise<{ ok: boolean; errors: string[] }> {
  const started = Date.now()
  const vault = await waitVaultRoot(ENSURE_WAIT_MS)
  if (!vault) return { ok: false, errors: ['No vault is open'] }
  const { upserts, errors } = buildPluginTriggerUpserts(pluginId, vault, rules)
  if (!upserts.length) return { ok: !errors.length, errors }
  const cfg = (await readTangu()?.waitBackend?.(Math.max(0, ENSURE_WAIT_MS - (Date.now() - started)))) ?? null
  if (!cfg) return { ok: false, errors: [...errors, '引擎后端未就绪(等待超时)'] }
  // 下发段进串行链:同插件的 disable 不会插在这些 upsert 中间(它拉名单时 ensure 已经发完,能看见并关掉)。
  return serialByPlugin(pluginId, async () => {
    // 等待/排队窗口里用户把插件关了:disable 已发 enabled:false,这里再发 enabled:true 会把它开回去 —— 让位。
    // 判定放在链**内**:锁外判过再进锁,中途插进来的 disable 就白关了。
    if (!usePluginStore.getState().activeIds.includes(pluginId)) return { ok: false, errors: [...errors, 'plugin disabled before rules were ensured'] }
    for (const u of upserts) {
      try {
        await saveMuseTrigger(cfg, u)
      } catch (e) {
        errors.push(`${u.id}: ${errMsg(e)}`)
      }
    }
    return { ok: !errors.length, errors }
  })
}

/** 用户**明确禁用**插件 → 它的 `plugin:<id>:` 规则全部 enabled=false(不删;再启用时插件自己的 ensure 会置回 true,
 *  引擎那边 false→true 会 dropCursors 重新播种)。全量拉 + 前缀过滤,没有就自然 no-op;fire-and-forget。
 *  ⚠️只挂在 disable(id) 上,不进 teardown / revokers —— 那两条被 reloadExternal 与 setup 抛错分支复用,
 *  在那里关规则会与紧随其后的 ensure(enabled:true)赛跑。
 *  ⚠️关不掉不许静默返回(codex 二轮 high):后端不在 / 拉不到 / 发失败一律留墓碑(pendingDisable),
 *  后端 !ok→ok 边沿重试;墓碑还在 = 「规则尚未停用」,由 getPluginDisableState 露出来。 */
async function disablePluginRules(pluginId: string, replay = false): Promise<void> {
  // 从没调过 ensure、但引擎里留着上一次运行种下的规则 → 这里也得把就绪边沿挂上,否则墓碑永远等不到人来重放。
  ensureReadySubscription()
  const prev = replay ? pendingDisable.get(pluginId) : null
  const st: PluginDisableState = { at: Date.now(), errors: [], replays: prev?.replays ?? 0, lastReplayAt: prev?.lastReplayAt ?? 0, pending: true }
  pendingDisable.set(pluginId, st)
  const errors: string[] = []
  const cfg = (await readTangu()?.waitBackend?.(ENSURE_WAIT_MS)) ?? null
  if (!cfg) errors.push('引擎后端未就绪(等待超时),规则尚未停用')
  else {
    await serialByPlugin(pluginId, async () => {
      // 排队期间用户又把插件打开了(它的 setup 多半已经 ensure 过一轮)→ 这次禁用整个作废。
      if (usePluginStore.getState().activeIds.includes(pluginId)) return
      let list: Awaited<ReturnType<typeof getMuseTriggers>>
      try {
        list = await getMuseTriggers(cfg)
      } catch (e) {
        errors.push(errMsg(e))
        return
      }
      for (const t of list) {
        if (!isPluginOwnedRule(pluginId, t.id) || !t.enabled) continue
        try {
          await saveMuseTrigger(cfg, { ...triggerToUpsert(t), enabled: false })
        } catch (e) {
          errors.push(`${t.id}: ${errMsg(e)}`)
        }
      }
    })
  }
  // 身份守卫(同 ensure):等待期间墓碑被换人(第二次 disable)或作废(enable)→ 这份结果不许覆盖它。
  if (pendingDisable.get(pluginId) !== st) return
  if (errors.length) Object.assign(st, { at: Date.now(), errors, pending: false })
  else pendingDisable.delete(pluginId) // 关成了 = 没有欠账
}

/** 待停用墓碑的重放:节流同 ensure(≥30s/插件),但**刻意不封顶** —— 与 ensure 语义不对称:
 *  ensure 放弃了插件下次自己还会登记,最坏是「规则没登上」;disable 放弃了则是「用户以为停了、引擎里照跑」,
 *  是数据安全问题,不能靠次数熄火。收敛靠的是:关成了删记录 / 插件被重新启用即作废 / 每插件 30s 节流,
 *  且只在后端 !ok→ok 边沿触发(边沿本身就稀疏)。 */
function replayPendingDisables(): void {
  const now = Date.now()
  for (const [pluginId, st] of Array.from(pendingDisable)) {
    if (st.pending) continue
    if (now - st.lastReplayAt < ENSURE_REPLAY_MIN_GAP_MS) continue // 不看 replays:见上,停用不许因次数熄火
    st.replays += 1
    st.lastReplayAt = now
    void disablePluginRules(pluginId, true).catch((e) => console.warn(`[amadeus] plugin "${pluginId}" 停用规则重放失败`, e))
  }
}

export const usePluginStore = create<PluginState>((set, get) => {
  // 每个插件一份 app API(块表面可吊销);teardown 时按 id 吊销。同 id 重新 enable 会覆盖成新的一份,
  // 旧 facade 已在 teardown 里吊销 → 旧代码持有的引用是哑的。
  const revokers: Record<string, (() => void) | undefined> = {}
  const makeContext = (pluginId: string): PluginContext => {
    revokers[pluginId]?.() // 防守:没经 teardown 就重建 context(setup 抛错后重试)也不留旧订阅
    const { api: appApi, revokeSurface } = makeAppApi(pluginId, () => get().plugins.find((p) => p.id === pluginId)?.name || pluginId)
    // 语言订阅与块表面同一条纪律:插件自己能退订,但**最终责任人是宿主** —— disable/reload/setup 抛错
    // 一律统一收掉(codex 评审 2026-08-14)。
    const localeUnsubs = new Set<() => void>()
    const tanguUnsubs = new Set<() => void>()
    const fontDisposers = new Set<() => void>()
    // 插件仪表盘挂载(ctx.dashboard.mount):与视图表面同一条纪律 —— 插件禁用/重载时宿主统一卸掉,
    // 否则内存作用域的 pageStore 与 React 树在插件死后还活着。
    const dashMounts = new Set<() => void>()
    revokers[pluginId] = () => {
      revokeSurface()
      for (const d of Array.from(dashMounts)) {
        try { d() } catch (e) { console.error(`[amadeus] plugin "${pluginId}" dashboard dispose failed`, e) }
      }
      dashMounts.clear()
      for (const u of Array.from(localeUnsubs)) {
        try { u() } catch (e) { console.error(`[amadeus] plugin "${pluginId}" locale unsubscribe failed`, e) }
      }
      localeUnsubs.clear()
      // ctx.tangu 的订阅同款纪律:禁用后的插件不许还在收模型/Space 变更回调。
      for (const u of Array.from(tanguUnsubs)) {
        try { u() } catch (e) { console.error(`[amadeus] plugin "${pluginId}" tangu unsubscribe failed`, e) }
      }
      tanguUnsubs.clear()
      // 字体同理:插件不调 disposer 也得收干净,否则停用后下拉里还留着选不出效果的死项。
      for (const d of Array.from(fontDisposers)) {
        try { d() } catch (e) { console.error(`[amadeus] plugin "${pluginId}" font dispose failed`, e) }
      }
      fontDisposers.clear()
    }
    return {
    app: appApi,
    registerSlashItem: (item) => set((s) => ({ slashItems: [...s.slashItems, { pluginId, item }] })),
    registerCommand: (command) =>
      set((s) => ({ commands: [...s.commands, { pluginId, item: command }] })),
    registerTheme: (theme) => {
      injectThemeStyle(theme.id, theme.css)
      set((s) => ({ themes: [...s.themes, { pluginId, item: theme }] }))
    },
    // 插件字体(2026-08-28):与内置预设同形,只是 source 不同 → 设置里分到「插件提供」组。
    // id 由宿主加命名空间前缀,插件之间不会撞;远程 URL 直接丢掉(CSP default-src 'self',且要离线可用)。
    registerFont: (font) => {
      const files = (font.files ?? []).filter((f) => {
        const url = String(f?.url ?? '')
        if (/^https?:/i.test(url)) {
          console.warn(`[amadeus] 插件 ${pluginId} 的字体 ${font.id} 用了远程 URL,已忽略:${url}`)
          return false
        }
        return !!url
      })
      const dispose = registerHostFont({
        id: `plugin:${pluginId}:${font.id}`,
        label: font.label,
        slots: font.slots?.length ? font.slots : ['ui', 'body'],
        stack: font.stack,
        source: `plugin:${pluginId}`,
        files,
      })
      const wrapped = (): void => { dispose(); fontDisposers.delete(wrapped) }
      fontDisposers.add(wrapped)
      return wrapped
    },
    registerPanel: (panel) => set((s) => ({ panels: [...s.panels, { pluginId, item: panel }] })),
    // 全局状态栏项(2026-07-23 复活):同 id 重复注册即覆盖;返回 handle 供原位更新(外置插件轮询改 text)。
    // 渲染在 pluginStatusBridge(id 命名空间 plugin:<pluginId>:<id>);teardown 随其余切片整体清理。
    registerStatusItem: (item) => {
      const token = {}
      set((s) => ({
        statusItems: [
          ...s.statusItems.filter((o) => !(o.pluginId === pluginId && o.item.id === item.id)),
          { pluginId, item, token },
        ],
      }))
      return {
        update: (patch: { text?: string; title?: string }) =>
          set((s) => ({
            statusItems: s.statusItems.map((o) => (o.token === token ? { ...o, item: { ...o.item, ...patch } } : o)),
          })),
        dispose: () => set((s) => ({ statusItems: s.statusItems.filter((o) => o.token !== token) })),
      }
    },
    // 右上角通知(2026-07-23 起):来源自动标插件名;事件 plugin:<id>,用户可在设置里按插件静音。
    notify: (message, opts) =>
      notifyApp({
        text: String(message ?? ''),
        level: opts?.level,
        title: opts?.title ? String(opts.title) : undefined,
        sticky: typeof opts?.sticky === 'boolean' ? opts.sticky : undefined,
        event: `plugin:${pluginId}`,
        sourceLabel: get().plugins.find((p) => p.id === pluginId)?.name || pluginId,
      }),
    registerView: (view) => set((s) => ({ views: [...s.views, { pluginId, item: view }] })),
    registerListSource: (src) => set((s) => ({ listSources: [...s.listSources, { pluginId, item: src }] })),
    // 内置后缀不给注册(内置优先是硬规则,见 isBuiltinFileType)。返回 false 让插件知道自己被内置取代了,
    // 可以整体退让 —— 光靠 find* 那道闸拦不住插件继续贡献重复的「新建 X」右键项和斜杠项。
    // 旧宿主返回 undefined(≠ false),插件的 `if (ok === false) return` 判定天然兼容。
    registerFileType: (def) => {
      const exts = Array.isArray(def?.extensions) ? def.extensions : []
      // 形态闸:后缀必须 '.x' 起步;以 '.md' 收尾的必须是复合后缀('.X.md')。裸 '.md'、漏点 'md'、
      // 空串这类声明会让 viewSurface 的 loadPage 后缀闸(endsWith 判定)对**所有笔记**敞开 ——
      // 那道闸防的是「普通 v4/素 md 被拽进 v3 存储管线改写 = 毁档」(评审 P2,2026-08-14)。
      if (!exts.length || !exts.every((e) => isValidPluginExt(String(e ?? '')))) {
        console.warn(`[plugin:${pluginId}] registerFileType(${exts.join(',')}) 被拒:后缀声明不合形态(须 '.x',md 类须复合后缀 '.X.md')`)
        return false
      }
      if (exts.every((e) => isBuiltinFileType(String(e)))) {
        console.warn(`[plugin:${pluginId}] registerFileType(${exts.join(',')}) 被拒:该后缀已由 Forsion 内置文件类型认领`)
        return false
      }
      // fmKeys(属性面板隐藏用)只收非空字符串;amadeus_* 是编译器地盘,插件不许认领。
      const fmKeys = Array.isArray(def?.fmKeys)
        ? def.fmKeys.map((k) => String(k ?? '').trim()).filter((k) => k && !/^amadeus_/.test(k))
        : undefined
      set((s) => ({ fileTypes: [...s.fileTypes, { pluginId, item: fmKeys ? { ...def, fmKeys } : def }] }))
      return true
    },
    registerEmbedRenderer: (def) =>
      set((s) => ({ embedRenderers: [...s.embedRenderers, { pluginId, item: def }] })),
    registerFileCreator: (def) =>
      set((s) => ({ fileCreators: [...s.fileCreators, { pluginId, item: def }] })),
    // 打开自己的视图:类型名由宿主统一命名空间(plugin:<id>:<viewId>),防跨插件顶替。
    openView: (viewId, opts) => get().viewOpener?.(`plugin:${pluginId}:${viewId}`, opts?.location),
    // 宿主 UI 当前语言(2026-08-14 起):插件自带双语词表,用它挑。只报变化,初值走 getLocale()。
    getLocale: () => currentLocale(),
    subscribeLocale: (cb) => {
      const off = subscribeLocale(cb)
      const wrapped = () => { off(); localeUnsubs.delete(wrapped) }
      localeUnsubs.add(wrapped)
      return wrapped
    },
    // 同 key 重注册即覆盖:宿主自动注册的标准行(如 workFolder)插件可用自己的定义顶掉。
    registerSetting: (def) =>
      set((s) => ({ settings: [...s.settings.filter((o) => !(o.pluginId === pluginId && o.item.key === def.key)), { pluginId, item: def }] })),
    // 自绘设置面板(Obsidian PluginSettingTab 的对位):同 id 重注册即覆盖,渲染在详情页声明式表单下方。
    registerSettingsView: (def) => {
      if (!def?.id || typeof def.mount !== 'function') {
        console.warn(`[plugin:${pluginId}] registerSettingsView 需要 { id, mount }`)
        return
      }
      set((s) => ({
        settingsViews: [
          ...s.settingsViews.filter((o) => !(o.pluginId === pluginId && o.item.id === def.id)),
          { pluginId, item: def },
        ],
      }))
    },
    // 编辑器扩展:注册表在 editorExtensions.ts(叶子模块,破 store↔MarkdownBlock 的 import 环)。
    registerEditorExtension: (factory, opts) => addEditorExtension(pluginId, factory, opts),
    // 插件私有 JSON blob(~/.forsion/plugins-data/<id>.json)。宿主缺位 → 读 null / 写 no-op,
    // 插件侧一律 `await ctx.loadData?.() ?? 默认值`。坏 JSON 当没写过(用户手改文件改坏了不该让插件起不来)。
    loadData: async () => {
      // ⚠️`amadeus?.readPluginData?.(id).catch(…)` 是错的:方法缺席时 `?.()` 求值成 undefined,
      //   紧跟着的 `.catch` 就是在 undefined 上取属性 → 同步 TypeError。非桌面宿主必炸。
      const raw = await Promise.resolve(amadeus?.readPluginData?.(pluginId)).catch(() => null)
      if (raw == null) return null
      try {
        return JSON.parse(raw)
      } catch (e) {
        console.error(`[amadeus] 插件 ${pluginId} 的数据文件不是合法 JSON,已当作空`, e)
        return null
      }
    },
    saveData: async (value) => {
      if (!amadeus?.writePluginData) return
      await amadeus.writePluginData(pluginId, JSON.stringify(value ?? null))
    },
    // Dashboard 配方编译:纯函数,格式(围栏/frontmatter 词表)留在宿主 —— 插件手抄格式
    // 就是没版本契约的公开 API(接缝评审 P8)。写盘/打开由插件走既有 ctx.app 面。
    dashboard: {
      source: (recipe, sourceOpts) => compileDashboardRecipe(recipe, { existingFileText: sourceOpts?.existingFileText }),
      // 不依赖笔记库的原生仪表盘挂载。动态 import:dashboardSurface → views/DashboardGridView → …→
      // amadeusNav → 本文件,静态引就是环(openFile 同款破法)。返回的卸载函数同步可用,
      // 挂载还在飞时调用 = 取消。
      mount: (el, o) => {
        let disposeMounted: (() => void) | null = null
        let cancelled = false
        const dispose = (): void => {
          cancelled = true
          dashMounts.delete(dispose)
          disposeMounted?.()
          disposeMounted = null
        }
        dashMounts.add(dispose)
        void import('./dashboardSurface').then((m) => {
          if (cancelled || !el.isConnected) { dashMounts.delete(dispose); return }
          disposeMounted = m.mountPluginDashboard(pluginId, el, o).dispose
        }).catch((e) => { console.error(`[amadeus] plugin "${pluginId}" dashboard mount failed`, e) })
        return dispose
      },
    },
    registerPropertyType: (def) => {
      registerPropType(def)
      set((s) => ({ propertyTypes: [...s.propertyTypes, { pluginId, item: def }] }))
    },
    // 成就:注册/计数都在 achievements/store 内强制 plugin:<id>: 前缀(防撞官方 id/伪造官方计数)。
    achievements: {
      registerSeries: (def) => registerPluginSeries(pluginId, def),
      track: (event, n) => track(`plugin:${pluginId}:${event}`, n),
    },
    // 活动日志:同款前缀纪律(插件伪造不了官方事件);拼行/消毒在 main 侧 activityLog.ts。
    activity: {
      log: (event, detail) => act(`plugin:${pluginId}:${event}`, detail),
    },
    // 自动化播种:**探针给得出后端配置的宿主才注入**(闸看 waitBackend 在不在,不看 readTangu() 本身:
    // 台架假探针 / 旧宿主没有这条 = 与非 Tangu 宿主同口径,ctx.automation 整个不存在)。
    // 前缀纪律同 achievements/activity:id 在宿主拼,插件只给 key(见 pluginAutomation.ts)。
    ...(readTangu()?.waitBackend
      ? {
          automation: {
            ensure: (rules: PluginAutomationRule[]) => ensurePluginAutomation(pluginId, rules),
          },
        }
      : {}),
    // 日历成员登记:只依赖 pageStore 的 vault,不需要探针闸。已是成员 no-op(不覆盖用户改过的列映射);
    // 库还没恢复就等它恢复(与 ensure 同一个 60s 窗口),同步返回 void。
    calendar: {
      ensureMember: (dbPath: string, dateColId: string, checkboxColId?: string) => {
        const p = normalizeVaultRel(dbPath)
        const dateCol = String(dateColId || '').trim()
        if (!p || !dateCol) return
        const apply = (vault: string): void => {
          const cal = useCalendarConfig.getState()
          if (memberOf(vault, cal.byVault, p)) return
          cal.addMember(vault, p, dateCol, String(checkboxColId || '').trim() || undefined)
        }
        const now = usePageStore.getState().vaultRoot
        if (now) apply(now)
        else void waitVaultRoot(ENSURE_WAIT_MS).then((v) => { if (v) apply(v) })
      },
    },
    // Tangu 只读探针:**探针装了才注入**(纯 Amadeus 壳 / unit 设备页上 ctx.tangu 整个不存在,
    // 插件据此判断宿主形态)。不是权限闸 —— 模型名不敏感,不进 manifest capabilities 白名单。
    ...(readTangu()
      ? {
          tangu: {
            activeModel: () => readTangu()?.activeModel() ?? null,
            models: () => readTangu()?.models() ?? [],
            activeSpace: () => readTangu()?.activeSpace() ?? null,
            session: () => readTangu()?.session?.() ?? null,
            subscribe: (cb: () => void) => {
              const off = readTangu()?.subscribe(cb) ?? (() => {})
              const wrapped = (): void => { off(); tanguUnsubs.delete(wrapped) }
              tanguUnsubs.add(wrapped)
              return wrapped
            },
          },
        }
      : {}),
    // 前台窗口采样:**manifest 声明过才注入**(没声明的插件连 ctx.system 都看不到)。
    // 第二道闸在主进程:config.activeWindowEnabled 默认关,关着时下面这个调用恒回 null。
    ...(get().plugins.find((p) => p.id === pluginId)?.capabilities?.includes('activeWindow')
      ? {
          system: {
            activeWindow: async () => {
              try {
                return (await window.tangu?.activeWindow?.()) ?? null
              } catch {
                return null
              }
            },
          },
        }
      : {}),
    }
  }

  /** Run disposer + drop contributions + mark inactive, WITHOUT touching the preference. */
  const teardown = (id: string): void => {
    try {
      get().disposers[id]?.()
    } catch (e) {
      console.error(`[amadeus] plugin "${id}" dispose failed`, e)
    }
    // 块表面的订阅与 React root 不在插件自己的 disposer 里(插件可能压根没写),宿主统一收 ——
    // 收完该插件的 API 整体变哑,它在飞的异步任务改不动用户文件了(codex)。
    try {
      revokers[id]?.()
    } catch (e) {
      console.error(`[amadeus] plugin "${id}" block-surface revoke failed`, e)
    }
    revokers[id] = undefined
    // 视图级表面同一条纪律:同步吊销,别等 React 的 effect cleanup(那是下一拍的事)。
    for (const fn of Array.from(viewTeardowns.get(id) ?? [])) {
      try { fn() } catch (e) { console.error(`[amadeus] plugin "${id}" view-surface revoke failed`, e) }
    }
    viewTeardowns.delete(id)
    for (const o of get().themes) if (o.pluginId === id) removeThemeStyle(o.item.id)
    for (const o of get().propertyTypes) if (o.pluginId === id) unregisterPropType(o.item.type)
    unregisterPluginAchievements(id)
    lastEnsure.delete(id) // 旧规则集不随重新启用被重放;再启用时插件自己 setup 里会重新 ensure
    clearEditorExtensions(id) // 代次 +1 → 已建好的编辑器重建,当场摘掉这个插件的 PM 插件
    set((s) => ({
      activeIds: s.activeIds.filter((x) => x !== id),
      slashItems: s.slashItems.filter((o) => o.pluginId !== id),
      commands: s.commands.filter((o) => o.pluginId !== id),
      themes: s.themes.filter((o) => o.pluginId !== id),
      panels: s.panels.filter((o) => o.pluginId !== id),
      statusItems: s.statusItems.filter((o) => o.pluginId !== id),
      propertyTypes: s.propertyTypes.filter((o) => o.pluginId !== id),
      settings: s.settings.filter((o) => o.pluginId !== id),
      settingsViews: s.settingsViews.filter((o) => o.pluginId !== id),
      views: s.views.filter((o) => o.pluginId !== id),
      listSources: s.listSources.filter((o) => o.pluginId !== id),
      fileTypes: s.fileTypes.filter((o) => o.pluginId !== id),
      embedRenderers: s.embedRenderers.filter((o) => o.pluginId !== id),
      fileCreators: s.fileCreators.filter((o) => o.pluginId !== id),
      disposers: { ...s.disposers, [id]: undefined },
    }))
  }

  const applyPref = (id: string): void => {
    if (!get().disabledIds.includes(id)) get().enable(id)
  }

  return {
    plugins: [],
    disabledIds: [],
    activeIds: [],
    slashItems: [],
    commands: [],
    themes: [],
    panels: [],
    statusItems: [],
    propertyTypes: [],
    settings: [],
    settingsViews: [],
    views: [],
    listSources: [],
    fileTypes: [],
    embedRenderers: [],
    fileCreators: [],
    viewOpener: null,
    setViewOpener: (fn) => set({ viewOpener: fn }),
    disposers: {},
    initialized: false,

    isActive: (id) => get().activeIds.includes(id),

    init(plugins = BUILTIN_PLUGINS) {
      if (get().initialized) return
      set({ plugins: [...plugins], disabledIds: readDisabled(), initialized: true })
      for (const p of plugins) applyPref(p.id)
    },

    enable(id) {
      if (get().activeIds.includes(id)) return
      const plugin = get().plugins.find((p) => p.id === id)
      if (!plugin) return
      if (plugin.blocked) return // 门禁挡下的插件(apiVersion/minAppVersion 不符)任何路径都不得激活
      // 注:DISABLED_KEY 是按 id 的单一全局列表;listPlugins 已按 vault 优先去重,每 id 只有一实例,一位开关即正确。
      // 标准设置行:每个插件自动获得「工作文件夹」(ctx.app.workFolder() 的数据源;
      // 插件在 setup 里自注册同 key 会覆盖本行,见 registerSetting 的去重)。teardown/失败清理按 pluginId 一并收走。
      set((s) => ({
        settings: [...s.settings, { pluginId: id, item: workFolderSetting(plugin.name, id) }],
      }))
      let dispose: (() => void) | undefined
      try {
        const r = plugin.setup(makeContext(id))
        if (typeof r === 'function') dispose = r
      } catch (e) {
        console.error(`[amadeus] plugin "${id}" setup failed`, e)
        useUiStore.getState().notify(translate('pluginhost.setupFailed', { name: plugin.name }))
        // 抛错前它可能已经订了块表面/语言 —— 这条分支原来漏收(codex 评审 2026-08-14),补上。
        try { revokers[id]?.() } catch (err) { console.error(`[amadeus] plugin "${id}" revoke failed`, err) }
        revokers[id] = undefined
        // setup 抛错前可能已注册了主题/成就/属性类型 —— 三者都有 store 外的副作用(注入的 <style>、成就注册表),
        // 只 filter zustand 状态会留下孤儿(禁用的插件主题仍挂在 head 上)。与 teardown 同口径全清。
        for (const o of get().propertyTypes) if (o.pluginId === id) unregisterPropType(o.item.type)
        for (const o of get().themes) if (o.pluginId === id) removeThemeStyle(o.item.id)
        unregisterPluginAchievements(id)
        lastEnsure.delete(id) // 抛错前可能已调过 ensure:没激活的插件不该留着一条等重放的记录
        set((s) => ({
          slashItems: s.slashItems.filter((o) => o.pluginId !== id),
          commands: s.commands.filter((o) => o.pluginId !== id),
          themes: s.themes.filter((o) => o.pluginId !== id),
          panels: s.panels.filter((o) => o.pluginId !== id),
          statusItems: s.statusItems.filter((o) => o.pluginId !== id),
          propertyTypes: s.propertyTypes.filter((o) => o.pluginId !== id),
          settings: s.settings.filter((o) => o.pluginId !== id),
      settingsViews: s.settingsViews.filter((o) => o.pluginId !== id),
          views: s.views.filter((o) => o.pluginId !== id),
      listSources: s.listSources.filter((o) => o.pluginId !== id),
          fileTypes: s.fileTypes.filter((o) => o.pluginId !== id),
          embedRenderers: s.embedRenderers.filter((o) => o.pluginId !== id),
          fileCreators: s.fileCreators.filter((o) => o.pluginId !== id),
        }))
        return
      }
      set((s) => ({
        activeIds: [...s.activeIds, id],
        disabledIds: s.disabledIds.filter((x) => x !== id),
        disposers: { ...s.disposers, [id]: dispose },
      }))
      writeDisabled(get().disabledIds)
      // 上一轮禁用留下的「待停用」欠账作废:用户刚把插件打开,再让边沿去关它的规则就是倒着走。
      // ⚠️放在成功路末尾(activeIds 已 set):setup 抛错那条路插件并没激活,墓碑该留着继续重试。
      pendingDisable.delete(id)
    },

    disable(id) {
      if (!get().activeIds.includes(id)) return
      teardown(id)
      set((s) => ({ disabledIds: s.disabledIds.includes(id) ? s.disabledIds : [...s.disabledIds, id] }))
      writeDisabled(get().disabledIds)
      // 用户明确禁用 → 它种下的自动化规则一并停(只此一条路;非 Tangu 宿主没有探针就没有规则可关)。
      if (readTangu()?.waitBackend) {
        void disablePluginRules(id).catch((e) => console.warn(`[amadeus] plugin "${id}" 停用自动化规则失败`, e))
      }
    },

    toggle(id) {
      if (get().activeIds.includes(id)) get().disable(id)
      else get().enable(id)
    },

    async loadExternal() {
      let sources: ExternalPluginSource[] = []
      try {
        sources = await resolveExternalSources()
      } catch {
        return
      }
      const externals = sources.map(toPlugin)
      set((s) => ({ plugins: [...s.plugins.filter((p) => p.builtin), ...externals] }))
      for (const p of externals) applyPref(p.id)
    },

    async reloadExternal() {
      for (const p of get().plugins) if (!p.builtin && get().activeIds.includes(p.id)) teardown(p.id)
      set((s) => ({ plugins: s.plugins.filter((p) => p.builtin) }))
      await get().loadExternal()
    },

    openPluginsFolder() {
      void amadeus.openPluginsFolder()
    },

    async scaffoldSample() {
      try {
        await amadeus.scaffoldSamplePlugin()
      } catch (e) {
        useUiStore.getState().notify(String(e))
        return
      }
      await get().reloadExternal()
      useUiStore.getState().notify(translate('pluginhost.sampleCreated'))
    },
  }
})

// 切语言时重刷宿主自动塞的「工作文件夹」设置行:它的文案是 enable() 那一刻求值的,不重刷就会
// 停在启用时的语言(插件多半在冷启动就全部启用了,用户之后再切语言这一行永远追不上)。
// 只动**宿主自己造的**那些行(WeakSet 认对象身份),插件用同 key 顶掉的行原样不碰;
// 一行都没有就不 setState,免得白白弹一次订阅者。
subscribeLocale(() => {
  const rows = usePluginStore.getState().settings
  if (!rows.some((o) => autoWorkFolderRows.has(o.item))) return
  usePluginStore.setState({
    settings: rows.map((o) => (autoWorkFolderRows.has(o.item) ? { ...o, item: relabelWorkFolder(o.item) } : o)),
  })
})

// ── 文件类型 / 嵌入渲染的匹配助手（供 amadeusNav、文件树、BlockHost、通用文件视图共用）。
// 组件要响应「插件加载后才注册」须自行订阅 usePluginStore((s) => s.fileTypes / s.embedRenderers) 再调 find*;
// 非响应式调用(nav 路由、视图挂载那一刻)用下面读快照的 match*。

/** 在给定 fileTypes 列表里按路径后缀找命中的文件类型贡献(纯函数,便于组件订阅列表后调用)。
 *  内置文件类型的后缀一律不放行(生态硬规则,见 isBuiltinFileType):遮蔽内置 = 用户打不开内置视图。 */
export function findFileType(
  list: { item: FileTypeContribution }[],
  path: string,
): FileTypeContribution | undefined {
  if (isBuiltinFileType(path)) return undefined
  const n = path.toLowerCase()
  return list.find((o) => o.item.extensions.some((ext) => n.endsWith(ext.toLowerCase())))?.item
}

/** 当前已注册文件类型里匹配 path 的那个(读快照,非响应式)。 */
export function matchFileType(path: string): FileTypeContribution | undefined {
  return findFileType(usePluginStore.getState().fileTypes, path)
}

/** 文件名去掉命中的文件类型后缀(如 `思维导图.mindmap.md` + ['.mindmap.md'] → `思维导图`);兜底剥最后一段扩展名。 */
export function fileTypeBaseName(path: string, extensions: string[]): string {
  const name = path.split(/[\\/]/).pop() || path
  const lower = name.toLowerCase()
  const ext = extensions.find((e) => lower.endsWith(e.toLowerCase()))
  return ext ? name.slice(0, name.length - ext.length) : name.replace(/\.[^.]+$/, '')
}

/** 在给定 embedRenderers 列表里找声称能渲染该 `![[target]]` 的渲染器(match 抛错视为不匹配)。 */
export function findEmbedRenderer(
  list: { item: EmbedRendererContribution }[],
  target: string,
): EmbedRendererContribution | undefined {
  // 内置类型的嵌入由内置渲染,插件 match() 说了不算(同 findFileType)。**别名/宽度也要剥**:
  // BlockHost 会先拿完整 target 问一次 matcher(`|`/`#` 可能是真文件名的一部分),
  // `![[图.mindmap.md|300]]` 原样比后缀是不命中的 —— 不剥这一下插件就从别名语法绕过了这道闸(Codex)。
  if (isBuiltinFileType(target) || isBuiltinFileType(target.split('|')[0].trim())) return undefined
  return list.find((o) => {
    try {
      return o.item.match(target)
    } catch {
      return false
    }
  })?.item
}

/** 当前已注册嵌入渲染器里匹配 target 的那个(读快照,非响应式)。 */
export function matchEmbedRenderer(target: string): EmbedRendererContribution | undefined {
  return findEmbedRenderer(usePluginStore.getState().embedRenderers, target)
}

/** 已启用插件声明的自动化事件(manifest `events`),完整名带 `plugin:<id>:` 前缀——自动化构建器事件目录用(读快照)。 */
export function listPluginAutomationEvents(): { name: string; label?: string }[] {
  const s = usePluginStore.getState()
  const disabled = new Set(s.disabledIds)
  const out: { name: string; label?: string }[] = []
  for (const p of s.plugins) {
    if (disabled.has(p.id) || p.blocked || !p.events?.length) continue
    for (const ev of p.events) out.push({ name: `plugin:${p.id}:${ev.name}`, label: ev.label })
  }
  return out
}
