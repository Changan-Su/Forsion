// The plugin host. Holds the plugin registry, the persisted "disabled" preference, the
// runtime active set, and the live contribution registries (slash items / commands /
// themes) that the UI subscribes to. Built-in plugins are registered on init(); external
// (Forsion) plugins are discovered from ~/.forsion/plugins/ and evaluated here.
//
import { registerFont as registerHostFont } from '../../fontPresets'
import { registerAppearance, clearPluginAppearance, useAppearance } from '../../appearance/store'

// Trust model: external plugins run with the curated `ctx.app` API (and, like Obsidian,
// full renderer scope). Only install plugins you trust.

import { create } from 'zustand'
import { toAssetUrl } from '@amadeus-shared/assets'
import { pluginHostPath } from './hostPaths'
import { pluginRequestPath, type PluginRequestOptions } from './engineRequest'
import { request as engineJsonRequest } from '../../services/backendService'

/** window.tangu,在没有 window 的环境(vitest node 环境、云端 worker)返回 undefined 而不是抛 ReferenceError。 */
const hostTangu = (): typeof window.tangu => (typeof window !== 'undefined' ? window.tangu : undefined)
/** 这个宿主有没有「自动化规则」这回事:探针给得出后端配置,且宿主没有声明「这里没有本机引擎」。
 *  规则存在引擎的本机档案里(/agent/special/* 只在 hostExec 的引擎上有),手机接的是云端引擎 —— 那边一律答 404。
 *  闸看宿主的**静态声明**(executionCapabilities.host === false),不看 hostExecution():后者在桌面要等配置
 *  读回来才准,插件 setup 时往往还没到。桌面主进程不声明这一项 = 照旧注入。 */
const automationHost = (): boolean => !!readTangu()?.waitBackend && hostTangu()?.executionCapabilities?.host !== false
import { noteOf, usePageStore } from '../store/pageStore'
import { useUiStore } from '../store/uiStore'
import { setTheme as applyAccent, toggleMode } from '../theme/ThemeManager'
import { amadeus } from '../api'
import { BUILTIN_PLUGINS } from './builtins'
import { getPropertyType, registerPropertyType as registerPropType, unregisterPropertyType as unregisterPropType } from '../blocks/database/propertyTypes'
import { isBuiltinFileType, isOverridableBuiltinType, OVERRIDABLE_BUILTIN_SUFFIXES } from '@amadeus-shared/builtinTypes'
import { isHostPath } from '@amadeus-shared/pdfLink'
import { claimHostMount, createBlockSurface, mountHostReact } from './blockSurface'
import { addEditorExtension, clearEditorExtensions } from './editorExtensions'
import { registerPluginSeries, track, unregisterPluginAchievements } from '../../achievements/store'
import { act } from '../../activity/log'
import { notifyApp } from '../../stores/notificationStore'
import { panelToast } from '../../components/PanelNotice'
import { currentLocale, registerMessages, subscribeLocale, translate } from '../../i18n'
import { idleAgentStatus, readTangu, type TanguAgentStatus, type TanguStartChatResult } from './tanguSeam'
import { registerDeskCompanion, revokeDeskCompanions, type DeskCompanionContribution, type DeskCompanionHandle } from './deskCompanion'
// ctx.desk 的宿主闸:端判定单源(currentPlatform)+ UI 模式(叶子模块,不经 @lcl/engine barrel)。
import { currentPlatform } from '../../services/agentRunService'
import { UI_MODE } from '@lcl/engine/uiMode'
import { AUTO_WORK_FOLDER_KEY } from './display'
// 自动化播种 / 禁用即关规则:backendService 依赖图干净(http / agentRunService / localInbox,均不引 appStore),
// 可静态 import;cfg 必须经 tanguSeam 探针的 waitBackend 拿(appStore 与本模块有 import 环)。
import { getMuseTriggers, listPlugins, saveMuseTrigger, setPluginEnabled } from '../../services/backendService'
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
  StoreViewContribution,
  ReadinessContribution,
  SlashContribution,
  SelectionActionContribution,
  StatusItemContribution,
  ThemeContribution,
  ViewContribution,
  ListSourceContribution,
  PluginAutomationRule,
  TableSpec,
  PluginViewLocation,
} from './types'
import { validateTableSpec } from './tableSpec'
import { clearDevRecords, devConsoleFor, dropDevRecords } from './devRecords'
import { gatePluginManifest, type ExternalPluginSource } from '@amadeus-shared/ipc'
import { createEffectScope, type EffectRecord, type EffectScope } from './effectScope'
import { dependentsOf, topoOrder, unmetDependencies, type UnmetDependency } from './pluginDeps'
import { windowKind } from '../../windowKind'
import { compileDashboardRecipe } from '@amadeus-shared/dashboardRecipe'
import { openWebFloatingPanel } from '../../pluginPanelSeam'
import { connectionTarget } from '../../services/engine/targets'

// 宿主自己产出的用户可见文案(插件贡献的文案由插件自己带双语,见 display.ts 的语言解析单点)。
// 命名空间 `pluginhost.*` 是本文件专属,别处不要复用。
registerMessages({
  'pluginhost.workFolder.label': { zh: '工作文件夹', en: 'Working folder' },
  'pluginhost.workFolder.desc': {
    zh: '本插件在智库内读写文件的文件夹（相对库根；留空恢复默认=插件名）',
    en: 'Folder inside the vault where this plugin reads and writes files (relative to the vault root; leave empty to fall back to the plugin name)',
  },
  'pluginhost.setupFailed': { zh: '插件「{name}」加载失败', en: 'Plugin "{name}" failed to load' },
  'pluginhost.sampleCreated': { zh: '已创建示例插件 hello-amadeus', en: 'Created the sample plugin hello-amadeus' },
})

const DISABLED_KEY = 'amadeus.plugins.disabled'
/** 「用户在某个窗口明确打开了 X」的一次性戳,写在偏好之前。别的窗口收到 → 清本窗记着的加载失败(重开 = 重试;
 *  偏好没变、或关了马上又开被合并成没变时也照样到达);主窗再记下欠它内嵌引擎插件的 true。 */
export const PLUGIN_ENABLE_STAMP_KEY = 'amadeus.plugins.enableStamp'
/** 主窗欠这些捆绑包内嵌引擎插件一个 true:宿主自己关掉的(父插件被关 / 在等前置),或用户明确开了捆绑包。
 *  父插件跑起来时**只**补开这些 —— 用户在别处(TUI / CLI)关掉的不在里面,不会被翻回来(Codex 10-02)。只主窗读写。 */
const OWED_KEY = 'amadeus.plugins.bundleEngineOwed'

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
    const { APP_VERSION } = await import('../../changelog')
    // CHANGELOG 顶部允许是 `Unreleased`，兼容门禁只能消费已解析的正式版本。
    // Unit meta 与实际运行包同源，优先采用；桥缺位时才回退 CHANGELOG 真源。
    const myVersion = await window.tangu?.appVersion?.().catch(() => null) || APP_VERSION || '0.0.0'
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
  /** 选区工具栏「AI ▾」里的插件项(G3-07);结果一律走宿主预览确认。 */
  selectionActions: Owned<SelectionActionContribution>[]
  commands: Owned<CommandContribution>[]
  themes: Owned<ThemeContribution>[]
  panels: Owned<PanelContribution>[]
  statusItems: Owned<StatusItemContribution>[]
  propertyTypes: Owned<PropertyTypeContribution>[]
  settings: Owned<SettingContribution>[]
  settingsViews: Owned<SettingsViewContribution>[]
  /** 商店左栏里由插件提供的页(ctx.registerStoreView)。 */
  storeViews: Owned<StoreViewContribution>[]
  /** 插件自报的就绪检查(manifest onboarding.requires 的 check 那类)。 */
  readiness: Owned<ReadinessContribution>[]
  views: Owned<ViewContribution>[]
  listSources: Owned<ListSourceContribution>[]
  fileTypes: Owned<FileTypeContribution>[]
  embedRenderers: Owned<EmbedRendererContribution>[]
  fileCreators: Owned<FileCreatorContribution>[]
  /** 宿主注入的视图打开器(桌面壳=workspace.openView);无工作台的宿主保持 null,ctx.openView 即 no-op。 */
  viewOpener: ((type: string, loc?: PluginViewLocation) => void) | null
  /** 打开器真能停靠的位置(经 ctx.viewLocations 给插件做 feature-detect);没有打开器 = null。 */
  viewLocations: readonly PluginViewLocation[] | null
  setViewOpener(fn: ((type: string, loc?: PluginViewLocation) => void) | null, locations?: readonly PluginViewLocation[]): void
  /** 宿主注入的关 / 换视图(桌面壳 = 引擎的 closeViewsOfType / replaceViewsOfType);没有工作台的宿主保持 null。 */
  viewControls: { close(type: string): void; replace(from: string, to: string, params?: Record<string, unknown>): number } | null
  setViewControls(controls: PluginState['viewControls']): void
  disposers: Record<string, (() => void) | undefined>
  initialized: boolean
  /** 注册并按偏好启用一组插件;缺省 = 全部 builtins(独立版);桌面壳传自己的选择性子集。 */
  init(plugins?: AmadeusPlugin[]): void
  enable(id: string): void
  disable(id: string): void
  toggle(id: string): void
  /** Reconcile another window's persisted preference without replaying user-side automation effects. */
  syncDisabledPreferences(): void
  isActive(id: string): boolean
  loadExternal(): Promise<void>
  reloadExternal(): Promise<void>
  /** 只重载一个外置插件(拆它一个、重读来源、装回它一个);别的插件与它们开着的标签页不动。
   *  Agent 自建 Space 每个周期都可能变,走 reloadExternal 会把所有插件拆装一遍(codex 09-11 勘察)。 */
  /** force = 跳过「源码没变就不拆装」的快路(开发态显式重载用:setup 因瞬时原因抛过错时要能重试,只改了 manifest 的
   *  name / capabilities / events 时旧实例也得换掉)。strict = 来源列表读不出来时**不许装作成功**:当前若是开发副本就先拆掉
   *  (撤权优先于一切 —— 授权已经撤了而实例还握着笔记库权限,界面却报「已卸载」,这是最坏的组合),再把错误抛给调用方。 */
  reloadOne(id: string, opts?: { force?: boolean; strict?: boolean }): Promise<void>
  /** 最近一次 setup 抛错的信息(按插件 id;成功激活即清)。Agent 自建 Space 的加载失败靠它回写给 agent。 */
  lastSetupError: Record<string, string>
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
/** 插件经 ctx.app 写盘**落定之后**作废清单缓存(两种都清:writeFile / writeBytes 也能写 .md)。
 *  必须在写完之后清:写之前清的话,写的途中进来的 listFiles 会把写前清单再缓存 1.5s ——
 *  Live3D 导入完立刻重扫,拿到的正是拷贝前的清单,新模型不显示(2026-09-19 评审)。 */
