// The IPC contract shared by main (handlers), preload (bridge), and renderer (consumer).
import type { LoadedPage, PageManifest } from './compiler/types'
import type { DbFile } from './db/schema'
import type { MdMark } from './mdMarks'
import { isDesktopPermissionId, type DesktopPermissionId } from '../desktopPermissions'

export const IPC = {
  openVault: 'vault:open',
  restoreVault: 'vault:restore',
  listPages: 'vault:list',
  listFiles: 'vault:files',
  loadPage: 'page:load',
  readPage: 'page:read',
  newPage: 'page:new',
  savePage: 'page:save',
  renamePage: 'page:rename',
  reconcilePage: 'page:reconcile',
  saveAsset: 'asset:save',
  saveVaultBytes: 'vault:save-bytes',
  readVaultBytes: 'vault:read-bytes',
  saveAttachment: 'attachment:save',
  openAttachment: 'attachment:open',
  copyAttachment: 'attachment:copy',
  openVaultFile: 'vault:open-file',
  exportPdf: 'page:export-pdf',
  exportCsv: 'db:export-csv',
  externalChange: 'page:external-change',
  search: 'vault:search',
  backlinks: 'vault:backlinks',
  exclusiveAssets: 'vault:exclusive-assets',
  reindex: 'vault:reindex',
  listTags: 'vault:tags',
  listMarks: 'vault:marks',
  patchMark: 'vault:patch-mark',
  pagesByTag: 'vault:tag-pages',
  deletePage: 'page:delete',
  movePage: 'page:move',
  resolveEmbed: 'embed:resolve',
  blockBacklinks: 'embed:backlinks',
  listFolders: 'vault:folders',
  createFolder: 'folder:create',
  renameFolder: 'folder:rename',
  deleteFolder: 'folder:delete',
  moveFolder: 'folder:move',
  trashEntry: 'trash:put',
  listTrash: 'trash:list',
  restoreTrash: 'trash:restore',
  deleteTrashEntry: 'trash:delete',
  emptyTrash: 'trash:empty',
  pageIcons: 'vault:page-icons',
  pageAliases: 'vault:page-aliases',
  unlinkedMentions: 'vault:unlinked-mentions',
  linkMention: 'vault:link-mention',
  fetchLinkMeta: 'web:link-meta',
  searchImages: 'web:search-images',
  structureChange: 'vault:structure-change',
  /** 渲染层的路径广播(改名 / 挪走 / 删除)跨窗口转发:渲染层 invoke 进主进程,主进程转给**其它**窗口。 */
  pathGone: 'vault:path-gone',
  listPlugins: 'plugins:list',
  openPluginsFolder: 'plugins:open-folder',
  scaffoldPlugin: 'plugins:scaffold',
  uninstallPlugin: 'plugins:uninstall-forsion',
  bundleAgentOwned: 'plugins:bundle-agent-owned',
  revealInFileManager: 'shell:reveal',
  dbRead: 'db:read',
  dbWrite: 'db:write',
  dbWriteCas: 'db:write-cas',
  dbChange: 'db:external-change',
  drawingRead: 'drawing:read',
  drawingWrite: 'drawing:write',
  // 通用 vault 文本文件读写(供插件文件类型 ctx.app.readFile/writeFile;写走自写账本防 watcher 回弹)。
  readTextFile: 'file:read-text',
  writeTextFile: 'file:write-text',
  /** 外部改动了 vault 里的**非 .md / 非 .db** 文件(附件、片段 .js…)→ ctx.app.watchFile 的数据源。 */
  fileChange: 'file:external-change',
  /** 每插件一份 JSON blob(~/.forsion/plugins-data/<id>.json);ctx.loadData/saveData 的落点。 */
  pluginDataRead: 'plugins:data-read',
  pluginDataWrite: 'plugins:data-write',
  setPageFrontmatter: 'page:set-frontmatter',
  listPageProps: 'vault:page-props',
  renamePageFile: 'page:rename-file',
  renameDbFile: 'db:rename-file',
  /** 页面版本历史(评审 C-20):快照存在库外(主进程 tanguDataDir()/amadeus-history),只有桌面主进程实现。 */
  listPageHistory: 'page:history-list',
  readPageHistory: 'page:history-read',
  restorePageHistory: 'page:history-restore',
} as const

/** Plugin API version the host implements. Manifests without apiVersion are treated as 1 (back-compat). */
export const AMADEUS_PLUGIN_API = 1

/** One informational step in a plugin's onboarding card. */
export interface PluginOnboardingStep {
  title: string
  description?: string
}

/** A market item the plugin recommends installing during onboarding (matched by installSlug). */
export interface PluginOnboardingRecommend {
  type: 'skill' | 'agent' | 'plugin' | 'space' | 'theme' | 'amadeus-plugin'
  slug: string
  /** Display name fallback when the item isn't found in the market. */
  name?: string
  /** One-line reason shown next to the item. */
  reason?: string
}

/**
 * A precondition the host can **measure** (2026-09-21+). Only these three kinds exist, on purpose:
 *  - `setting`    — the plugin setting `key` holds a user value (≠ its declared default, not blank).
 *                   Defaults are often placeholders (「示例大日子」「每日习惯」), so "non-empty" would always pass.
 *  - `permission` — an OS grant the host already tracks (see shared/desktopPermissions).
 *  - `check`      — the plugin registers `ctx.registerReadiness({ id, label, check })` and the host calls it.
 *                   Anything the host can't see by itself (a remote server's config, a helper's hardware
 *                   support, a Python module inside the engine's interpreter) goes here — the plugin knows
 *                   its own dependency shape; the host does not learn every plugin's topology.
 * No user-visible text lives here: labels come from the setting's own label, the host's permission
 * names, or the readiness registration — so there is no zh/en pairing to get wrong.
 */
export type PluginRequirement =
  | { kind: 'setting'; key: string }
  | { kind: 'permission'; id: DesktopPermissionId }
  | { kind: 'check'; id: string }

