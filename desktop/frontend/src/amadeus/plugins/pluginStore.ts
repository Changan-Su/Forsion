// The plugin host. Holds the plugin registry, the persisted "disabled" preference, the
// runtime active set, and the live contribution registries (slash items / commands /
// themes) that the UI subscribes to. Built-in plugins are registered on init(); external
// (Forsion) plugins are discovered from ~/.forsion/plugins/ and evaluated here.
//
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
import { currentLocale, subscribeLocale } from '../../i18n'
import { AUTO_WORK_FOLDER_KEY } from './display'
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
} from './types'
import { gatePluginManifest, type ExternalPluginSource } from '@amadeus-shared/ipc'

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
    builtin: false,
    apiVersion: src.apiVersion,
    minAppVersion: src.minAppVersion,
    requiresApp: src.requiresApp,
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
    revokers[pluginId] = () => {
      revokeSurface()
      for (const u of Array.from(localeUnsubs)) {
        try { u() } catch (e) { console.error(`[amadeus] plugin "${pluginId}" locale unsubscribe failed`, e) }
      }
      localeUnsubs.clear()
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
        settings: [...s.settings, { pluginId: id, item: {
          key: AUTO_WORK_FOLDER_KEY, label: '工作文件夹', type: 'text' as const,
          default: sanitizeFolderName(plugin.name, id),
          description: '本插件在笔记库内读写文件的文件夹(相对库根;留空恢复默认=插件名)',
        } }],
      }))
      let dispose: (() => void) | undefined
      try {
        const r = plugin.setup(makeContext(id))
        if (typeof r === 'function') dispose = r
      } catch (e) {
        console.error(`[amadeus] plugin "${id}" setup failed`, e)
        useUiStore.getState().notify(`插件「${plugin.name}」加载失败`)
        // 抛错前它可能已经订了块表面/语言 —— 这条分支原来漏收(codex 评审 2026-08-14),补上。
        try { revokers[id]?.() } catch (err) { console.error(`[amadeus] plugin "${id}" revoke failed`, err) }
        revokers[id] = undefined
        // setup 抛错前可能已注册了主题/成就/属性类型 —— 三者都有 store 外的副作用(注入的 <style>、成就注册表),
        // 只 filter zustand 状态会留下孤儿(禁用的插件主题仍挂在 head 上)。与 teardown 同口径全清。
        for (const o of get().propertyTypes) if (o.pluginId === id) unregisterPropType(o.item.type)
        for (const o of get().themes) if (o.pluginId === id) removeThemeStyle(o.item.id)
        unregisterPluginAchievements(id)
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
    },

    disable(id) {
      if (!get().activeIds.includes(id)) return
      teardown(id)
      set((s) => ({ disabledIds: s.disabledIds.includes(id) ? s.disabledIds : [...s.disabledIds, id] }))
      writeDisabled(get().disabledIds)
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
      useUiStore.getState().notify('已创建示例插件 hello-amadeus')
    },
  }
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