const dropListCache = (): void => {
  listCache.files = undefined
  listCache.pages = undefined
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
/** ctx.app.showResetCardCeremony 的落点:应用层(bootstrapEngine)登记。不走窗口事件 —— 插件与宿主同一个渲染进程,
 *  公开事件谁都能派发,首方判断就被绕过了(Codex 评审 P1)。 */
type ResetCardCeremonyArg = Parameters<NonNullable<PluginAppApi['showResetCardCeremony']>>[0]
let resetCardCeremonyHandler: ((r: ResetCardCeremonyArg) => void) | null = null
export function setResetCardCeremonyHandler(fn: ((r: ResetCardCeremonyArg) => void) | null): void { resetCardCeremonyHandler = fn }

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
    loadPage: (p) => {
      if (!ok()) return
      if (!isPagePipelinePath(String(p ?? ''))) {
        console.warn(`[plugin:${pluginId}] ctx.app.loadPage(${String(p)}) 被拒:只有 .md 笔记能进笔记管线(二进制文件用 readBytes / writeBytes)`)
        return
      }
      void usePageStore.getState().loadPage(p)
    },
    createPage: () => { if (ok()) void usePageStore.getState().createPage() },
    toggleMode: () => void toggleMode(),
    setTheme: (t) => applyAccent(t),
    openSearch: () => useUiStore.getState().setPalette('search'),
    // 插件层不依赖应用层 store:发窗口事件,应用层(bootstrapEngine)接住转给 openSettings
    openSettings: (target) => { if (ok() && typeof target === 'string' && target) window.dispatchEvent(new CustomEvent('forsion:open-settings', { detail: target })) },
    // 应用层登记的处理函数弹用卡动画。只认首方内置包,别的插件不能拿假数字弹「额度已恢复」
    showResetCardCeremony: (result) => {
      if (!ok() || !result || typeof result !== 'object') return
      if (!usePluginStore.getState().plugins.find((p) => p.id === pluginId)?.locked) return
      resetCardCeremonyHandler?.(result)
    },
    openSwitcher: () => useUiStore.getState().setPalette('switch'),
    ...surface.api, // 真块表面(mountBlocks/getPage/…):内置与外置插件同一份能力,见 blockSurface.tsx
    notify: (m) => useUiStore.getState().notify(m),
    readFile: (p) => amadeus.readTextFile(p),
    assetUrl: (p) => toAssetUrl(p),
    hostPath: (p) => pluginHostPath(usePageStore.getState().vaultRoot, p, { executionCapabilities: { host: readTangu()?.hostExecution?.() ?? hostTangu()?.executionCapabilities?.host ?? false } }),
    // 插件契约是 Promise<void>:不带 base 的写宿主本就只回 void,这里显式抹平(CAS 结果类型不外泄给插件)。
    writeFile: (p, text) => (ok() ? amadeus.writeTextFile(p, text).then(() => {}).finally(dropListCache) : Promise.resolve()),
    // 二进制读写(2026-09-19):路径口径与 writeFile 相同 —— 原样透传,越界由主进程 resolveInVault 钳死。
    // 桥缺席时整条方法不挂(同 watchFile 纪律)。⚠️saveVaultBytes 不记自写账本:同路径 watchFile 会收到回声。
    ...(amadeus?.saveVaultBytes
      ? {
          writeBytes: (p: string, b: Uint8Array | ArrayBuffer): Promise<void> => {
            if (!ok()) return Promise.resolve()
            // 任何 TypedArray / DataView 按字节视图取(new Uint8Array(float32Arr) 会逐元素截断成 0-255,静默写坏);
            // 既不是视图也不是 ArrayBuffer(传了字符串之类)→ 拒,别写出一个 0 字节文件。
            const view = ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
              : b instanceof ArrayBuffer ? new Uint8Array(b) : null
            if (!view) return Promise.reject(new TypeError('writeBytes expects a Uint8Array or ArrayBuffer'))
            // 子视图(subarray)过 IPC 会把**整块**底层 buffer 结构化克隆过去 → 只拷自己那一段。
            return amadeus.saveVaultBytes(p, view.byteLength === view.buffer.byteLength ? view : view.slice()).finally(dropListCache)
          },
        }
      : {}),
    ...(amadeus?.readVaultBytes
      ? {
          readBytes: async (p: string): Promise<Uint8Array | null> => {
            // 与 readFile 同口径:不存在 / 越界 / 没有活动库一律 null,不抛。
            try { return (await amadeus.readVaultBytes(p)) ?? null } catch { return null }
          },
        }
      : {}),
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
    // 裸 Markdown 必须显式走 Amadeus editor,不能借 openFile(后者对未认领后缀会交给系统默认程序)。
    // reuseKey 让插件 Space 能稳定更新自己声明的文档伴随栏,activate:false 不抢回源视图焦点。
    // 非笔记路径(PDF / 图片 / 白板…)不进笔记编辑器:交给 openFile 按类型开对的视图(同 isPagePipelinePath)。
    openNote: (p, options) => { if (ok()) void import('../../amadeusNav').then((m) => (isPagePipelinePath(String(p ?? '')) ? m.openNote(p, options) : m.openFile(p))) },
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
    // 桥上有这个方法、但宿主声明做不了(hostCaps.revealInFileManager === false:手机本地库是空操作,
    // 云端库只弹一句「仅桌面」)同样不挂 —— 与宿主自己的菜单同一把尺子(amadeus/lib/hostCaps.ts)。
    ...(typeof amadeus?.revealInFileManager === 'function' && amadeus.hostCaps?.revealInFileManager !== false
      ? { reveal: (p: string): void => { if (ok()) void amadeus.revealInFileManager(p).catch(() => {}) } }
      : {}),
    // 把库内的文件 / 文件夹移进回收站(2026-10-05+)。走用户在文件树里删它的同一条路(pageStore.deletePage /
    // deleteFolder):冲洗在途写、移进回收站、收掉开着它的编辑器与标签、提示「已移入回收站」。那两条为了给界面
    // 兜底都把失败吞进 store.error;插件要的是结果,所以删完按刷新后的清单再判一次,还在就 reject。
    // 没有回收站的宿主**整条方法不挂**(同 reveal 的纪律):那里删除不可恢复,不替插件做。
    ...(amadeus?.trashEntry
      ? {
          trash: async (p: string): Promise<void> => {
            if (!ok()) throw new Error('plugin disabled')
            // 只归一分隔符与首尾斜杠,**不修空白**:文件名首尾的空格是名字的一部分(`Foo` 与 `Foo ` 在 macOS / Linux 上
            // 可以并存),normalizeVaultRel 的 trim 会让 `trash('Foo ')` 落到 `Foo` 头上(Codex 评审 P1)。
            const rel = toSlash(String(p ?? '')).replace(/^\/+|\/+$/g, '')
            const root = usePageStore.getState().vaultRoot
            // 清单里的原样字符串才是仓库动作认的键(Windows 上主进程给的是 `\`)
            const entry = (): { folder: boolean; raw: string } | null => {
              const s = usePageStore.getState()
              const hit = (list: string[]): string | undefined => list.find((x) => toSlash(x) === rel)
              const folder = hit(s.folders)
              if (folder !== undefined) return { folder: true, raw: folder }
              const file = hit(s.pages) ?? hit(s.files)
              return file !== undefined ? { folder: false, raw: file } : null
            }
            await usePageStore.getState().refreshStructure()
            if (!alive) throw new Error('plugin disabled') // 上面那次 await 期间被停用
            // 等清单的那一下换了库(Local ⇄ Cloud):同一个相对路径在另一个库里是别人的文件(Codex 评审 P1)
            if (usePageStore.getState().vaultRoot !== root) throw new Error('The active vault changed')
            const found = rel ? entry() : null
            if (!found) throw new Error(`No such file or folder in the vault: ${p}`)
            try {
              if (found.folder) await usePageStore.getState().deleteFolder(found.raw)
              else await usePageStore.getState().deletePage(found.raw)
            } finally {
              dropListCache() // 同 writeFile:落定之后清 —— 删之前拿到的清单里还有这一项,插件删完立刻重列会把它列回来
            }
            if (entry()) throw new Error(usePageStore.getState().error || `Could not move to the recycle bin: ${p}`)
          },
        }
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
function readOwed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(OWED_KEY) || '[]') as string[])
  } catch {
    return new Set()
  }
}
// ponytail: 同步读改写,绝不跨 await 攥着旧副本;只主窗写,没有跨窗口竞写。
function editOwed(fn: (owed: Set<string>) => void): void {
  const owed = readOwed()
  fn(owed)
  try {
    localStorage.setItem(OWED_KEY, JSON.stringify([...owed]))
  } catch {
    /* ignore */
  }
}

export function readDisabledPluginIds(): string[] {
  return readDisabled()
}

/** 已吊销的 ctx 上 register* 的返回值:既能当 disposer 调,也能当 `{ update, dispose }` handle 用,全是空操作 ——
 *  过期的续体拿着它继续跑不会再抛一个与真因无关的 TypeError。 */
const DEAD_HANDLE: (() => void) & { update(): void; dispose(): void } = Object.assign(() => {}, { update: () => {}, dispose: () => {} })

/** ctx.agent.subscribe 的轮询间隔:agent 周期是小时级的,20 秒足够跟上「周期结束 / 睡醒 / 有新待办」。 */
const AGENT_POLL_MS = 20_000

/** 插件自己视图里最近一次**可信**用户交互(PluginViewHost 在视图容器上捕获 isTrusted 的 pointerdown/click/keydown 记这里)。
 *  ctx.agent.updateTodo 只认这个:窗口级的 navigator.userActivation 会被别处的点击点亮(Codex 09-27),插件派发的合成事件
 *  isTrusted=false 记不进来。 */
const lastGesture = new Map<string, number>()
const GESTURE_WINDOW_MS = 1500
export function notePluginGesture(pluginId: string): void { lastGesture.set(pluginId, Date.now()) }
/** agent 自建 Space 代码的 sourceURL:栈帧里写的就是它(行号比 main.js 多 2 —— new Function 在函数体前包了两行头)。
 *  builtins/agentSpaceSync 据此把挂载之后的运行时错误归到这个 Space 身上、回写给 agent。
 *  带加载序号,且只返回**正在运行的那一版**(没在跑 → null):旧版漏清的定时器在重载后还会抛,新版没跑起来(来源没了 /
 *  被门禁挡)时也一样 —— 都不许算成「当前的 Space」(Codex 09-27 两轮)。setup 时登记,teardown 时摘掉。 */
const agentLoads = new Map<string, number>()
const agentLive = new Map<string, string>()
export const agentSpaceSourceUrl = (pluginId: string): string | null => agentLive.get(pluginId) ?? null

/** reloadOne 的按 id 串行链。 */
const reloadChains = new Map<string, Promise<void>>()

/** 外置插件最近装入的源码(按 id):reloadOne 用来跳过「磁盘内容没变」的重载(应用刚起第一次看到戳就不用拆装一遍)。 */
const loadedCode = new Map<string, string>()

/** 来源 → 插件的元数据部分(不含 setup,无副作用):重载时代码没变的插件只刷这一份,不拆不装。 */
function pluginMeta(src: ExternalPluginSource): Omit<AmadeusPlugin, 'setup'> {
  return {
    id: src.id,
    name: src.name,
    nameEn: src.nameEn,
    version: src.version,
    description: src.description,
    descriptionEn: src.descriptionEn,
    iconUrl: src.iconUrl,
    builtin: false,
    preinstalled: !!src.preinstalled,
    locked: !!src.locked,
    bundleOff: !!src.bundleOff,
    restartPending: !!src.restartPending,
    apiVersion: src.apiVersion,
    minAppVersion: src.minAppVersion,
    requiresApp: src.requiresApp,
    requiresPlugins: src.requiresPlugins,
    capabilities: src.capabilities,
    readme: src.readme,
    changelog: src.changelog,
    onboarding: src.onboarding,
    blocked: src.blocked,
    blockedReason: src.blockedReason,
    isDesktopOnly: src.isDesktopOnly,
    agent: src.agent,
    bundle: src.bundle,
    events: src.events,
    dev: src.dev,
    devRoot: src.devRoot,
    devProductId: src.devProductId,
    shadowsInstalled: src.shadowsInstalled,
  }
}

/** 运行身份:这几样变了,正在跑的那一份就是旧的,得拆了重装;别的(名字 / 图标 / README / 前置声明)只刷元数据。
 *  capabilities 决定注不注 ctx.system,agent 决定注不注 ctx.agent —— 都是 setup 那一刻定下的。 */
function sameRuntime(p: AmadeusPlugin, src: ExternalPluginSource): boolean {
  const caps = (x?: readonly string[]): string => [...(x ?? [])].sort().join(',')
  return loadedCode.get(src.id) === src.code
    && (p.blocked ?? null) === (src.blocked ?? null)
    && !!p.dev === !!src.dev
    && (p.devRoot ?? null) === (src.devRoot ?? null)
    && !!p.shadowsInstalled === !!src.shadowsInstalled
    && (p.agent ?? null) === (src.agent ?? null)
    && caps(p.capabilities) === caps(src.capabilities)
}