/** Declarative onboarding a plugin ships in its manifest (`onboarding` key).
 *  With `requires`, it is a **gate**: the host measures each requirement, pops the setup card while any
 *  is unmet, badges the plugin, and nudges once via inbox. Without `requires` it is only a **guide**:
 *  shown quietly on the plugin's detail page — no popup, no badge, no nudge (2026-09-21: cards that
 *  gated nothing were read as decoration). */
export interface PluginOnboardingSpec {
  /** One-liner shown at the top of the setup card. */
  intro?: string
  steps?: PluginOnboardingStep[]
  /** true = embed all of the plugin's registered settings in the card; or a list of setting keys. */
  settings?: boolean | string[]
  recommends?: PluginOnboardingRecommend[]
  /** Measurable preconditions; present ⇒ this onboarding is a gate (see PluginRequirement). */
  requires?: PluginRequirement[]
  /** English mirror of the translatable half (2026-08-14+). Chinese stays canonical: anything missing
   *  or malformed here falls back to it field by field, and `steps` is index-aligned with `steps` above
   *  (sanitised in lockstep) so a missing translation can never shift the wrong text onto a step.
   *  `settings`/`recommends` are structural — no English mirror. */
  en?: { intro?: string; steps?: (PluginOnboardingStep | null)[] }
}

const REC_TYPES = new Set(['skill', 'agent', 'plugin', 'space', 'theme', 'amadeus-plugin'])
/** Setting keys and readiness ids share the plugin-id alphabet; anything else is dropped, not coerced. */
const REQ_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** Stable key for one requirement (results map / React key). */
export const requirementKey = (req: PluginRequirement): string =>
  `${req.kind}:${req.kind === 'setting' ? req.key : req.id}`

function sanitizeRequirement(raw: unknown): PluginRequirement | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (r.kind === 'setting' && typeof r.key === 'string' && REQ_ID.test(r.key)) return { kind: 'setting', key: r.key }
  if (r.kind === 'permission' && isDesktopPermissionId(r.id)) return { kind: 'permission', id: r.id }
  if (r.kind === 'check' && typeof r.id === 'string' && REQ_ID.test(r.id)) return { kind: 'check', id: r.id }
  return undefined
}
const str = (v: unknown, cap: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, cap) : undefined

/** Validate + cap a raw manifest `onboarding` value (main process runs this before shipping to the renderer).
 *  Returns undefined when there is nothing renderable — malformed shapes degrade silently, never block the plugin. */
export function sanitizeOnboarding(raw: unknown): PluginOnboardingSpec | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const out: PluginOnboardingSpec = {}
  const intro = str(r.intro, 500)
  if (intro) out.intro = intro
  // 英文镜像与中文**同一趟**消毒:按原始下标配对,中文那步被丢弃时英文那步一并丢弃 ——
  // 各消各的会因为压缩数组让翻译错位到别的步骤上(codex 评审 2026-08-14)。
  const rawEn = (r.en && typeof r.en === 'object' ? (r.en as Record<string, unknown>) : null)
  const rawEnSteps = rawEn && Array.isArray(rawEn.steps) ? rawEn.steps : null
  if (Array.isArray(r.steps)) {
    const steps: PluginOnboardingStep[] = []
    const enSteps: (PluginOnboardingStep | null)[] = []
    r.steps.slice(0, 8).forEach((s, i) => {
      const title = str((s as Record<string, unknown>)?.title, 120)
      if (!title) return
      const description = str((s as Record<string, unknown>)?.description, 500)
      steps.push(description ? { title, description } : { title })
      const e = rawEnSteps ? (rawEnSteps[i] as Record<string, unknown> | undefined) : undefined
      const eTitle = str(e?.title, 120)
      const eDesc = str(e?.description, 500)
      enSteps.push(eTitle ? (eDesc ? { title: eTitle, description: eDesc } : { title: eTitle }) : null)
    })
    if (steps.length) out.steps = steps
    if (steps.length && enSteps.some(Boolean)) out.en = { ...(out.en ?? {}), steps: enSteps }
  }
  const enIntro = str(rawEn?.intro, 500)
  if (enIntro) out.en = { ...(out.en ?? {}), intro: enIntro }
  if (r.settings === true) out.settings = true
  else if (Array.isArray(r.settings)) {
    const keys = r.settings.filter((k): k is string => typeof k === 'string' && !!k).slice(0, 16)
    if (keys.length) out.settings = keys
  }
  if (Array.isArray(r.recommends)) {
    const recs: PluginOnboardingRecommend[] = []
    for (const it of r.recommends.slice(0, 6)) {
      const o = it as Record<string, unknown>
      const type = typeof o?.type === 'string' && REC_TYPES.has(o.type) ? (o.type as PluginOnboardingRecommend['type']) : null
      const slug = str(o?.slug, 64)
      if (!type || !slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) continue
      const rec: PluginOnboardingRecommend = { type, slug }
      const name = str(o?.name, 80)
      const reason = str(o?.reason, 200)
      if (name) rec.name = name
      if (reason) rec.reason = reason
      recs.push(rec)
    }
    if (recs.length) out.recommends = recs
  }
  if (Array.isArray(r.requires)) {
    const seen = new Set<string>()
    const reqs: PluginRequirement[] = []
    // ⚠ 数到 8 条**合法且不重复**的为止,不是「先砍前 8 条再挑」—— 前面塞了重复或坏条目时,
    //   后面真正的前置条件会被静默吃掉,甚至 8 条坏的就把一道闸降级成使用说明。扫描本身有上限,
    //   免得一个超大数组在这里空转。
    for (const it of r.requires.slice(0, 64)) {
      if (reqs.length >= 8) break
      const req = sanitizeRequirement(it)
      if (!req) continue
      const key = requirementKey(req)
      if (seen.has(key)) continue
      seen.add(key)
      reqs.push(req)
    }
    if (reqs.length) out.requires = reqs
  }
  // ⚠ 这里不因「没有 requires」丢弃整条 —— 没有闸的 onboarding 仍是一份使用说明,由渲染层降级成详情页里的
  //   安静区块。判「是不是闸」只看 requires,且只在渲染层看(Unit 设备页的清单是对端消毒的,老对端永远没有
  //   requires,在这里丢会让跨版本设备页整片失去说明)。
  return out.intro || out.steps || out.settings || out.recommends || out.requires ? out : undefined
}

/** An activity event a plugin declares it emits (manifest `events`), for the automation builder's
 *  event catalog. Names are relative — the host prefixes `plugin:<id>:` everywhere they surface. */
export interface PluginEventDecl {
  name: string
  label?: string
}

/** Validate + cap a raw manifest `events` value. Malformed entries drop silently, never block the plugin. */
export function sanitizeEvents(raw: unknown): PluginEventDecl[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: PluginEventDecl[] = []
  for (const it of raw.slice(0, 16)) {
    const o = it as Record<string, unknown>
    const name = str(o?.name, 64)
    // 与引擎活动行事件名正则同口径(允许 . _ - 与数字;冒号留给宿主前缀)
    if (!name || !/^[a-z][a-z0-9._-]*$/.test(name)) continue
    const label = str(o?.label, 80)
    out.push(label ? { name, label } : { name })
  }
  return out.length ? out : undefined
}

/** A Forsion plugin this plugin cannot run without (manifest `requiresPlugins`, 2026-10-02+).
 *  Satisfied only while the prerequisite is installed, not blocked, new enough **and running** —
 *  a plugin whose prerequisites are missing stays installed but never activates; when a prerequisite
 *  goes away its dependents pause and resume on their own once it is back (see pluginDeps.ts). */
export interface PluginDependency {
  /** The prerequisite's plugin id (its manifest id, not the market slug). */
  id: string
  /** Lowest acceptable version, compared with cmpVersion (e.g. "1.2.0"). */
  minVersion?: string
  /** Market install slug (install_slug ≠ id). Present → the host offers a one-click install. */
  market?: string
  /** Display-name fallback while the prerequisite isn't installed (the host only knows its id then). */
  name?: string
}

/** Validate + cap a raw manifest `requiresPlugins` value. Accepts `"id"` shorthands and objects;
 *  malformed entries drop silently (a broken dependency list must not block the plugin from being listed).
 *  A plugin can't require itself; duplicate ids keep the first entry. */
export function sanitizeRequiresPlugins(raw: unknown, selfId?: string): PluginDependency[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: PluginDependency[] = []
  const seen = new Set<string>()
  for (const it of raw.slice(0, 32)) {
    if (out.length >= 8) break
    const o = typeof it === 'string' ? { id: it } : it && typeof it === 'object' ? (it as Record<string, unknown>) : null
    const id = typeof o?.id === 'string' ? o.id.trim() : ''
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || id === selfId || seen.has(id)) continue
    seen.add(id)
    const dep: PluginDependency = { id }
    const minVersion = str(o?.minVersion, 32)
    if (minVersion && /^v?\d+(\.\d+){0,3}$/.test(minVersion)) dep.minVersion = minVersion
    const market = str(o?.market, 64)
    if (market && /^[a-z0-9][a-z0-9-]*$/.test(market)) dep.market = market
    const name = str(o?.name, 80)
    if (name) dep.name = name
    out.push(dep)
  }
  return out.length ? out : undefined
}

/** Engine-side / cross-domain content embedded in a Forsion plugin folder (捆绑包 bundle)。
 *  识别全靠标志文件(tangu-plugin.json / config.toml / SKILL.md / space.json),manifest 无新增字段。
 *  引擎原地加载 tangu-plugins/ 与 skills/、播种 agents/(见 tangu-agent src/plugins/bundles.ts);
 *  spaces/ 由主进程 spaces:list 汇入、渲染层随插件启停显隐。 */
export interface PluginBundleInfo {
  /** 内嵌引擎插件的 manifest id(tangu-plugins/<dir>/tangu-plugin.json;启停级联/引擎列表去重用)。 */
  enginePlugins: string[]
  /** 内嵌 agent slug(agents/<slug>/config.toml;引擎播种一次,卸载插件后保留)。 */
  agents: string[]
  /** 内嵌全局技能 slug(skills/<slug>/SKILL.md;引擎原地扫描)。 */
  skills: string[]
  /** 内嵌 Space slug(spaces/<slug>/space.json;随插件启停显隐,只读不可单独删)。 */
  spaces: string[]
}

/** 需要插件在 manifest 里显式声明才注入的宿主敏感能力(default-deny 白名单)。 */
export type PluginCapability = 'activeWindow'
export const PLUGIN_CAPABILITIES: readonly PluginCapability[] = ['activeWindow']