/** Wrap an external source as a plugin whose setup() evaluates its code with `ctx`. */
function toPlugin(src: ExternalPluginSource): AmadeusPlugin {
  loadedCode.set(src.id, src.code)
  // 每一次重新包装都是一次「重载」(loadExternal / reloadExternal / reloadOne 都经这里)——
  // 开发态记账在这一刻归零,免得 Studio 把上一份代码的日志算到新代码头上。
  if (src.dev) clearDevRecords(src.id)
  return {
    ...pluginMeta(src),
    // 返回值原样交回宿主:disposer、undefined,或 async setup 的 promise —— 落定 / 失败 / 过期的处理在 start() 里,
    // 开发副本与已安装插件同一套(过期判定看这一次激活的那本账还活不活)。
    setup: (ctx) => {
      // 已安装插件:求值路径与从前**逐字相同**(一个形参、一个实参)。开发态那条多带一个 console ——
      // new Function 的栈帧是 <anonymous>,不在求值时把按插件记账的 console 塞进作用域,
      // 事后没有任何办法把一行输出归到是哪个插件说的(window.onerror 也归不了)。
      // 例外只有 agent 自建 Space(src.agent):末尾打一行 sourceURL,栈帧才认得出是它 —— 挂载之后在异步回调 / 事件处理里
      // 抛的错(宿主的 try/catch 与 mount 的 Promise 都罩不住)才能回写给 agent(09-27 live:选择器拿到 null,数据卡全空,
      // 报错只进控制台,Muse 一无所知)。
      if (!src.dev) {
        let code = src.code
        let url: string | null = null
        if (src.agent) {
          const n = (agentLoads.get(src.id) ?? 0) + 1
          url = `forsion-agent-space/${src.id}/${n}/main.js`
          agentLoads.set(src.id, n)
          code = `${src.code}\n//# sourceURL=${url}`
        }
        const fn = new Function('ctx', code) as (c: PluginContext) => ReturnType<AmadeusPlugin['setup']>
        const d = fn(ctx)
        // 跑成功了才算「正在运行的那一版」:同步 setup 抛错 → 由加载失败那条回写负责,它残留的定时器不再另报(Codex 09-27 三轮)
        if (url) agentLive.set(src.id, url)
        return d
      }
      const fn = new Function('ctx', 'console', src.code) as (c: PluginContext, console: Console) => ReturnType<AmadeusPlugin['setup']>
      return fn(ctx, devConsoleFor(src.id))
    },
  }
}

/** 插件文件后缀的形态判定(registerFileType 与 viewSurface 的 loadPage 闸共用)。 */
export function isValidPluginExt(e: string): boolean {
  if (!e.startsWith('.') || e.length < 2) return false
  if (/\.md$/i.test(e)) return /^\.[^.].*\.md$/i.test(e) // md 类必须复合后缀 '.X.md'
  return true
}

/** 这条路径能不能进笔记读写管线(loadPage → 编辑 → savePage)。只有 `.md`、且不是内置文件类型(白板)才行:
 *  二进制(被插件覆盖的 `.pdf`)或白板进来,第一次保存就被写成 markdown = 毁档(主进程的 loadPage / savePage 不验后缀)。
 *  插件够得着的三个入口共用这一条:ctx.app.loadPage、ctx.app.openNote、文件视图的页表面(viewSurface)。 */
export function isPagePipelinePath(p: string): boolean {
  return /\.md$/i.test(p) && !isBuiltinFileType(p)
}

/** 每个正在运行的插件一本副作用账(effectScope.ts);teardown 关账。模块级:视图宿主组件也要往里记。 */
const liveScopes = new Map<string, EffectScope>()

/** 视图级页表面(viewSurface)的吊销登记:插件禁用时 fileTypes 切片一变,React 重渲 → effect
 *  cleanup 会把视图表面收掉,但那是**异步**的 —— 记在插件当前那本账上,teardown 关账时同步吊销,才封死
 *  「禁用后在飞的插件代码还能写文件」的空窗。视图正常卸载时自己收尾,返回的函数只把这条从账上划掉。
 *  插件此刻不在跑(正停 / 已停)→ 当场吊销:不给已经停掉的插件留一个活的写口。 */
export function addPluginViewTeardown(pluginId: string, fn: () => void): () => void {
  const scope = liveScopes.get(pluginId)
  if (scope) return scope.own('viewSurface', fn).forget
  try { fn() } catch (e) { console.error(`[amadeus] plugin "${pluginId}" view-surface revoke failed`, e) }
  return () => {}
}

/** 插件此刻挂在宿主里的东西:各切片里的注册项条数 + 副作用账(订阅 / 挂载 / 字体 / 编辑器扩展……)。
 *  插件详情页「运行占用」用;不在跑 → 0 与空。 */
export function pluginFootprint(pluginId: string): { registrations: number; effects: EffectRecord[] } {
  const s = usePluginStore.getState()
  let registrations = 0
  for (const k of SLICE_KEYS) for (const o of s[k] as Owned<unknown>[]) if (o.pluginId === pluginId) registrations++
  return { registrations, effects: liveScopes.get(pluginId)?.records() ?? [] }
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

function serialIn<T>(chains: Map<string, Promise<unknown>>, pluginId: string, task: () => Promise<T>): Promise<T> {
  const next = (chains.get(pluginId) ?? Promise.resolve()).then(task, task)
  chains.set(pluginId, next.catch(() => {})) // 链本身不许因为某一环失败就断掉
  return next
}

/** 每插件一条规则串行链:ensure 的「逐条 upsert」与 disable 的「拉全量 → 逐条关」不许交错。
 *  交错的后果是静默的:disable 先拉到名单(那时 ensure 还没发),ensure 随后把规则全 upsert 成 enabled:true,
 *  最终用户看到插件是禁用的、引擎里规则却是开的 —— 正是 codex 抓的那条。链只按 id 分,不引依赖。 */
const ruleChains = new Map<string, Promise<unknown>>()
const serialByPlugin = <T>(pluginId: string, task: () => Promise<T>): Promise<T> => serialIn(ruleChains, pluginId, task)

/** 捆绑包内嵌引擎插件启停的串行链(按父插件):拨开关的级联(AmadeusPluginsTab)与对齐(syncBundleEngines)
 *  各自在链内现读期望态,两边的 PUT 不会乱序落成「卡片开、引擎关」。与规则链分开:引擎 PUT 卡住不许连带挡住规则停用。 */
const bundleEngineChains = new Map<string, Promise<unknown>>()
export const serialBundleEngines = <T>(pluginId: string, task: () => Promise<T>): Promise<T> => serialIn(bundleEngineChains, pluginId, task)

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

/** 后端 !ok→ok 边沿的唯一入口:欠账都在这里补 —— 没种下的规则(ensure)、没停用的规则(disable)、
 *  没关掉的捆绑包内嵌引擎插件。 */
function onBackendReadyEdge(): void {
  replayFailedEnsures()
  replayPendingDisables()
  void syncBundleEngines().catch((e) => console.warn('[amadeus] 捆绑包内嵌引擎插件对齐失败', e))
}

/** 用户想不想让它跑(偏好)。locked 包(Forsion Extend)看主进程那一半的开关(bundleOff),不看 localStorage ——
 *  旧开关拨下的「关」会一直留在那儿,而主进程半身其实在跑,按 localStorage 判它挂进「Forsion 云端」的设置页就永远出不来。 */
export function pluginWanted(p: AmadeusPlugin, disabledIds: readonly string[] = usePluginStore.getState().disabledIds): boolean {
  return p.locked ? !p.bundleOff : !disabledIds.includes(p.id)
}

/** p 还差哪些前置(空 = 齐了;口径见 pluginDeps.ts:装了、没被挡、版本够、**正在跑**)。 */
export function unmetPluginDeps(
  p: AmadeusPlugin,
  s: Pick<PluginState, 'plugins' | 'activeIds' | 'disabledIds'> = usePluginStore.getState(),
): UnmetDependency[] {
  if (!p.requiresPlugins?.length) return []
  const byId = new Map(s.plugins.map((x) => [x.id, x]))
  return unmetDependencies(p, s.plugins, (id) => s.activeIds.includes(id), (id) => { const q = byId.get(id); return !!q && pluginWanted(q, s.disabledIds) })
}

/** 正在跑、且直接或间接声明了要 id 的插件(停用 / 卸载 id 之前给用户看:它们会跟着暂停)。 */
export function runningDependents(id: string): AmadeusPlugin[] {
  const s = usePluginStore.getState()
  return dependentsOf(id, s.plugins).filter((p) => s.activeIds.includes(p.id))
}

/** 捆绑包内嵌引擎插件该开(true)/ 该关(false)/ 别动(null),只看父插件:在跑 → 开;用户关了它、或它在等前置 → 关;
 *  门禁挡着、加载失败、还没装载完(启动时还在异步激活,会误关)→ 不动 —— 显式 false 是粘性的,解禁后没人翻回来。 */
export function bundleEngineDesired(id: string): boolean | null {
  const s = usePluginStore.getState()
  const p = s.plugins.find((x) => x.id === id)
  if (!p) return null
  if (!pluginWanted(p, s.disabledIds)) return false // 用户关了优先于「还在跑」(locked 包关了要到重启才拆)
  if (s.activeIds.includes(id)) return true
  if (p.blocked || s.lastSetupError[id]) return null
  return unmetPluginDeps(p, s).length ? false : null
}

/** 捆绑包内嵌引擎插件跟父插件走(bundleEngineDesired),**只主窗**写引擎:各窗口运行态可能不同,拨开关的那个窗口(设置浮窗)
 *  不直接 PUT,主窗收到偏好 / 开启戳后在这里统一串行写(Codex 10-02)。每次对齐之后、每次就绪边沿跑。
 *  关:父插件被关 / 在等前置 → 关掉仍开着的,并记进欠账(OWED_KEY);开:父插件在跑 → **只**补开欠账里的 ——
 *  用户在 TUI / CLI 关掉的不翻回来。门禁挡着 / 失败 / 还没装载完 → 不动(启动时还在异步激活,会误关)。
 *  跳过:用户目录同 id 覆盖与首方内置同 id 不归捆绑包管;设备页不动对端引擎。
 *  失败不能只等下一个边沿:后端一直就绪就不会再有边沿 → 按 ensure 重放的节奏补(≥30s,每次触发各自至多 3 次)。 */
export async function syncBundleEngines(attempt = 0): Promise<void> {
  if (typeof window === 'undefined' || window.tangu?.unitPage || (window as unknown as { __FORSION_UNIT_PAGE__?: unknown }).__FORSION_UNIT_PAGE__) return
  // 只主窗:各窗口的运行态可能不一样(某窗里加载失败),N 个窗口各按各的写会来回翻。
  if (windowKind() !== 'main') return
  ensureReadySubscription() // 这次等不到后端,就绪边沿再来一次
  const cfg = (await readTangu()?.waitBackend?.(ENSURE_WAIT_MS)) ?? null
  if (!cfg) return
  const parents = usePluginStore.getState().plugins.filter((p) => p.bundle?.enginePlugins?.length && bundleEngineDesired(p.id) !== null)
  if (!parents.length) return
  let userOwned = new Set<string>()
  try {
    userOwned = new Set(((await window.tangu?.pluginsUserInstalled?.()) ?? []).map((x) => x.id))
  } catch { /* 桥缺位按空集 */ }
  let failed = false
  for (const p of parents) {
    // 与级联同链,链内现读期望**与引擎名单**:排队期间用户又拨了开关、或前一个任务的 PUT 刚落定(暂停→恢复连着来),
    // 按此刻的来 —— 链外先拉的名单快照会过期,拿它比会漏掉「父插件已恢复、引擎插件还关着」(Codex 10-02)。
    await serialBundleEngines(p.id, async () => {
      if (bundleEngineDesired(p.id) === null) return
      const engine = await listPlugins(connectionTarget(cfg)) // 拉失败也回 [],与「一个都没有」分不开 → 按失败补
      if (!engine.length) { failed = true; return }
      const want = bundleEngineDesired(p.id) // 等名单那一下也可能拨了开关:名单到手后再读
      if (want === null) return
      const enabled = new Map(engine.filter((e) => e.source !== 'builtin' && !userOwned.has(e.id)).map((e) => [e.id, e.enabled]))
      for (const id of p.bundle?.enginePlugins ?? []) {
        if (!enabled.has(id)) continue
        if (!want) {
          if (enabled.get(id)) await setPluginEnabled(connectionTarget(cfg), id, false).then(() => editOwed((o) => o.add(id)), () => { failed = true })
        } else if (readOwed().has(id)) {
          if (enabled.get(id)) editOwed((o) => o.delete(id))
          else await setPluginEnabled(connectionTarget(cfg), id, true).then(() => editOwed((o) => o.delete(id)), () => { failed = true })
        }
      }
    })
  }
  if (failed && attempt < ENSURE_REPLAY_MAX) {
    setTimeout(() => void syncBundleEngines(attempt + 1).catch((e) => console.warn('[amadeus] 捆绑包内嵌引擎插件对齐失败', e)), ENSURE_REPLAY_MIN_GAP_MS)
  }
}

/** 用户明确打开了 id(本窗 enable,或别的窗口的戳):清本窗记着的失败;主窗记下欠它内嵌引擎插件的 true。 */
function noteExplicitEnable(id: string): void {
  usePluginStore.setState((s) => {
    if (!s.lastSetupError[id]) return {}
    const lastSetupError = { ...s.lastSetupError }
    delete lastSetupError[id]
    return { lastSetupError }
  })
  const engines = usePluginStore.getState().plugins.find((p) => p.id === id)?.bundle?.enginePlugins ?? []
  if (engines.length && windowKind() === 'main') editOwed((o) => engines.forEach((e) => o.add(e)))
}

/** storage 事件:别的窗口明确打开了某插件(PLUGIN_ENABLE_STAMP_KEY)。 */
export function applyPluginEnableStamp(raw: string | null): void {
  let id: unknown
  try {
    id = raw ? (JSON.parse(raw) as { id?: unknown }).id : undefined
  } catch {
    return
  }
  if (typeof id !== 'string') return
  noteExplicitEnable(id)
  usePluginStore.getState().syncDisabledPreferences()
}

/** 因前置没齐而停着的插件,它种在引擎里的规则已经发过停用的(每次进入这个状态发一次;重新跑起来即清 —— setup 会再 ensure)。 */
const pendingRulesOff = new Set<string>()

/** 对齐之后的引擎侧收尾,只主窗做(各窗都会对齐,发 N 遍没意义):想开却因前置没齐停着的插件,规则先停 ——
 *  用户看到的是「没在运行」,引擎里不许照跑;再让捆绑包内嵌引擎插件跟上父插件的运行态。 */
function afterReconcile(): void {
  if (windowKind() !== 'main' || !automationHost()) return
  const s = usePluginStore.getState()
  for (const p of s.plugins) {
    if (s.activeIds.includes(p.id) || p.blocked || pendingRulesOff.has(p.id) || !pluginWanted(p, s.disabledIds) || !unmetPluginDeps(p, s).length) continue
    pendingRulesOff.add(p.id)
    void disablePluginRules(p.id).catch((e) => console.warn(`[amadeus] plugin "${p.id}" 停用自动化规则失败`, e))
  }
  if (s.plugins.some((p) => p.bundle?.enginePlugins?.length)) void syncBundleEngines().catch((e) => console.warn('[amadeus] 捆绑包内嵌引擎插件对齐失败', e))
}

/** 按插件归属的切片。键必须恰好是 PluginState 里全部 Owned<…>[] 字段(satisfies 管着:新增切片忘了登记就编译不过)——
 *  旧代码在 teardown 与 setup 失败两处各手抄一遍。 */
type OwnedKey = { [K in keyof PluginState]: PluginState[K] extends Owned<unknown>[] ? K : never }[keyof PluginState]
const SLICE_KEYS = Object.keys({
  slashItems: 1, selectionActions: 1, commands: 1, themes: 1, panels: 1, statusItems: 1, propertyTypes: 1, settings: 1,
  settingsViews: 1, storeViews: 1, readiness: 1, views: 1, listSources: 1, fileTypes: 1, embedRenderers: 1, fileCreators: 1,
} satisfies Record<OwnedKey, 1>) as OwnedKey[]

/** 摘掉 id 的全部切片贡献;没有它的切片保持原数组身份(订阅者不白白重渲)。 */
function dropSlices(s: PluginState, id: string): Partial<PluginState> {
  const out: Partial<Record<OwnedKey, Owned<unknown>[]>> = {}
  for (const k of SLICE_KEYS) {
    const arr = s[k] as Owned<unknown>[]
    if (arr.some((o) => o.pluginId === id)) out[k] = arr.filter((o) => o.pluginId !== id)
  }
  return out as Partial<PluginState>
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
        await saveMuseTrigger(connectionTarget(cfg), u)
      } catch (e) {
        errors.push(`${u.id}: ${errMsg(e)}`)
      }
    }
    return { ok: !errors.length, errors }
  })
}