/** A user (Forsion) plugin discovered under ~/.forsion/plugins/. */
export interface ExternalPluginSource {
  id: string
  /** Canonical (Chinese) display name. **Identity-adjacent**: the default work folder is derived from it,
   *  so it must never change with the UI language — English goes in `nameEn`. */
  name: string
  version: string
  description?: string
  /** English display name (manifest `nameEn`, 2026-08-14+). Shown when the UI is English; missing → `name`. */
  nameEn?: string
  /** English description (manifest `descriptionEn`); missing → `description`. */
  descriptionEn?: string
  /** 包根 icon.png（主进程校验后编码为 data URL）；缺失/坏图时省略，UI 回落默认字形。 */
  iconUrl?: string
  /** The plugin's main JS source; evaluated in the renderer with a `ctx` argument. '' when blocked (never evaluated). */
  code: string
  /** Manifest apiVersion (missing → 1). */
  apiVersion: number
  minAppVersion?: string
  /** Companion app this plugin needs (manifest.requiresApp); only ids in the host KNOWN_APPS table get install UI. */
  requiresApp?: string
  /** Prerequisite Forsion plugins (manifest `requiresPlugins`, sanitized by the main process). */
  requiresPlugins?: PluginDependency[]
  /** 插件声明要用的宿主敏感能力(manifest `capabilities`,白名单外的一律丢)。宿主只给声明过的
   *  插件注入对应的 ctx 接缝——没声明 = 拿不到,不是「拿到了但没用」。目前只有 'activeWindow'。 */
  capabilities?: PluginCapability[]
  /** README.md content from the plugin folder (capped), for the settings detail page. */
  readme?: string
  /** CHANGELOG.md content from the plugin folder (capped), shown as the "更新日志" section on the detail page.
   *  Ecosystem convention: every versioned plugin ships one so users can see what each version changed. */
  changelog?: string
  /** Declarative first-run setup card (manifest `onboarding`, sanitized by the main process). */
  onboarding?: PluginOnboardingSpec
  /** Activity events the plugin declares it emits (manifest `events`, sanitized) — automation builder catalog. */
  events?: PluginEventDecl[]
  /** File suffixes this plugin claims as a custom file type (manifest `fileExtensions`, e.g. ['.mindmap.md']).
   *  The main process excludes these from the page list (listPages) so its compiler never rewrites them
   *  (= corruption); the renderer's registerFileType supplies the matching icon/view/embed behaviour. */
  fileExtensions?: string[]
  /** Present → listed but not loadable: 'api' = apiVersion mismatch, 'minApp' = app too old,
   *  'invalid' = manifest.json missing/broken or main unreadable (agent Space / dev source; reason in `blockedReason`),
   *  'dev-fileext' = dev source declaring `fileExtensions` (see `dev` — the vault's protection only covers the
   *  installed plugins dir, so a dev copy must never mint files the compiler would later rewrite),
   *  'desktopOnly' = manifest `isDesktopOnly: true` on a host that is not the desktop app (Android). */
  blocked?: 'api' | 'minApp' | 'invalid' | 'dev-fileext' | 'desktopOnly'
  blockedReason?: string
  /** Manifest `isDesktopOnly` (Obsidian-style platform flag, 2026-10-02): the plugin relies on desktop-only host
   *  APIs (Electron bridges, local engine, OS shell). Desktop lists and runs it as usual (informational only);
   *  mobile hosts list it as `blocked: 'desktopOnly'`, never evaluate its code and refuse to install it. */
  isDesktopOnly?: boolean
  /** 捆绑包内嵌内容清单(缺省 = 纯 UI 插件)。 */
  bundle?: PluginBundleInfo
  /** 随 App 内置(主进程 builtinPlugins.ts 播种的捆绑包):设置页标「内置」、不给卸载按钮(只能停用)。
   *  ⚠️ 名字不叫 builtin:渲染层 pluginStore 用 `builtin` 区分「代码里注册的内置插件」与外置来源(reload 时按它筛),
   *  播种来的仍是外置来源,只是不可卸载。 */
  preinstalled?: boolean
  /** 内置且带主进程半身(Forsion Extend):主进程半身开机前装载、不能热卸,设置页的开关改的是下次开机装不装(bundleOff)。 */
  locked?: boolean
  /** locked 包下次开机不装主进程半身(桌面配置 disabledBundles)。 */
  bundleOff?: boolean
  /** locked 包的开关自本次开机以来改过 → 重启才生效。 */
  restartPending?: boolean
  /** Agent 自建 Space 插件(2026-09-11):来源 `<tangu>/agents/<slug>/Space/`,id 固定 `agent-<slug>`;不可卸载(关开关即可),
   *  capabilities / fileExtensions / requiresApp / onboarding / bundle 一律不带(没有「用户点安装」这一步授权)。值 = agent slug。 */
  agent?: string
  /** Forsion Sandbox 的**开发态来源**(2026-09-21):托管根 `~/Forsion/Project/<项目>` 里一个开了 `devLoad` 的插件项目。
   *  ⚠️不是隔离沙箱 —— 与已安装插件同权限、同一份真实笔记库,只是「不用装就能跑」;UI 必须如实说明。
   *  只有桌面 IPC 的 listPlugins 带(`opts.dev`):unit 设备页那条自服面绝不能把开发机上的代码发给远端渲染器。 */
  dev?: boolean
  /** dev 来源的项目根(产物 root):Studio 面板显示 / 打开目录用。 */
  devRoot?: string
  /** dev 来源的产物 id(`p_<12hex>`):设置页「卸载开发副本」经 productsUpdate(id, { devLoad: false }) 撤下。 */
  devProductId?: string
  /** dev 来源正遮蔽全局 plugins 目录里的同 id 安装版(撤下开发副本后安装版会回来)。 */
  shadowsInstalled?: boolean
}

/** Semver-ish comparator (copied from lcl/spaces/userSpaces.core.ts — main process has no @lcl alias). */
export function cmpVersion(a: string, b: string): number {
  const pa = String(a).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0)
  const pb = String(b).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}

/** Gate a plugin manifest: apiVersion mismatch → 'api'; app older than minAppVersion → 'minApp'; ok → null. */
export function gatePluginManifest(
  m: { apiVersion?: unknown; minAppVersion?: unknown },
  appVersion: string | null,
): 'api' | 'minApp' | null {
  const api = m.apiVersion === undefined ? 1 : m.apiVersion
  if (api !== AMADEUS_PLUGIN_API) return 'api'
  if (typeof m.minAppVersion === 'string' && m.minAppVersion && appVersion && cmpVersion(appVersion, m.minAppVersion) < 0) return 'minApp'
  return null
}

/** A full-text search hit (computed by the main-process vault index). */
export interface SearchHit {
  path: string
  title: string
  /** A short context window around the match, marker/frontmatter stripped. */
  snippet: string
  /** 1-based line number of the match within the cleaned text. */
  line: number
  score: number
}

/** 反链 / 提及的一处命中(L-16)。line = 清洗文本(剥 fm 与注释)里的 1-based 行号,0 = 属性区;
 *  text = 该行去掉 md 语法后的摘录(links.plainSnippet)。 */
export interface BacklinkHit {
  line: number
  text: string
}

/** A note that links to the active page via a [[wikilink]]. */
export interface BacklinkRef {
  path: string
  title: string
  /** The sentence/line containing the [[link]]. */
  snippet: string
  /** 逐处命中(每行一条,属性区的链接 line=0)。缺 = 旧宿主(云端 / Unit 旧版)只给 snippet。 */
  hits?: BacklinkHit[]
}

/** 未链接提及的一处:raw / occ / col / match 齐全才可一键链接(linkMention 按内容定位,同 patchMark);
 *  缺 = 只展示(该行含字符引用,解码副本与原文列位对不上)。 */
export interface MentionHit extends BacklinkHit {
  /** 清洗文本里的原文整行(未解字符引用)。 */
  raw?: string
  /** 同文行序号(第几条内容等于 raw 的行,口径同 mdMarks.findMarkLine)。 */
  occ?: number
  /** 提及在 raw 里的起始列(UTF-16)。 */
  col?: number
  /** raw 里 [col, col+match.length) 的原文(大小写照原样)。 */
  match?: string
}

/** 提到了本页标题 / 别名、却没加 [[ ]] 的笔记(L-16)。 */
export interface UnlinkedMention {
  path: string
  title: string
  hits: MentionHit[]
}

/** Where a dragged-in attachment is stored (from Tangu notes settings). */
export interface AttachmentOpts {
  /** attachments=<笔记目录>/attachments/;same=与笔记同目录;vault=vault 内固定文件夹(见 folder)。 */
  mode: 'attachments' | 'same' | 'vault'
  /** mode==='vault' 时的 vault 相对文件夹(如 "assets")。 */
  folder: string
}

/** A resolved `![[ ]]` block embed: its owning note + the block's content. */
export interface EmbedResolved {
  /** owning note path, vault-relative (for "edit at source") */
  owner: string
  /** the block's raw markdown content */
  content: string
  /** the block's registered type (default "markdown") */
  type: string
}

/** `db:read` 的结果:错误是数据不是异常(前端按 status 分支渲染,不用 try/catch 猜原因)。 */
/** 写回票据:文件内容的短哈希。渲染端把它随 dbWriteCas 带回,主进程比对不上就拒写 ——
 *  防的是「渲染端 500ms 防抖里握着旧快照,期间引擎/自动化改了同一张表,防抖一落盘把人家整行抹掉」。
 *  云端/移动端桥不提供 version(也没有 dbWriteCas),渲染端据此退回无条件写,行为与从前一致。 */
export type DbReadResult =
  | { status: 'ok'; path: string; data: DbFile; version?: string } // path = 解析后的 vault 相对路径,后续写回用它
  | { status: 'missing' }
  | { status: 'corrupt'; path: string; message: string }

/** `writeTextFile(…, { base })` 的比对交换结果(仅支持 CAS 的宿主、且调用方传了 base 时才有)。
 *  ok:false = 盘上已不是调用方的基线(别的实例 / 窗口 / 外部写者刚写过),本次**没写**;current 是盘上现文。
 *  current:null = 文件已经不在了(写发出之后被别处删除 / 挪走):宿主绝不按旧路径重建,由调用方另存 / 提示。
 *  只带 base 的写才会有它;真新建不带 base。 */
export type TextWriteResult = { ok: true } | { ok: false; current: string | null }

/** `drawing:read` 的结果:同 DbReadResult 的「错误是数据」约定,但只回原文——
 *  解析/序列化是纯函数(shared/amadeus/excalidraw),放渲染端与编辑器同侧,主进程只管字节进出。 */
export type DrawingReadResult =
  | { status: 'ok'; path: string; source: string } // path = 解析后的 vault 相对路径,后续写回用它
  | { status: 'missing' }

/** 「笔记视图」一行的原料:笔记路径 + 标题(= Page Name) + 解析后的 frontmatter 对象。 */
export interface PageProps {
  path: string
  title: string
  fm: Record<string, unknown>
}

/** A tag and how many notes use it. */
/** 书签卡的链接元数据(og 优先;主进程抓取解析,渲染端只消费)。 */
export interface LinkMeta {
  title?: string
  description?: string
  image?: string
  /** 'photo' = og:image/twitter:image 那种真配图;'icon' = apple-touch-icon 这种**方形 logo**
   *  —— 拉进照片位会变形,渲染端必须 contain 居中。缺省(旧数据/无图)按 photo 处理。 */
  imageKind?: 'photo' | 'icon'
  favicon?: string
  siteName?: string
}

/** 库里某路径(kind='prefix' 时含子树)被挪走 / 改名(to=新路径)或删除(to=null)。root = 发起窗口的库根。 */
export interface PathGoneEvent {
  from: string
  kind: 'file' | 'prefix'
  to: string | null
  root: string
}

/** 页面版本历史的一份快照(评审 C-20)。id 不透明(只拿来读 / 恢复);at = 快照时刻(毫秒);size = UTF-8 字节数。 */
export interface PageHistoryEntry {
  id: string
  at: number
  size: number
}

/** 回收站条目:name = .trash 内扁平文件名;original = 删除前的 vault 相对路径。 */
export interface TrashEntry {
  name: string
  original: string
  deletedAt: number
  dir: boolean
}

export interface TagCount {
  tag: string
  count: number
}

export interface VaultInfo {
  root: string
  /** Page paths relative to the vault root, e.g. "main.md", "Notes/ideas.md". */
  pages: string[]
  /** Sub-folder paths relative to the vault root (includes empty folders). */
  folders: string[]
  /** The page that was open last time (if it still exists). */
  lastPage?: string
}