/** 插件**确定不跑了** → 它的 `plugin:<id>:` 规则全部 enabled=false(不删;再启用时插件自己的 ensure 会置回 true,
 *  引擎那边 false→true 会 dropCursors 重新播种)。全量拉 + 前缀过滤,没有就自然 no-op;fire-and-forget。
 *  调用点只有三处:用户明确禁用(disable)、因前置没齐停着(afterReconcile,主窗)、来源没了(applySources,主窗)。
 *  ⚠️不进 teardown —— 它被重载与 setup 失败复用,在那里关规则会与紧随其后的 ensure(enabled:true)赛跑。
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
        list = await getMuseTriggers(connectionTarget(cfg))
      } catch (e) {
        errors.push(errMsg(e))
        return
      }
      for (const t of list) {
        if (!isPluginOwnedRule(pluginId, t.id) || !t.enabled) continue
        try {
          await saveMuseTrigger(connectionTarget(cfg), { ...triggerToUpsert(t), enabled: false })
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
  const makeContext = (pluginId: string): PluginContext => {
    liveScopes.get(pluginId)?.close() // 防守:没经 teardown 就重建 context 也不留旧账
    // 每个插件一份 app API(块表面可吊销)。关账时先杀它(ctx.app 变哑、块表面吊销、文件订阅收掉),
    // 旧代码持有的引用从此是哑的 —— 然后才逐条撤别的副作用。
    const { api: appApi, revokeSurface } = makeAppApi(pluginId, () => get().plugins.find((p) => p.id === pluginId)?.name || pluginId)
    const scope = createEffectScope(pluginId, () => {
      lastGesture.delete(pluginId) // 旧实例上的点击不许授权重载后的新实例(Codex 09-27)
      revokeSurface()
    })
    liveScopes.set(pluginId, scope)
    // ctx 级活性闸(ctx.app 的 alive 管不到 ctx.tangu / ctx.desk):吊销后 startChat 不再开对话、
    // registerCompanion 不再挂新伴随面、旧 handle 变哑。语言 / 模型 / 账号订阅、仪表盘 / 原生表 / 宿主 UI 挂载、
    // 字体、伴随面……插件自己能撤,但**最终责任人是宿主**:全记在 scope 上,关账统一撤(codex 评审 2026-08-14 起的纪律)。
    const ctxAlive = (): boolean => scope.alive()
    // agent 自建 Space 读写自家数据(2026-09-27):**只注入给 agent-<slug> 插件**(来源 <tangu>/agents/<slug>/Space/,
    // plugin.agent = slug),只能碰它自己这个 agent;探针缺这条(纯 Amadeus 壳 / 台架)或该 agent 没有数据源 → 整个不注入。
    // 写只在用户刚在**它自己的视图里**点过之后放行:插件代码是 agent 自己写的,不许它不经点击替用户处理 TODO ——
    // 完成 / 忽略会以「用户处理了」的 [feedback] 回到 agent 日志,自己点自己 = 伪造反馈,它下个周期就按假信号校准。
    // ⚠️这防的是「顺手写个定时器 / 挂载时就标掉」这类失误,**不是安全边界**:插件与宿主同一个渲染进程,
    // 存心作恶的代码能拦 fetch 拿令牌直调引擎、能包 Function 截别的插件的 ctx(Codex 09-27)—— 要隔离得上 iframe / 独立进程。
    const agentSurface = (): { agent?: PluginContext['agent'] } => {
      const slug = get().plugins.find((p) => p.id === pluginId)?.agent
      const self = slug ? readTangu()?.agentSelf?.(slug) : null
      if (!slug || !self) return {}
      const alive = <T,>(f: () => Promise<T>): Promise<T> => (ctxAlive() ? f() : Promise.reject(new Error('plugin disabled')))
      // 订阅:有人订才轮询,状态键(在跑 / 上次周期 / 休眠 / 待批数 / 待办数)变了才回调;updateTodo 之后立刻补一次。
      const listeners = new Set<() => void>()
      let timer: ReturnType<typeof setInterval> | null = null
      let lastKey: string | null = null
      const fire = (): void => {
        for (const cb of Array.from(listeners)) {
          // reportError = 当成未捕获错误派给窗口(同时打控制台):订阅回调是 agent Space 的代码,吞成一行日志它就永远不知道
          try { cb() } catch (e) { if (typeof globalThis.reportError === 'function') globalThis.reportError(e); else console.error(`[amadeus] plugin "${pluginId}" ctx.agent subscriber failed`, e) }
        }
      }
      const check = async (): Promise<void> => {
        if (!ctxAlive() || !listeners.size) return
        const [st, pending] = await Promise.all([self.status().catch(() => null), self.todos('pending').catch(() => null)])
        if (!st || !pending || !ctxAlive()) return
        // 待办按 id 比而不是按条数:别处忽略一条、同时新长出一条,条数不变也得回调
        const key = `${st.running}|${st.lastCycleAt}|${st.sleepUntil}|${st.pendingApprovals}|${pending.map((t) => t.id).sort().join(',')}`
        if (lastKey !== null && key !== lastKey) fire()
        lastKey = key
      }
      const gesture = (): boolean => Date.now() - (lastGesture.get(pluginId) ?? 0) <= GESTURE_WINDOW_MS
      return {
        agent: {
          slug,
          status: () => alive(() => self.status()),
          todos: (status) => alive(() => self.todos(status)),
          updateTodo: (id, status) => {
            if (status !== 'done' && status !== 'dismissed') return Promise.reject(new Error("status must be 'done' or 'dismissed'"))
            // 调用那一刻判:本插件视图里 1.5 秒内有过真实点击 / 按键;定时器 / 挂载时 / 别处的点击一律拒
            if (!gesture()) return Promise.reject(new Error('ctx.agent.updateTodo only works right after the user clicks inside your own view (call it from a click handler)'))
            // alive 传进去:等后端就绪那一拍里插件被停用,就别再把写发出去
            return alive(() => self.updateTodo(String(id), status, ctxAlive)).then(() => { if (ctxAlive()) fire() })
          },
          schedule: () => alive(() => self.schedule()),
          library: {
            list: () => alive(() => self.libraryList()),
            read: (path: string) => alive(() => self.libraryRead(String(path))),
          },
          subscribe: (cb: () => void) => {
            if (!ctxAlive()) return () => {}
            listeners.add(cb)
            if (!timer) { void check(); timer = setInterval(() => void check(), AGENT_POLL_MS) }
            return scope.own('subscription', () => {
              listeners.delete(cb)
              if (!listeners.size && timer) { clearInterval(timer); timer = null; lastKey = null }
            }, 'agent')
          },
        },
      }
    }
    const ctx: PluginContext = {
    app: appApi,
    account: hostTangu()?.account ? {
      ...hostTangu()!.account!,
      subscribe: (listener) => scope.own('subscription', hostTangu()!.account!.subscribe(listener), 'account'),
    } : undefined,
    registerSlashItem: (item) => set((s) => ({ slashItems: [...s.slashItems, { pluginId, item }] })),
    registerSelectionAction: (action) => {
      if (!ctxAlive()) return
      if (!action || typeof action.id !== 'string' || typeof action.title !== 'string' || typeof action.run !== 'function') {
        console.warn(`[amadeus] 插件 ${pluginId} 的 registerSelectionAction 缺 id / title / run,已忽略`)
        return
      }
      set((s) => ({ selectionActions: [...s.selectionActions.filter((o) => !(o.pluginId === pluginId && o.item.id === action.id)), { pluginId, item: action }] }))
    },
    registerCommand: (command) =>
      set((s) => ({ commands: [...s.commands, { pluginId, item: command }] })),
    registerTheme: (theme) => {
      injectThemeStyle(theme.id, theme.css)
      scope.own('theme', () => removeThemeStyle(theme.id), theme.id) // <style> 在 store 外:只删切片会留孤儿
      set((s) => ({ themes: [...s.themes, { pluginId, item: theme }] }))
    },
    registerAppearance: (preset) => {
      if (!ctxAlive()) return () => {}
      // 插件不调 disposer 也得收干净(同 registerFont):停用后外观下拉里不留死项
      return scope.own('appearance', registerAppearance(pluginId, preset), preset.id)
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
      // 插件不调 disposer 也得收干净,否则停用后下拉里还留着选不出效果的死项。
      return scope.own('font', dispose, font.id)
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
    // 停用后残留的定时器不许再弹(10-02 补的活性闸,与 ctx.app 的副作用口同一条纪律)。
    notify: (message, opts) =>
      void (ctxAlive() && notifyApp({
        text: String(message ?? ''),
        level: opts?.level,
        title: opts?.title ? String(opts.title) : undefined,
        sticky: typeof opts?.sticky === 'boolean' ? opts.sticky : undefined,
        event: `plugin:${pluginId}`,
        sourceLabel: get().plugins.find((p) => p.id === pluginId)?.name || pluginId,
      })),
    registerView: (view) => set((s) => ({ views: [...s.views, { pluginId, item: view }] })),
    registerListSource: (src) => set((s) => ({ listSources: [...s.listSources, { pluginId, item: src }] })),
    // 内置后缀不给注册(内置优先是硬规则,见 isBuiltinFileType);唯一的口子是「可覆盖」的那几个后缀
    // 配上显式的 override: true(见 isOverridableBuiltinType)。返回 false 让插件知道自己被内置取代了,
    // 可以整体退让 —— 光靠 find* 那道闸拦不住插件继续贡献重复的「新建 X」右键项和斜杠项。
    // 旧宿主返回 undefined(≠ false),插件的 `if (ok === false) return` 判定天然兼容。
    registerFileType: (def) => {
      const exts = Array.isArray(def?.extensions) ? def.extensions : []
      // ⚠️开发副本不给注册文件类型:主进程的毁档防线(collectPluginExts → listPages 排除)只扫已安装目录,
      // dev 根不在其中。清单里声明 fileExtensions 会被判 'dev-fileext' 拒载 —— 但只拦清单等于只拦了无害的那半:
      // 删掉那一行就能载入,setup 里照样调到这里,用户在真库里建出的 `.foo.md` 会被笔记管线改写(评审 MED)。
      // 这道防线只为 `.md` 类后缀而设:非 md 后缀(如覆盖内置的 `.pdf`)本来就不进笔记管线,
      // 开发副本可以注册 —— 否则写一个 PDF 插件只能反复安装着测。
      if (get().plugins.find((p) => p.id === pluginId)?.dev && exts.some((e) => /\.md$/i.test(String(e ?? '')))) {
        console.warn(`[plugin:${pluginId}] registerFileType(${exts.join(',')}) 被拒:开发副本的自定义文件类型不受宿主扩展名保护,请先安装再测`)
        return false
      }
      // 形态闸:后缀必须 '.x' 起步;以 '.md' 收尾的必须是复合后缀('.X.md')。裸 '.md'、漏点 'md'、
      // 空串这类声明会让 viewSurface 的 loadPage 后缀闸(endsWith 判定)对**所有笔记**敞开 ——
      // 那道闸防的是「普通 v4/素 md 被拽进 v3 存储管线改写 = 毁档」(评审 P2,2026-08-14)。
      if (!exts.length || !exts.every((e) => isValidPluginExt(String(e ?? '')))) {
        console.warn(`[plugin:${pluginId}] registerFileType(${exts.join(',')}) 被拒:后缀声明不合形态(须 '.x',md 类须复合后缀 '.X.md')`)
        return false
      }
      const taken = (e: string): boolean => isBuiltinFileType(e) && !(def.override === true && isOverridableBuiltinType(e))
      if (exts.every((e) => taken(String(e)))) {
        const hint = exts.some((e) => isOverridableBuiltinType(String(e))) ? '(这个后缀可以覆盖,但要显式写 override: true)' : ''
        console.warn(`[plugin:${pluginId}] registerFileType(${exts.join(',')}) 被拒:该后缀已由 Forsion 内置文件类型认领${hint}`)
        return false
      }
      // fmKeys(属性面板隐藏用)只收非空字符串;amadeus_* 是编译器地盘,插件不许认领。
      const fmKeys = Array.isArray(def?.fmKeys)
        ? def.fmKeys.map((k) => String(k ?? '').trim()).filter((k) => k && !/^amadeus_/.test(k))
        : undefined
      // 认领不了的内置后缀从贡献里剔掉(混着声明 ['.pdf', '.excalidraw.md'] 时只留 '.pdf'):留着的话,
      // 页表面按「本类型的后缀」放行 loadPage,白板就能被这个插件拽进笔记管线(Codex 评审 P0)。
      const extensions = exts.map((e) => String(e)).filter((e) => !taken(e))
      set((s) => ({ fileTypes: [...s.fileTypes, { pluginId, item: { ...def, extensions, ...(fmKeys ? { fmKeys } : {}) } }] }))
      return true
    },
    registerEmbedRenderer: (def) =>
      set((s) => ({ embedRenderers: [...s.embedRenderers, { pluginId, item: def }] })),
    registerFileCreator: (def) =>
      set((s) => ({ fileCreators: [...s.fileCreators, { pluginId, item: def }] })),
    // 打开自己的视图:类型名由宿主统一命名空间(plugin:<id>:<viewId>),防跨插件顶替。
    openView: (viewId, opts) => { if (ctxAlive()) get().viewOpener?.(`plugin:${pluginId}:${viewId}`, opts?.location) },
    get viewLocations() { return get().viewLocations ?? undefined },
    // 关 / 换同样按这一代判活:视图类型名按插件 id 命名空间、新旧两代共用,旧一代迟到的回调会关掉 / 换掉新一代开着的视图。
    closeView: (viewId) => { if (ctxAlive()) get().viewControls?.close(`plugin:${pluginId}:${viewId}`) },
    replaceView: (fromViewId, toViewId, opts) =>
      (ctxAlive() ? get().viewControls?.replace(`plugin:${pluginId}:${fromViewId}`, `plugin:${pluginId}:${toViewId}`, opts?.params) ?? 0 : 0),
    ...(!hostTangu()?.mobile ? { openFloatingPanel: (viewId: string, opts?: import('./types').PluginFloatingPanelOptions) => {
      const type = `plugin:${pluginId}:${viewId}`
      const def = get().views.find((item) => item.pluginId === pluginId && item.item.id === viewId)?.item
      if (!def || !ctxAlive()) return
      const target = { id: type, title: opts?.title || def.title, view: { type, params: opts?.params },
        width: opts?.width, height: opts?.height, minWidth: opts?.minWidth, minHeight: opts?.minHeight }
      if (hostTangu()?.openFloatingPanel) void hostTangu()?.openFloatingPanel?.(target)
      else openWebFloatingPanel(target)
    } } : {}),
    ...(hostTangu()?.openMini ? {
      openMiniPanel: (viewId: string, opts?: import('./types').PluginMiniPanelOptions) => {
        const type = `plugin:${pluginId}:${viewId}`
        const def = get().views.find((item) => item.pluginId === pluginId && item.item.id === viewId)?.item
        if (!def || !ctxAlive()) return
        const mainType = `plugin:${pluginId}:${opts?.mainViewId || viewId}`
        hostTangu()?.openMini?.({ title: opts?.title || def.title, params: opts?.params,
          view: { type, params: opts?.params }, mainView: { type: mainType, params: opts?.mainViewParams } })
      },
    } : {}),
    // 宿主 UI 当前语言(2026-08-14 起):插件自带双语词表,用它挑。只报变化,初值走 getLocale()。
    getLocale: () => currentLocale(),
    subscribeLocale: (cb) => scope.own('subscription', subscribeLocale(cb), 'locale'),
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
    // 商店左栏的插件页:同 id 重注册即覆盖。显示与否(首方内置包、非设备页)由 MarketModal 把关。
    registerStoreView: (def) => {
      if (!def?.id || !def.title || typeof def.mount !== 'function') {
        console.warn(`[plugin:${pluginId}] registerStoreView 需要 { id, title, mount }`)
        return
      }
      set((s) => ({ storeViews: [...s.storeViews.filter((o) => !(o.pluginId === pluginId && o.item.id === def.id)), { pluginId, item: def }] }))
    },
    // 就绪检查:同 id 重注册即覆盖。宿主只在注意力在场时调(引导卡 / 重新检查 / 手动启用),见 pluginOnboardingStore。
    registerReadiness: (def) => {
      if (!def?.id || typeof def.check !== 'function') {
        console.warn(`[plugin:${pluginId}] registerReadiness 需要 { id, label, check }`)
        return
      }
      set((s) => ({
        readiness: [...s.readiness.filter((o) => !(o.pluginId === pluginId && o.item.id === def.id)), { pluginId, item: def }],
      }))
    },
    // 编辑器扩展:注册表在 editorExtensions.ts(叶子模块,破 store↔MarkdownBlock 的 import 环)。
    // 名字给扩展隔离的提示用(评审 G1-07:哪个插件的扩展坏了要点名)。
    // 撤是按插件整体撤(clearEditorExtensions 让全部编辑器原地重配一次),所以 N 份扩展只记一条。
    registerEditorExtension: (factory, opts) => {
      addEditorExtension(pluginId, factory, opts, () => get().plugins.find((p) => p.id === pluginId)?.name || pluginId)
      scope.ownOnce('editorExtension', () => clearEditorExtensions(pluginId))
    },
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
    // 通用宿主 UI 原语。Floating TOC 是非接管式挂载:插件继续拥有正文 DOM,宿主只在 shell 上叠一层。
    // 与 table/dashboard 一样动态 import 破环;形态错误同步抛,让插件能当场走自己的降级 UI。
    ...(typeof document !== 'undefined' ? { ui: {
      mountMarkdownEditor: (el, opts) => {
        const pending = { ...opts }
        let mounted: import('../../../../shared/markdownEditor').PluginMarkdownEditorHandle | null = null
        let cancelled = false, focusPending = false
        let failure: { dispose(): void } | null = null // 挂载失败的提示:也是一份宿主挂载(el 是插件的,不整个清空它),dispose 时收走
        if (!(el instanceof HTMLElement) || typeof opts?.value !== 'string') throw new TypeError('mountMarkdownEditor needs an HTMLElement and Markdown value')
        // 插件没接 disposer 时由关账统一卸;已停用时登记即撤(cancelled 当场为真,不挂)。
        const dispose = scope.own('mount', () => { cancelled = true; if (mounted) pending.value = mounted.getValue(); mounted?.dispose(); mounted = null; failure?.dispose(); failure = null }, 'markdownEditor')
        if (!cancelled) {
          // 调用这一刻就认领 el:动态 import 落地时 el 已经交给了后来的挂载 → 这次作废(见 claimHostMount)
          const mine = claimHostMount(el)
          void import('./markdownEditorSurface').then(m => {
            if (cancelled) return
            if (!mine()) { dispose(); return }
            mounted = m.mountPluginMarkdownEditor(el, pending)
            if (focusPending) mounted.focus()
          }).catch(e => {
            console.error('[amadeus] Markdown editor mount failed', e)
            if (cancelled || !mine()) return
            failure = mountHostReact(el, String(e))
          })
        }
        return {
          getValue() { return mounted?.getValue() ?? pending.value },
          update(patch) { if (!cancelled) { Object.assign(pending, patch); mounted?.update(patch) } },
          insertMarkdown(markdown) { if (!cancelled && !pending.readOnly) { if (mounted) mounted.insertMarkdown(markdown); else { pending.value += '\n\n' + markdown; pending.onChange?.(pending.value) } } },
          focus() { if (!cancelled) { focusPending = true; mounted?.focus() } },
          dispose,
        }
      },
      mountChatBox: (el, opts) => {
        if (!ctxAlive()) return { update() {}, focus() {}, dispose() {} }
        if (!(el instanceof HTMLElement)) throw new TypeError('mountChatBox needs an HTMLElement')
        if (typeof opts?.onSubmit !== 'function') throw new TypeError('mountChatBox needs onSubmit')
        let mounted: import('../../../../shared/chatBox').PluginChatBoxHandle | null = null
        let cancelled = false, focusPending = false
        const pending = { ...opts }
        const dispose = scope.own('mount', () => { cancelled = true; mounted?.dispose(); mounted = null }, 'chatBox')
        const mine = cancelled ? () => false : claimHostMount(el) // 已吊销的上下文不许认领:会把新上下文那次请求挤掉
        void import('./chatBoxSurface').then(m => {
          if (cancelled) return
          if (!mine()) { dispose(); return }
          mounted = m.mountPluginChatBox(el, pending)
          if (focusPending) requestAnimationFrame(() => mounted?.focus())
        }).catch(e => { console.error(`[amadeus] plugin "${pluginId}" Chat Box mount failed`, e) })
        return {
          update(patch) { if (!cancelled) { Object.assign(pending, patch); mounted?.update(patch) } },
          focus() { if (!cancelled) { focusPending = true; mounted?.focus() } },
          dispose,
        }
      },
      mountFloatingToc: (shell, opts) => {
        if (!(shell instanceof HTMLElement)) throw new TypeError('mountFloatingToc shell must be an HTMLElement')
        if (!opts || !(opts.scrollContainer instanceof HTMLElement)) throw new TypeError('mountFloatingToc scrollContainer must be an HTMLElement')
        if (opts.contentRoot != null && !(opts.contentRoot instanceof HTMLElement)) throw new TypeError('mountFloatingToc contentRoot must be an HTMLElement')
        if (opts.selector != null) opts.scrollContainer.querySelector(String(opts.selector)) // 同步校验 selector 语法
        let mounted: import('./types').PluginFloatingTocHandle | null = null
        let cancelled = false
        let pendingRefresh = false
        const dispose = scope.own('mount', () => { cancelled = true; mounted?.dispose(); mounted = null }, 'floatingToc')
        void import('./floatingTocSurface').then((m) => {
          if (cancelled) return
          mounted = m.mountPluginFloatingToc(shell, opts)
          if (pendingRefresh) mounted.refresh()
        }).catch((e) => { console.error(`[amadeus] plugin "${pluginId}" Floating TOC mount failed`, e) })
        return {
          refresh: () => {
            if (cancelled) return
            if (mounted) mounted.refresh()
            else pendingRefresh = true
          },
          dispose,
        }
      },
    } } : {}),
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
        // 内存作用域的 pageStore 与 React 树不许在插件死后还活着:插件不卸,关账卸。
        const dispose = scope.own('mount', () => { cancelled = true; disposeMounted?.(); disposeMounted = null }, 'dashboard')
        const mine = cancelled ? () => false : claimHostMount(el) // 已吊销的上下文不许认领:会把新上下文那次请求挤掉
        void import('./dashboardSurface').then((m) => {
          if (cancelled || !el.isConnected || !mine()) { dispose(); return }
          disposeMounted = m.mountPluginDashboard(pluginId, el, o).dispose
        }).catch((e) => { console.error(`[amadeus] plugin "${pluginId}" dashboard mount failed`, e) })
        return dispose
      },
    },
    // 面板里的原生多维表(只读、内存行)。与 dashboard.mount 同款三件套:动态 import 破环、
    // cancelled 标志 + el.isConnected 复检;挂载记在本次激活的账上,关账排空。
    // ⚠️校验**同步**先做:tableSurface 还在飞的时候抛出去,插件才来得及降级(抛进 then 里 = 插件
    // 永远收不到,容器空着还没有报错)。import 落地前来的 update 只换 pending 规格。
    // 宿主没有 DOM(SSR / 台架式 node 环境)时整条省略 —— 哑桩会让插件走进原生分支然后什么都不画。
    ...(typeof document !== 'undefined' ? { table: {
      caps: { fold: true },
      mount: (el: HTMLElement, spec: TableSpec) => {
        validateTableSpec(spec)
        let handle: { update(s: TableSpec): void; dispose(): void } | null = null
        let pending = spec
        let cancelled = false
        // body 级弹层宿主也在这一卸里收,漏了就是页面上一堆空 div。
        const dispose = scope.own('mount', () => { cancelled = true; handle?.dispose(); handle = null }, 'table')
        const mine = cancelled ? () => false : claimHostMount(el) // 已吊销的上下文不许认领:会把新上下文那次请求挤掉
        void import('./tableSurface').then((m) => {
          // 只认 cancelled,**不看 el.isConnected**:面板每次重渲都会把容器掀掉再由 panel-lib 认领回来,
          // import 落地那一刻容器多半正游离着 —— 此时放弃 = 句柄永远为空、容器永远空白且不回落。
          // React 往游离节点上挂根是合法的,认领回 DOM 就显示。
          if (cancelled) return
          if (!mine()) { dispose(); return }
          handle = m.mountPluginTable(pluginId, el, pending)
        }).catch((e) => { console.error(`[amadeus] plugin "${pluginId}" table mount failed`, e) })
        return {
          update: (s: TableSpec) => {
            validateTableSpec(s)
            pending = s
            handle?.update(s)
          },
          dispose,
        }
      },
    } } : {}),
    registerPropertyType: (def) => {
      registerPropType(def)
      // 按身份撤:同 type 后来被别家顶掉了,就别把别家活着的那份摘了。
      scope.own('propertyType', () => { if (getPropertyType(def.type) === def) unregisterPropType(def.type) }, def.type)
      set((s) => ({ propertyTypes: [...s.propertyTypes, { pluginId, item: def }] }))
    },
    // 成就:注册/计数都在 achievements/store 内强制 plugin:<id>: 前缀(防撞官方 id/伪造官方计数)。
    achievements: {
      // 嵌在 ctx.achievements 里(末尾那个按成员名的闸够不着):已停用就不登记;登记了就记账,关账整插件撤。
      registerSeries: (def) => {
        if (!ctxAlive()) return
        registerPluginSeries(pluginId, def)
        scope.ownOnce('achievements', () => unregisterPluginAchievements(pluginId))
      },
      track: (event, n) => { if (ctxAlive()) track(`plugin:${pluginId}:${event}`, n) },
    },
    // 活动日志:同款前缀纪律(插件伪造不了官方事件);拼行/消毒在 main 侧 activityLog.ts。停用后不许再记。
    activity: {
      log: (event, detail) => { if (ctxAlive()) act(`plugin:${pluginId}:${event}`, detail) },
    },
    // 自动化播种:**探针给得出后端配置的宿主才注入**(闸看 waitBackend 在不在,不看 readTangu() 本身:
    // 台架假探针 / 旧宿主没有这条 = 与非 Tangu 宿主同口径,ctx.automation 整个不存在)。
    // 没有本机引擎的宿主(手机)同样不注入 —— 判据见 automationHost。
    // 前缀纪律同 achievements/activity:id 在宿主拼,插件只给 key(见 pluginAutomation.ts)。
    ...(automationHost()
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
            ...(readTangu()?.waitBackend ? {
              request: async (engineId: string, path: string, opts: PluginRequestOptions = {}): Promise<unknown> => {
                if (!ctxAlive()) throw new Error('plugin disabled')
                const owned = get().plugins.find((p) => p.id === pluginId)?.bundle?.enginePlugins ?? []
                const route = pluginRequestPath(pluginId, engineId, path, owned)
                const method = opts.method ?? 'GET'
                if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Invalid request method')
                if (!readTangu()?.hostExecution?.()) throw new Error('A local engine is required')
                const ac = new AbortController()
                const stop = scope.own('request', () => ac.abort(), 'plugin route')
                const onAbort = (): void => ac.abort()
                opts.signal?.addEventListener('abort', onAbort)
                if (opts.signal?.aborted) ac.abort()
                try {
                  const cfg = await readTangu()?.waitBackend?.(15_000)
                  if (!ctxAlive() || ac.signal.aborted) throw new Error('plugin disabled or request cancelled')
                  if (!cfg || !readTangu()?.hostExecution?.()) throw new Error('Local engine is unavailable')
                  const result = await engineJsonRequest(connectionTarget(cfg), route, {
                    method, signal: ac.signal,
                    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
                  })
                  if (!ctxAlive()) throw new Error('plugin disabled')
                  return result
                } finally { opts.signal?.removeEventListener('abort', onAbort); stop.forget() }
              },
            } : {}),
            ...(readTangu()?.openSession ? {
              openSession: async (sessionId: string): Promise<void> => {
                if (!ctxAlive()) return
                if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error('Invalid session ID')
                await readTangu()?.openSession?.(sessionId, ctxAlive)
              },
            } : {}),
            activeModel: () => readTangu()?.activeModel() ?? null,
            models: () => readTangu()?.models() ?? [],
            // Agent 名册(2026-09-20):同 agentStatus 的姿势 —— 调用时才读探针,探针缺这条(旧宿主 /
            // 台架假探针)给空数组,插件据此退回「只认当前会话的 Agent」。
            agents: () => readTangu()?.agents?.() ?? [],
            activeSpace: () => readTangu()?.activeSpace() ?? null,
            session: () => readTangu()?.session?.() ?? null,
            subscribe: (cb: () => void) => scope.own('subscription', readTangu()?.subscribe(cb) ?? (() => {}), 'tangu'),
            // Agent 状态(2026-09-19):调用时才读探针(台架可以事后换探针)。探针缺这条(旧台架)→ 恒 idle,
            // 与契约「缺席按 idle 处理」同口径;省略 sessionId 时此处拿不到 activeId(appStore 有 import 环),报 null。
            agentStatus: (sid?: string | null): TanguAgentStatus => readTangu()?.agentStatus?.(sid) ?? idleAgentStatus(sid ?? null),
            subscribeAgentStatus: (cb: (s: TanguAgentStatus) => void, sid?: string | null): (() => void) => {
              if (!ctxAlive()) return () => {}
              return scope.own('subscription', readTangu()?.subscribeAgentStatus?.(cb, sid) ?? (() => {}), 'agentStatus')
            },
            // 开一个可见的新对话:探针给得出才注入(同 automation 的闸)。放行规则都在这一层:
            //  ① send:true 只对**本插件捆绑包播种的** Agent 生效(清单有 + 播种标记是本插件),别家 Agent /
            //     撞名没播成的 slug 降级为预填、由用户按回车 —— 插件不能替用户花别人的 token、开别家 Agent 的 host 工具;
            //  ② folder(库相对)→ 本机绝对路径走**与 ctx.app.hostPath 同一个函数**:无库 / 非本机执行 /
            //     `..` / 绝对路径 / 盘符 → null → 不带 cwd(用默认工作区),契约是「忽略」而不是报错;
            //  ③ 活性:入口判一次;问归属的 IPC 之后再判一次;探针里等 Agent 名册那一拍由 alive 回调复查(之后才动界面)。
            //     探针返回之后不再有副作用,不需要再判。
            ...(readTangu()?.startChat
              ? {
                  chatSelection: true as const,
                  startChat: async (o: { agent?: string; prompt: string; send?: boolean; folder?: string; modelId?: string; thinkingLevel?: import('../../../../shared/chatBox').ChatBoxSelection['thinkingLevel'] }): Promise<TanguStartChatResult> => {
                    if (!ctxAlive()) return { ok: false, error: 'plugin disabled' }
                    const probe = readTangu()
                    if (!probe?.startChat) return { ok: false, error: 'startChat is not available on this host' }
                    const agent = typeof o?.agent === 'string' ? o.agent.trim() : ''
                    // 「本插件的 Agent」= 清单里有 **且** 引擎当初是从本插件播种的它(主进程比 .bundle-origin 标记)。
                    // 只看清单会放行撞名:同 slug 已存在(用户自建 / xyra / 别家插件先播)时引擎永不覆盖,
                    // 插件却能对别人的 Agent 直发。桥缺这条(web / 移动 / Unit / 台架)或缺标记 → 降级为预填。
                    const listed = !!agent && (get().plugins.find((p) => p.id === pluginId)?.bundle?.agents ?? []).includes(agent)
                    let own = false
                    if (listed && o?.send) {
                      try { own = (await amadeus?.bundleAgentOwned?.(pluginId, agent)) === true } catch { own = false }
                      if (!ctxAlive()) return { ok: false, error: 'plugin disabled' } // 等 IPC 那一拍里被禁用
                    }
                    const folder = typeof o?.folder === 'string' ? o.folder.trim().replace(/[\\/]+$/, '') : ''
                    const cwd = (folder && appApi.hostPath?.(folder)) || undefined
                    return probe.startChat({
                      ...(agent ? { agent } : {}),
                      prompt: String(o?.prompt ?? ''),
                      send: !!o?.send && own,
                      ...(o?.modelId ? { modelId: o.modelId } : {}),
                      ...(o?.thinkingLevel ? { thinkingLevel: o.thinkingLevel } : {}),
                      ...(cwd ? { cwd } : {}),
                      alive: ctxAlive,
                    })
                  },
                }
              : {}),
            // 把原生对话挂进插件自己的视图(2026-10-04):探针给得出才注入。与 startChat 的**预填档**同一条放行口径 ——
            //  ① 永不替用户送出(句柄只有 quote / prefill:引用条与输入框草稿,回车由用户按),所以 Agent 不设「必须是自家捆绑」那道闸,
            //     名册里有就行(不存在 → ready 给 ok:false);
            //  ② folder(库相对)→ 本机绝对路径走 ctx.app.hostPath(同 startChat),但**等后端就绪后才解析**(探针调 resolveCwd):
            //     给了 folder 却解析不出来 → ready 给 ok:false,不悄悄落成沙箱对话(常驻对话接错目录比开不了更糟);
            //  ③ 禁用 / 重载时宿主把挂载收掉(scope),此后 quote / prefill 不再生效。
            ...(readTangu()?.mountChat
              ? {
                  mountChat: (el: HTMLElement, o?: { agent?: string; folder?: string; title?: string }): import('./tanguSeam').TanguChatMount => {
                    if (!(el instanceof HTMLElement)) throw new TypeError('mountChat needs an HTMLElement')
                    const probe = readTangu()
                    if (!ctxAlive() || !probe?.mountChat) return { ready: Promise.resolve({ ok: false, error: 'plugin disabled' }), quote() {}, prefill() {}, dispose() {} }
                    const agent = typeof o?.agent === 'string' ? o.agent.trim() : ''
                    // 去掉尾巴上的分隔符;整个就是分隔符的(`/`)原样留着,交给 hostPath 判不合法 → 接不上,而不是当成「没给文件夹」
                    const given = typeof o?.folder === 'string' ? o.folder.trim() : ''
                    const folder = given.replace(/[\\/]+$/, '') || given
                    const title = typeof o?.title === 'string' ? o.title.trim().slice(0, 120) : ''
                    const mounted = probe.mountChat(el, {
                      owner: pluginId, ...(agent ? { agent } : {}), ...(title ? { title } : {}),
                      ...(folder ? { folder, resolveCwd: () => appApi.hostPath?.(folder) ?? null } : {}),
                    })
                    const dispose = scope.own('mount', () => mounted.dispose(), 'chat')
                    return { ready: mounted.ready, quote: (text) => { if (ctxAlive()) mounted.quote(text) }, prefill: (text) => { if (ctxAlive()) mounted.prefill(text) }, dispose }
                  },
                }
              : {}),
            // 一次性补全(G3-07):探针给得出才注入。插件停用 → 关账中止在飞请求并 reject。
            ...(readTangu()?.complete
              ? {
                  complete: async (req: { prompt: string; selection?: string; before?: string; after?: string; signal?: AbortSignal; onDelta?: (delta: string) => void }): Promise<{ text: string }> => {
                    if (!ctxAlive()) throw new Error('plugin disabled')
                    const probe = readTangu()
                    if (!probe?.complete) throw new Error('complete is not available on this host')
                    const prompt = typeof req?.prompt === 'string' ? req.prompt.trim() : ''
                    if (!prompt) throw new Error('ctx.tangu.complete: prompt is required')
                    const ac = new AbortController()
                    const stop = scope.own('request', () => ac.abort(), 'complete')
                    const outer = req.signal
                    const onOuter = (): void => ac.abort()
                    outer?.addEventListener('abort', onOuter)
                    if (outer?.aborted) ac.abort()
                    try {
                      const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
                      const r = await probe.complete({ action: 'custom', instruction: prompt, selection: str(req.selection), before: str(req.before), after: str(req.after) }, {
                        signal: ac.signal,
                        onDelta: (d) => { if (ctxAlive()) { try { req.onDelta?.(d) } catch { /* 插件回调抛错不打断流 */ } } },
                      })
                      if (!ctxAlive()) throw new Error('plugin disabled')
                      return { text: r.text }
                    } finally {
                      outer?.removeEventListener('abort', onOuter)
                      stop.forget()
                    }
                  },
                }
              : {}),
          },
        }
      : {}),
    ...agentSurface(),
    // Agent Desk 伴随面(2026-09-19):**只在有 Agent Desk 的宿主上注入** —— 桌面 Tangu。判据与 ChatView 的
    // deskEnabled 同源:探针在(Tangu 宿主)+ 端判定单源 currentPlatform() === 'desktop'(web 的 getConfig 没有
    // agentDeskEnabled,Desk 永不出现)+ 不是单列移动壳。用户在设置里关了 Desk 不影响注入(注册照常成功,只是不显示)。
    // 生效者与模式由 deskCompanion 注册表管;登记即记账,关账(禁用/重载/setup 抛错)统一 revokeDeskCompanions。
    ...(readTangu() && currentPlatform() === 'desktop' && UI_MODE !== 'mobile'
      ? {
          desk: {
            registerCompanion: (def: DeskCompanionContribution): DeskCompanionHandle => {
              if (!ctxAlive()) {
                console.warn(`[amadeus] 插件 ${pluginId} 已停用,ctx.desk.registerCompanion 被忽略`)
                return { update: () => {}, dispose: () => {} }
              }
              const h = registerDeskCompanion(pluginId, def)
              scope.ownOnce('deskCompanion', () => revokeDeskCompanions(pluginId))
              // 旧一代 handle 变哑:同 key 重新启用后注册的是新条目,残留的异步回调不许改它的模式或把它撤掉。
              return {
                update: (patch) => { if (ctxAlive()) h.update(patch) },
                dispose: () => { if (ctxAlive()) h.dispose() },
              }
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
    // 吊销之后的 register* 一律作废。`async setup` 在 await 之后才登记命令 / 视图是常见写法,而 Sandbox 让
    // 「setup 还没跑完就被重载 / 卸载」成了家常便饭(每次保存一次):上一代的续体醒来照样往 store 里塞贡献 ——
    // 重载时同一条命令出现两份(旧的那份跑的还是旧代码),卸载后则成了没人收的幽灵,直到重启窗口。
    // 就地换掉成员而不是套 Proxy:插件在 setup 开头解构 ctx,拿到的也是这一层。
    const members = ctx as unknown as Record<string, unknown>
    for (const key of Object.keys(members)) {
      const fn = members[key]
      if (!key.startsWith('register') || typeof fn !== 'function') continue
      members[key] = (...args: unknown[]): unknown => {
        if (ctxAlive()) return (fn as (...a: unknown[]) => unknown)(...args)
        console.warn(`[amadeus] 插件 ${pluginId} 已停用 / 已重载,ctx.${key} 被忽略`)
        return DEAD_HANDLE
      }
    }
    return ctx
  }

  /** 拆一个插件(不碰偏好):先跑它自己的 disposer(此时 ctx 还活着,收尾要用),再关账 —— 判死、杀 facade、
   *  后进先出逐条撤宿主环境里的副作用、每条各自 try/catch —— 最后一次 set 摘掉它在各切片里的贡献。 */
  const teardown = (id: string): void => {
    agentLive.delete(id) // 拆掉了就不再是「正在运行的那一版」(agentSpaceSourceUrl)
    try {
      get().disposers[id]?.()
    } catch (e) {
      console.error(`[amadeus] plugin "${id}" dispose failed`, e)
    }
    liveScopes.get(id)?.close()
    liveScopes.delete(id)
    lastEnsure.delete(id) // 旧规则集不随重新启用被重放;再启用时插件自己 setup 里会重新 ensure
    set((s) => ({
      ...dropSlices(s, id),
      activeIds: s.activeIds.filter((x) => x !== id),
      disposers: { ...s.disposers, [id]: undefined },
    }))
  }

  /** 拆这几个连同它们正在跑的依赖方,按依赖倒序:依赖方先停,它收尾时前置还活着(收尾要经前置落盘的不丢)。
   *  前置离场的每条路(停用 / 消失 / 换代 / 异步失败 / 来源读不到)都走这里,别再单拆前置。 */
  const stopWithDependents = (ids: string[]): void => {
    const s = get()
    const drop = new Set(ids.flatMap((id) => [id, ...dependentsOf(id, s.plugins).map((d) => d.id)]))
    for (const p of topoOrder(s.plugins).reverse()) if (drop.has(p.id) && get().activeIds.includes(p.id)) teardown(p.id)
  }

  /** 激活(调用方已判过门禁 / 偏好 / 前置),返回是否成功。setup 同步抛错 → 当场回滚成没装过的样子并记错因。
   *  async setup:同步那段返回即算激活;交回的 disposer 落定时这一代还活着就装上、已过期就当场调用;
   *  reject 且这一代还活着 → 与同步抛错同一条回滚,再对齐一轮(依赖它的跟着停)。过期那一代的结果一律不认。 */
  const start = (plugin: AmadeusPlugin): boolean => {
    const id = plugin.id
    // 标准设置行:每个插件自动获得「工作文件夹」(ctx.app.workFolder() 的数据源;
    // 插件在 setup 里自注册同 key 会覆盖本行,见 registerSetting 的去重)。拆 / 失败按 pluginId 一并收走。
    set((s) => ({ settings: [...s.settings, { pluginId: id, item: workFolderSetting(plugin.name, id) }] }))
    const ctx = makeContext(id)
    const scope = liveScopes.get(id)!
    const fail = (e: unknown): void => {
      console.error(`[amadeus] plugin "${id}" setup failed`, e)
      useUiStore.getState().notify(translate('pluginhost.setupFailed', { name: plugin.name }))
      teardown(id)
      // 只有主窗的失败才收走全局外观:插件在 Mini / 独立窗里起不来,不等于它在主窗也没了。
      if (windowKind() === 'main') clearPluginAppearance(id)
      set((s) => ({ lastSetupError: { ...s.lastSetupError, [id]: String((e as { message?: unknown } | null)?.message ?? e).slice(0, 600) } }))
    }
    let r: ReturnType<AmadeusPlugin['setup']>
    try {
      r = plugin.setup(ctx)
    } catch (e) {
      fail(e)
      return false
    }
    if (r && typeof (r as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(r).then((d) => {
        if (typeof d !== 'function') return
        if (scope.alive()) set((s) => ({ disposers: { ...s.disposers, [id]: d } }))
        else try { d() } catch (e) { console.error(`[amadeus] plugin "${id}" stale disposer failed`, e) }
      }, (e: unknown) => {
        if (!scope.alive()) return // 上一代迟到的失败,不许把已经装好的下一代标成失败
        stopWithDependents([id]) // 同步那段一返回就算激活,依赖方可能已经起来了
        fail(e)
        reconcile()
      })
    }
    set((s) => ({
      activeIds: [...s.activeIds, id],
      disposers: { ...s.disposers, [id]: typeof r === 'function' ? r : undefined },
      lastSetupError: { ...s.lastSetupError, [id]: undefined as unknown as string },
    }))
    // locked 包:旧开关拨下的「关」留在 localStorage 里没意义(它跟主进程开关走),跑起来就顺手擦掉。
    if (plugin.locked && get().disabledIds.includes(id)) {
      set((s) => ({ disabledIds: s.disabledIds.filter((x) => x !== id) }))
      writeDisabled(get().disabledIds)
    }
    // 上一轮停用留下的「待停用」欠账作废:插件又跑起来了,再让边沿去关它的规则就是倒着走。
    pendingDisable.delete(id)
    pendingRulesOff.delete(id)
    return true
  }

  /** 这一刻该跑的集合:按依赖顺序走一遍,前置也在集合里才算齐。 */
  const desiredIds = (order: AmadeusPlugin[]): Set<string> => {
    const s = get()
    const want = new Set<string>()
    for (const p of order) {
      if (p.blocked || !pluginWanted(p, s.disabledIds) || s.lastSetupError[p.id]) continue
      if (!unmetDependencies(p, s.plugins, (x) => want.has(x), () => true).length) want.add(p.id)
    }
    return want
  }

  /** 对齐(对标 Cordis 的「空间维」):让「正在跑的」=「没被挡 ∧ 用户想开 ∧ 没挂着失败 ∧ 前置都在跑」。
   *  先按依赖倒序停(依赖方先停,它收尾时前置还在),再按依赖顺序起(前置先起)。起失败了重算一轮(它的依赖方不能起)。
   *  失败过的不自动重试(等用户重开 / 重载清掉错因),否则一个坏插件每次对齐都报一遍错。 */
  const reconcile = (): void => {
    for (let round = 0; round <= get().plugins.length; round++) {
      const order = topoOrder(get().plugins)
      const want = desiredIds(order)
      let changed = false
      for (const p of [...order].reverse()) {
        if (get().activeIds.includes(p.id) && !want.has(p.id)) { teardown(p.id); changed = true }
      }
      for (const p of order) {
        if (!want.has(p.id) || get().activeIds.includes(p.id)) continue
        changed = true
        if (!start(p)) break
      }
      if (!changed) break
    }
    afterReconcile()
  }

  /** 按来源列表对齐插件表(only = 只动这一个 id):没了的拆掉丢弃;代码与运行身份没变的只刷元数据 —— 不拆不装,
   *  开着的标签页不动(装一个插件不再关掉别的插件的标签页);变了的、或上次加载失败的拆旧换新。最后对齐一轮。 */
  const applySources = (sources: ExternalPluginSource[], only?: string, force = false): void => {
    const s0 = get()
    const keep = (cur: AmadeusPlugin, src: ExternalPluginSource | undefined): src is ExternalPluginSource =>
      !!src && !force && sameRuntime(cur, src) && !s0.lastSetupError[cur.id]
    // 没了的、换代的先连同正在跑的依赖方拆:依赖方手里攥着的是前置旧那一代,得跟着重起(对齐那轮再按依赖顺序起回来)。
    stopWithDependents(s0.plugins.filter((p) => !p.builtin && (only === undefined || p.id === only)
      && !keep(p, sources.find((x) => x.id === p.id))).map((p) => p.id))
    const seen = new Set<string>()
    const next: AmadeusPlugin[] = []
    const reset: string[] = []
    for (const cur of s0.plugins) {
      seen.add(cur.id)
      if (cur.builtin || (only !== undefined && cur.id !== only)) { next.push(cur); continue }
      const src = sources.find((x) => x.id === cur.id)
      if (keep(cur, src)) {
        next.push({ ...pluginMeta(src), setup: cur.setup })
        continue
      }
      reset.push(cur.id)
      if (src) { next.push(toPlugin(src)); continue }
      loadedCode.delete(cur.id)
      dropDevRecords(cur.id) // 来源整个没了 → 连开发态记账一起丢
      // 卸掉了:它种在引擎里的规则不许成为没人管的孤儿(只主窗发;同 id 很快又装回来,它的 setup 会 ensure 回去)。
      if (windowKind() === 'main' && automationHost()) {
        void disablePluginRules(cur.id).catch((e) => console.warn(`[amadeus] plugin "${cur.id}" 停用自动化规则失败`, e))
      }
    }
    for (const src of sources) {
      if (seen.has(src.id) || (only !== undefined && src.id !== only)) continue
      reset.push(src.id)
      next.push(toPlugin(src))
    }
    set((s) => {
      const lastSetupError = { ...s.lastSetupError }
      for (const id of reset) delete lastSetupError[id]
      return { plugins: next, lastSetupError }
    })
    reconcile()
  }

  return {
    plugins: [],
    disabledIds: [],
    activeIds: [],
    slashItems: [],
    selectionActions: [],
    commands: [],
    themes: [],
    panels: [],
    statusItems: [],
    propertyTypes: [],
    settings: [],
    settingsViews: [],
    storeViews: [],
    readiness: [],
    views: [],
    listSources: [],
    fileTypes: [],
    embedRenderers: [],
    fileCreators: [],
    viewOpener: null,
    viewLocations: null,
    setViewOpener: (fn, locations) => set({ viewOpener: fn, viewLocations: fn ? locations ?? ['main', 'left', 'right'] : null }),
    viewControls: null,
    setViewControls: (controls) => set({ viewControls: controls }),
    disposers: {},
    lastSetupError: {},
    initialized: false,

    isActive: (id) => get().activeIds.includes(id),

    init(plugins = BUILTIN_PLUGINS) {
      if (get().initialized) return
      set({ plugins: [...plugins], disabledIds: readDisabled(), initialized: true })
      reconcile()
    },

    enable(id) {
      const plugin = get().plugins.find((p) => p.id === id)
      if (!plugin || plugin.blocked) return // 门禁挡下的插件(apiVersion/minAppVersion 不符)任何路径都不得激活
      if (unmetPluginDeps(plugin).length) return // 前置没齐:装着但开不了(设置页给原因与「安装 / 启用前置」入口)
      // 注:DISABLED_KEY 是按 id 的单一全局列表;listPlugins 已按 vault 优先去重,每 id 只有一实例,一位开关即正确。
      noteExplicitEnable(id) // 用户重开 = 重试
      try {
        localStorage.setItem(PLUGIN_ENABLE_STAMP_KEY, JSON.stringify({ id, t: Date.now() })) // 先于偏好:别的窗口先收到戳
      } catch {
        /* ignore */
      }
      set((s) => ({ disabledIds: s.disabledIds.filter((x) => x !== id) }))
      writeDisabled(get().disabledIds)
      reconcile()
    },

    disable(id) {
      const plugin = get().plugins.find((p) => p.id === id)
      const wasOn = !!plugin && (get().activeIds.includes(id) || pluginWanted(plugin))
      if (!get().disabledIds.includes(id)) set((s) => ({ disabledIds: [...s.disabledIds, id] }))
      writeDisabled(get().disabledIds)
      const before = get().activeIds
      reconcile() // 依赖它的先停,再停它
      // 连带停掉的依赖方也要收:它们的预设已撤,选中的图标 / 开屏不能留着。
      for (const stopped of new Set([id, ...before])) if (!get().activeIds.includes(stopped)) clearPluginAppearance(stopped)
      // 用户明确禁用 → 它种下的自动化规则一并停(只此一条路;非 Tangu 宿主没有探针就没有规则可关)。
      if (wasOn && automationHost()) {
        void disablePluginRules(id).catch((e) => console.warn(`[amadeus] plugin "${id}" 停用自动化规则失败`, e))
      }
    },

    syncDisabledPreferences() {
      // 别的窗口拨了开关:只对齐本窗的实例,不重放用户侧的自动化动作(那边已经做过)。
      // locked 包不跟 localStorage(pluginWanted),别的窗口拨了它本窗也不拆装 —— 它的开关到重启才生效。
      set({ disabledIds: readDisabled() })
      reconcile()
    },

    toggle(id) {
      const plugin = get().plugins.find((p) => p.id === id)
      if (!plugin) return
      // 按意图翻:在等前置 / 加载失败的插件开关是「开」的,再点一下是关掉它
      if (pluginWanted(plugin)) get().disable(id)
      else get().enable(id)
    },

    // ponytail: 与 reloadOne 不串行。窗口启动这一拍恰逢别的窗口撤掉开发态授权时,这里晚到的旧名单会把刚撤的开发副本
    //   再装回本窗口(到它下一次重载为止;主进程那边授权已撤,重启 / 重载后不会再回来)。要治就给来源变更加 epoch、过期名单重读。
    async loadExternal() {
      let sources: ExternalPluginSource[] = []
      try {
        sources = await resolveExternalSources()
      } catch {
        return // 读不到来源 ≠ 来源都没了:保持现状
      }
      applySources(sources)
      const appearance = useAppearance.getState().value
      for (const asset of [appearance.icon, appearance.splash]) {
        if (asset?.pluginId && !get().activeIds.includes(asset.pluginId)) clearPluginAppearance(asset.pluginId)
      }
    },

    reloadExternal() {
      return get().loadExternal()
    },

    reloadOne(id, opts) {
      // 同一个 id 的重载**串行**:发起加载的窗口会同时收到「自己那次显式重载」与「主进程的全窗广播」,两个并发的
      // reloadOne 各自 teardown + 装载,谁后落定谁赢,setup 还会白跑两遍(check:sandbox 五跑一红就是它)。
      const run = async (): Promise<void> => {
        let sources: ExternalPluginSource[] = []
        try {
          sources = await resolveExternalSources()
        } catch (e) {
          if (!opts?.strict) return
          const stale = get().plugins.find((p) => p.id === id)
          if (stale?.dev) { // fail closed:读不到来源 ≠ 来源还在
            stopWithDependents([id])
            loadedCode.delete(id)
            set((s) => ({ plugins: s.plugins.filter((p) => p.id !== id) }))
            reconcile() // 依赖它的跟着停
          }
          throw e
        }
        if (get().plugins.find((p) => p.id === id)?.builtin) return // 内置插件不是磁盘来源,没有「重读」可言
        // 来源身份也算运行身份(sameRuntime):刚从安装版复制出来的开发副本,代码可以与安装版一字不差 ——
        // 只比代码的话「在 Forsion 中加载」开了等于没开,撤下开发副本后它也永远拆不掉。
        applySources(sources, id, !!opts?.force)
        if (!get().activeIds.includes(id)) clearPluginAppearance(id)
      }
      const next = (reloadChains.get(id) ?? Promise.resolve()).then(run, run)
      const guard = next.catch(() => {}).then(() => { if (reloadChains.get(id) === guard) reloadChains.delete(id) })
      reloadChains.set(id, guard)
      return next
    },

    openPluginsFolder() {
      void amadeus.openPluginsFolder()
    },

    // 只有设置页「新建示例插件」按钮调它:结果走设置页提示条(Amadeus 吐司只有主窗渲染,设置住在独立浮窗)。
    async scaffoldSample() {
      try {
        await amadeus.scaffoldSamplePlugin()
      } catch (e) {
        panelToast(String(e), true)
        return
      }
      await get().reloadExternal()
      panelToast(translate('pluginhost.sampleCreated'))
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

// ── 默认打开方式(设置 → 插件 → 已安装):可覆盖的内置后缀 → 'builtin' | 插件 id。
//    没记、或记的插件此刻不在候选里(停用 / 卸载了)= 自动:有插件接管就归它(先注册的那个),否则内置。
//    偏好读进模块级缓存:findFileType 到处被同步调用,不能每次去读 localStorage。
export const FILE_OPENERS_KEY = 'amadeus.fileOpeners'
export const BUILTIN_OPENER = 'builtin'
function readFileOpeners(): Record<string, string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(FILE_OPENERS_KEY) || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, string> : {}
  } catch {
    return {}
  }
}
let fileOpeners = readFileOpeners()
/** 换一个 fileTypes 数组引用:订阅它的组件(文件树、右键菜单、文件视图、设置页)据此重算 findFileType。 */
const bumpFileTypes = (): void => usePluginStore.setState((st) => ({ fileTypes: [...st.fileTypes] }))
/** 设置某个可覆盖后缀的默认打开方式;`''` = 自动。 */
export function setFileOpener(ext: string, pick: string): void {
  const next = { ...fileOpeners }
  if (pick) next[ext] = pick
  else delete next[ext]
  fileOpeners = next
  try { localStorage.setItem(FILE_OPENERS_KEY, JSON.stringify(next)) } catch { /* 存不下就只在本次运行生效 */ }
  bumpFileTypes()
}
/** 别的窗口改了偏好(storage 事件):重读并让本窗跟上。 */
export function syncFileOpeners(): void {
  fileOpeners = readFileOpeners()
  bumpFileTypes()
}
type OwnedFileType = { item: FileTypeContribution; pluginId?: string }
/** 显式写了 override、且后缀对得上这个(小写)路径的贡献,按注册先后。 */
const overriders = (list: OwnedFileType[], lowerPath: string): OwnedFileType[] =>
  list.filter((o) => o.item.override === true && o.item.extensions.some((e) => lowerPath.endsWith(e.toLowerCase())))
/** 设置页用:接管了 ext 的插件(启用中的)与当前选择。存着的选择对不上候选时按自动报,下拉框不会吃到匹配不上的值。 */
export function fileOpenerChoice(list: OwnedFileType[], ext: string): { pick: string; pluginIds: string[] } {
  const pluginIds = [...new Set(overriders(list, `x${ext}`).map((o) => o.pluginId).filter((id): id is string => !!id))]
  const stored = fileOpeners[ext] ?? ''
  return { pick: stored === BUILTIN_OPENER || pluginIds.includes(stored) ? stored : '', pluginIds }
}

/** 在给定 fileTypes 列表里按路径后缀找命中的文件类型贡献(便于组件订阅列表后调用)。
 *  内置文件类型的后缀不放行(生态硬规则,见 isBuiltinFileType):遮蔽内置 = 用户打不开内置视图。
 *  例外只有「可覆盖」的那几个后缀(isOverridableBuiltinType),而且只认显式写了 override: true 的贡献 ——
 *  命中即视为插件接管了「打开这个文件」,内置视图退为兜底。由谁打开听「默认打开方式」(见上)。 */
export function findFileType(
  list: OwnedFileType[],
  path: string,
): FileTypeContribution | undefined {
  const n = path.toLowerCase()
  const claims = (o: OwnedFileType): boolean => o.item.extensions.some((ext) => n.endsWith(ext.toLowerCase()))
  if (isBuiltinFileType(path)) {
    // 绝对路径 = 库外文件(聊天引用里的本机 PDF):插件只读得到库内路径,一律留给内置阅读器。
    if (!isOverridableBuiltinType(path) || isHostPath(path)) return undefined
    const ext = OVERRIDABLE_BUILTIN_SUFFIXES.find((e) => n.endsWith(e))!
    const pick = fileOpeners[ext]
    if (pick === BUILTIN_OPENER) return undefined
    const cands = overriders(list, n)
    return (cands.find((o) => o.pluginId === pick) ?? cands[0])?.item
  }
  return list.find(claims)?.item
}

/** 当前已注册文件类型里匹配 path 的那个(读快照,非响应式)。 */
export function matchFileType(path: string): FileTypeContribution | undefined {
  return findFileType(usePluginStore.getState().fileTypes, path)
}

/** 文件名去掉命中的文件类型后缀(如 `思维导图.mindmap.md` + ['.mindmap.md'] → `思维导图`);兜底剥最后一段扩展名。 */
export function fileTypeBaseName(path: string, extensions: string[]): string {
  const name = path.split(/[\\/]/).pop() || path
  // 被插件覆盖的内置类型(.pdf)照内置的叫法带着后缀:树上的行、标签页、最近使用里它一直是「书.pdf」,
  // 不能因为换了谁来打开就改名(插件一停一启,名字跟着来回变)。
  if (isBuiltinFileType(path)) return name
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