/** The surface exposed on `window.amadeus` by the preload bridge. */
/** 见 AmadeusApi.hostCaps。false = 这个宿主做不了。 */
export interface AmadeusHostCaps {
  /** 在系统文件管理器里显示(桌面才有文件管理器)。 */
  revealInFileManager?: boolean
  /** 导出 PDF(桌面走主进程 printToPDF;网页走浏览器打印)。 */
  exportPdf?: boolean
  /** 用系统程序打开附件(PDF 卡走应用内阅读器,不受此限)。 */
  openAttachment?: boolean
  /** 插件页「打开插件文件夹」与「创建示例插件」(桌面才有能打开的插件目录;Android App 的插件住在应用私有目录)。 */
  pluginsFolder?: boolean
}

export interface AmadeusApi {
  openVault(): Promise<VaultInfo | null>
  /** Re-open the last vault (persisted across launches), or null if none/unavailable. */
  restoreVault(): Promise<VaultInfo | null>
  listPages(): Promise<string[]>
  /** All non-page files (attachments/.db/…), vault-relative — for the vault tree. */
  listFiles(): Promise<string[]>
  loadPage(pagePath: string): Promise<LoadedPage>
  /** 只读加载(模板读取等):不写 lastPage,不算「打开」。 */
  readPage(pagePath: string): Promise<LoadedPage>
  newPage(pagePath: string): Promise<LoadedPage>
  savePage(pagePath: string, manifest: PageManifest, contents: Record<string, string>): Promise<void>
  /** Rename a page (same folder); rewrites manifest + all block sidecars + main.md. */
  renamePage(
    oldPath: string,
    newName: string,
    manifest: PageManifest,
    contents: Record<string, string>,
  ): Promise<{ newPath: string; page: LoadedPage }>
  /** Re-derive the model after an external main.md edit; main reads the new file from disk. */
  reconcilePage(
    pagePath: string,
    prevManifest: PageManifest,
    prevContents: Record<string, string>,
  ): Promise<LoadedPage>
  /** Save a pasted/dropped binary asset under the page's .amadeus/ folder.
   *  Returns the page-folder-relative path, e.g. ".amadeus/img-xyz.png".
   *  onProgress: upload progress (cloud HTTP only; local-disk bridges ignore it — it is an
   *  extra trailing arg their explicit param lists drop, so it never crosses IPC). */
  saveAsset(
    pagePath: string,
    fileName: string,
    bytes: Uint8Array,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<string>
  /** Overwrite an existing vault file in place by its vault-relative path (PDF 批注写回等)。 */
  saveVaultBytes(path: string, bytes: Uint8Array): Promise<void>
  /** Read a vault file's raw bytes by vault-relative path (PDF 阅读器 getDocument({data}) 等;避免自定义
   *  scheme 的跨源 XHR 限制——dev 渲染器是 http://localhost 源,XHR 到 amadeus-asset:// 会被 Chromium 拦)。 */
  readVaultBytes(path: string): Promise<Uint8Array>
  /** Import a dragged-in file to the configured attachment location (keeps its name, de-duped).
   *  Returns the page-relative path (for `[name](rel)` links) + final basename (for `![[base]]`). */
  saveAttachment(
    pagePath: string,
    fileName: string,
    bytes: Uint8Array,
    opts: AttachmentOpts,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<{ pageRel: string; base: string }>
  /** Open an attachment (ref = page-relative path or bare basename) with the OS default app. */
  openAttachment(pagePath: string, ref: string): Promise<void>
  /** Copy an attachment with two clipboard flavours: Forsion gets `reference` markdown back, while
   *  other apps receive the native image/file payload when the desktop platform supports it. */
  copyAttachment?(pagePath: string, ref: string, reference: string): Promise<boolean>
  /** Open an EXACT vault-relative path with the OS default app(树/侧栏用:不做 URL 解码、不做 basename 兜底搜索). */
  openVaultFile(vaultRel: string): Promise<void>
  /** 把当前窗口按 @media print 样式打成 PDF(渲染端先挂好 #amx-print-root 克隆);
   *  弹保存对话框,成功返回保存路径并在文件管理器中显示,取消返回 null。 */
  exportPdf(defaultName: string): Promise<string | null>
  /** 多维表「导出 CSV」:弹保存对话框把 `csv` 文本写盘,成功返回保存路径并在文件管理器中显示,取消返回 null。
   *  **可选**:只有 Electron 桌面端有;web / 移动端的桥没有这一项,渲染层据此降级成浏览器下载或隐藏按钮
   *  (门控与降级口径在 blocks/database/csvExport.ts,已登记进 check:parity)。 */
  exportCsv?(defaultName: string, csv: string): Promise<string | null>
  /** Subscribe to external main.md changes. Returns an unsubscribe function. */
  onExternalChange(cb: (pagePath: string) => void): () => void
  /** Full-text search across the vault (main-process index). */
  search(query: string): Promise<SearchHit[]>
  /** Notes that link to `pagePath` via a [[wikilink]]. */
  backlinks(pagePath: string): Promise<BacklinkRef[]>
  /** 只被 `pagePath` 引用的附件(vault 相对路径),删除笔记时可一并清理;缺 = 该端不支持(云端/旧 preload)。 */
  exclusiveAssets?(pagePath: string): Promise<string[]>
  /** Force a full rebuild of the vault index. */
  reindex(): Promise<void>
  /** All tags in the vault with their note counts. */
  listTags(): Promise<TagCount[]>

  /** 全库正文里带 `@` 时间标记的行(只读投影;主进程索引已持有全文,随 watcher 增量)。 */
  listMarks?(): Promise<MdMark[]>
  /** 按内容定位改写标记行(`raw`+`occ` 见 mdMarks.findMarkLine);找不到 = false,**绝不模糊匹配**。
   *  成功后主进程更索引并广播 externalChange,打开着的编辑器由既有回灌机制接住。 */
  patchMark?(pagePath: string, raw: string, occ: number, next: string): Promise<boolean>
  /** Page paths that carry the given tag. */
  pagesByTag(tag: string): Promise<string[]>
  /** Delete a page and all its sidecar files. */
  deletePage(pagePath: string): Promise<void>
  /** Move a page into another folder ('' = vault root); returns its new path. */
  movePage(pagePath: string, destFolder: string): Promise<string>
  /** Resolve a `![[ ]]` block embed target (by basename) to its content + owning note.
   *  sourcePath = 嵌入所在的笔记(评审 L-15):被嵌笔记按它就近解析(同目录 → .fd 子笔记 → 全库,同 `[[链接]]`),
   *  `![[#标题]]` 的空笔记名也指它。可选:旧宿主 / 旧调用方不传 = 全库第一篇(历史行为)。 */
  resolveEmbed(target: string, sourcePath?: string): Promise<EmbedResolved | null>
  /** Notes that embed the given block basename (for safe-delete warnings). */
  blockBacklinks(target: string): Promise<BacklinkRef[]>
  /** All sub-folders (incl. empty), vault-relative. */
  listFolders(): Promise<string[]>
  /** Create a folder under `parentFolder` ('' = root); returns its vault-relative path. */
  createFolder(parentFolder: string, name: string): Promise<string>
  /** Rename a folder in place; returns its new vault-relative path. */
  renameFolder(folderPath: string, newName: string): Promise<string>
  /** Delete a folder and everything inside it. */
  deleteFolder(folderPath: string): Promise<void>
  /** Move a folder (with its subtree) into another folder ('' = vault root); returns its new vault-relative path. */
  moveFolder(folderPath: string, destFolder: string): Promise<string>
  /** 回收站(可选:桌面实现;缺位的端删除保持不可逆,UI 自适应)。移入 .trash 并记录原位。 */
  trashEntry?(rel: string): Promise<void>
  /** 回收站条目(新→旧)。 */
  listTrash?(): Promise<TrashEntry[]>
  /** 恢复到原位(父目录补建,占位加 " (N)");返回恢复后的相对路径。 */
  restoreTrash?(name: string): Promise<string>
  /** 彻底删除单条。 */
  deleteTrashEntry?(name: string): Promise<void>
  /** 清空回收站。 */
  emptyTrash?(): Promise<void>
  /** 页面版本历史(评审 C-20,可选:只有桌面主进程实现;缺位端 ⋯ 菜单不出「版本历史」,判据单源 amadeus/lib/hostCaps)。
   *  快照由主进程在笔记的比对交换写里用手里的旧文顺手留(同一篇按时间窗最多一份),存在库外,不往智库里写任何东西。
   *  列出 = 新 → 旧。 */
  listPageHistory?(pagePath: string): Promise<PageHistoryEntry[]>
  /** 读一份快照的原文;不在(已被淘汰)→ null。 */
  readPageHistory?(pagePath: string, id: string): Promise<string | null>
  /** 把笔记恢复成某份快照:base = 调用方读到的现文 `textFingerprint`。主进程在同篇写锁内比对 → 先给现文补一份快照
   *  (补不成就不恢复)→ 原子写回;语义同带 base 的 writeTextFile(对不上 / 文件不在 = 不写,回 ok:false)。 */
  restorePageHistory?(pagePath: string, id: string, base: string): Promise<TextWriteResult>
  /** 页面 emoji 图标表(fm icon: 键;可选:桌面索引提供,其余端优雅缺位)。 */
  pageIcons?(): Promise<Record<string, string>>
  /** fm `aliases:` 表(path → 别名;只含设置了的)。`[[` 补全用(L-13);可选:缺位端补全不含别名。 */
  pageAliases?(): Promise<Record<string, string[]>>
  /** 提到 pagePath 的标题 / 别名、却没加 [[ ]] 的笔记(L-16);可选:缺位端反链面板不出这一区。 */
  unlinkedMentions?(pagePath: string): Promise<UnlinkedMention[]>
  /** 把一处未链接提及改写成 `[[inner]]`(按 raw+occ 定位行、再核 col/match,对不上 = false 不写;同 patchMark 的
   *  行级写盘 + externalChange 广播)。可选:缺位端不出「链接」按钮。 */
  linkMention?(pagePath: string, hit: { raw: string; occ: number; col: number; match: string }, inner: string): Promise<boolean>
  /** 抓取链接 og 元数据(书签卡;可选:桌面主进程实现,缺位端卡片降级纯链接)。 */
  fetchLinkMeta?(url: string): Promise<LinkMeta | null>
  /** 封面图搜索(Openverse 免 key;可选:桌面主进程实现,缺位端只留 URL/上传两来源)。 */
  searchImages?(query: string): Promise<Array<{ thumb: string; full: string; author?: string }>>
  /** Subscribe to vault structure changes (pages/folders added/removed). Returns unsubscribe. */
  onStructureChange(cb: () => void): () => void
  /** 把本窗的路径广播转给其它窗口(可选:只有多窗口的桌面宿主有)。 */
  broadcastPathGone?(event: PathGoneEvent): void
  /** 订阅其它窗口转来的路径广播。 */
  onPathGone?(cb: (event: PathGoneEvent) => void): () => void
  /** Subscribe to external `.db` content changes (e.g. the agent editing calendars on disk). Returns unsubscribe. */
  onDbExternalChange(cb: (dbPath: string) => void): () => void
  /** 订阅**非 .md / .db** 文件的外部内容改动(vault 相对路径)。`ctx.app.watchFile` 的底座 ——
   *  插件把片段库写成 `.js` 放在库里,外部编辑器改完要能热重载。可选:非桌面宿主缺位。 */
  onFileExternalChange?(cb: (filePath: string) => void): () => void
  /** 读某插件的私有 JSON blob(不存在 → null)。可选:非桌面宿主缺位,ctx.loadData 降级 null。 */
  readPluginData?(pluginId: string): Promise<string | null>
  /** 原子写某插件的私有 JSON blob。可选:非桌面宿主缺位,ctx.saveData 静默 no-op。 */
  writePluginData?(pluginId: string, text: string): Promise<void>
  /** Discover user plugins under the vault's .amadeus/plugins/ folder. */
  listPlugins(): Promise<ExternalPluginSource[]>
  /** Open the vault's plugins folder in the OS file manager (creating it if needed). */
  openPluginsFolder(): Promise<void>
  /** Write a runnable sample plugin into the plugins folder. */
  scaffoldSamplePlugin(): Promise<void>
  /** 卸载 ~/.forsion/plugins 下的一个 Forsion 插件(按 manifest id 定位目录整删;可选:桌面实现)。 */
  uninstallPlugin?(id: string): Promise<void>
  /** 该 Agent 是不是**这个插件的捆绑包播种的**(引擎新播种时写 agents/<slug>/.bundle-origin = bundle 目录名)。
   *  ctx.tangu.startChat 的 send:true 只认它;可选:只有本机桌面实现,缺席(web / 移动 / Unit / 台架)= 一律降级为预填。 */
  bundleAgentOwned?(pluginId: string, slug: string): Promise<boolean>
  /** Reveal a vault-relative file/folder in the OS file manager (Finder/Explorer), selecting it. */
  revealInFileManager(targetPath: string): Promise<void>
  /** 宿主做不了的 OS 动作(评审 G2-13):对应键**不渲染**(留一个点了没反应的按钮比没有更糟,见 platform-parity)。
   *  可选、向后兼容:缺省 / 缺某键 = 能做(桌面主进程桥全能做,不必声明)。判据单源在渲染层 amadeus/lib/hostCaps.ts。 */
  hostCaps?: AmadeusHostCaps
  /** 解析 `![[xxx.db]]` 目标(basename 或页相对路径,与附件同一解析语义)并读取数据库。 */
  readDatabase(pagePath: string, ref: string): Promise<DbReadResult>
  /** 按 `db:read` 返回的确切 vault 相对路径原子写回(主进程 schema 校验,坏数据拒写)。 */
  writeDatabase(dbPath: string, data: DbFile): Promise<void>
  /** 比对交换写(仅本地 vault 宿主提供;缺席=该宿主没有并发写者,渲染端退回 writeDatabase)。
   *  baseVersion 与磁盘现状不符 → 不写,回 { ok:false } 与磁盘最新 version,由调用方重载+重放。 */
  writeDatabaseCas?(dbPath: string, data: DbFile, baseVersion: string): Promise<{ ok: boolean; version: string }>
  /** Excalidraw 画板(`.excalidraw.md` / 裸 `.excalidraw`)读原文;ref 与附件同一 basename 语义。 */
  readDrawing(pagePath: string, ref: string): Promise<DrawingReadResult>
  /** 按 `drawing:read` 返回的确切 vault 相对路径原子写回(记自写账本,watcher 不把自己的写当外部改动)。 */
  writeDrawing(drawingPath: string, source: string): Promise<void>
  /** 读取 vault 内确切相对路径的 UTF-8 文本(供插件文件类型);越界/不存在返回 null。 */
  readTextFile(path: string): Promise<string | null>
  /** 原子写回 vault 内确切相对路径的 UTF-8 文本(供插件文件类型;记自写账本,同 writeDrawing)。
   *  `create: true` = 新建意图(素文件出生等):云桥据此绕过「本会话见过、现 404 = 别处删了」的重建禁令;
   *  桌面/移动端本地写盘无此区分,忽略。
   *  `base` = 比对交换写(G1-01,同 dbWriteCas 的思路):调用方认为盘上现在的内容的 `textFingerprint`。
   *  支持的宿主(桌面主进程 / 经它的 Unit RPC / web 与移动端的云桥)比对不上就**不写**,回 `{ ok:false, current }`
   *  交调用方回灌或另存冲突副本;文件不在 = 无冲突照写(云桥例外:本会话见过、现已被别处删掉 → 照旧另存 recovered 副本)。
   *  不支持的宿主(分享页)忽略它、照旧无条件写,返回 void —— 调用方一律把 void 当「写成了」。
   *  移动端本地库自 G2-04 复核起支持(按路径串行锁内 读 → 比对 → 写)。
   *  不传 `base` 时所有宿主行为与从前逐字一致。 */
  /** create:true = **仅新建**(原子;优先于 base):已存在 → 不写,{ ok:false, current:<现文> };现文取不到 → current:null
   *  (调用方按「没建成」处理,绝不当成已存在)。建成 → ok:true。桌面 / Unit 主进程 `wx`,移动桥锁内判存在,云桥 seq 0 的 PUT。 */
  writeTextFile(path: string, text: string, opts?: { create?: boolean; base?: string }): Promise<void | TextWriteResult>
  /** 「笔记视图」:列出 folder 直属子级笔记的 path/title/frontmatter(行的实时数据源)。 */
  listPageProps(folder: string): Promise<PageProps[]>
  /** 外科式写笔记 frontmatter(值 = undefined 删该键):保留 amadeus_* 与正文,原子写。 */
  setPageFrontmatter(pagePath: string, patch: Record<string, unknown>): Promise<void>
  /** 同目录纯重命名笔记文件(不加载/不落 v3,外来 .md 不被收编);返回新 vault 相对路径。 */
  renamePageFile(oldPath: string, newBaseName: string): Promise<string>
  /** 同目录重命名 .db 文件:同步回写内部 name(=新 basename)并重写全 vault 的 [[/![[ 引用。
   *  rewrittenPages = 被改写的笔记(主进程已逐页发 externalChange,渲染端对 activePage 仍须显式 reconcile)。 */
  renameDbFile(oldPath: string, newBaseName: string): Promise<{ newPath: string; rewrittenPages: string[] }>
}

declare global {
  interface Window {
    amadeus: AmadeusApi
  }
}
