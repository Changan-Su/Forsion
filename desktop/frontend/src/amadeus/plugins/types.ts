// Public contract for Amadeus plugins. A plugin's setup(ctx) registers contributions
// (slash items, commands, accent themes, sidebar panels, status-bar items) and may return
// a disposer. The host enables built-in plugins on startup; enable/disable is persisted.
// This is the seam that lets the markdown block, themes, slash menu, command palette,
// sidebar, and status bar all be extended uniformly.

import type { ComponentType } from 'react'
import type { PropertyTypeDef } from '../blocks/database/propertyTypes'
import type { PluginOnboardingSpec } from '@amadeus-shared/ipc'

/** A custom multi-dimensional-table (Database) property/column type a plugin can register.
 *  Provides render+edit + a primitive baseType for storage; see blocks/database/propertyTypes. */
export type PropertyTypeContribution = PropertyTypeDef

/** A slash-menu entry a plugin can contribute. */
export interface SlashContribution {
  id: string
  label: string
  hint?: string
  /**
   * 图标。**首选写宿主图标词表里的名字**(`'template'` / `'callout-warning'` / `'pin'` …,
   * 全表见 components/icons 的 PLUGIN_ICONS 与 docs/Function/生态内容制作指南.md)——
   * 宿主会画出和内置项完全同一套 SVG,你的插件项在 slash 菜单里不再是一枚孤零零的 emoji。
   * emoji / `✎` 这类**不是词表键形状**的字符串按字面当字形画,老插件因此零改动照跑,但视觉不统一。
   * 写了个本宿主还不认识的**键名**(形如 `[a-z0-9-]`)则退到该处的兜底图标 —— 不会把键名当文案画出来。
   */
  icon?: string
  /** Section label; defaults to "插件". */
  group?: string
  /** Static markdown scaffold inserted on pick. Omit when using `run`. */
  scaffold?: string
  /**
   * Dynamic pick handler — for entries that must *create something* before inserting, the way the
   * built-in 数据库 / 画板 entries make a new file and then embed it. Do the work, return the markdown
   * to insert (e.g. `![[<folder>/x.mindmap.md]]`); return '' to insert nothing.
   *
   * `folder` is the note's own attachment folder — the same place the built-in entries put their
   * files — so plugin-created files land beside the note instead of the vault root. Prefer embedding
   * by the vault-relative path returned here rather than a bare basename: it resolves regardless of
   * where the note lives. The host awaits this and toasts on failure, so rejections are never silent.
   */
  run?(cx: { pagePath: string; folder: string }): string | Promise<string>
  /** Extra search keywords (zh/en). */
  keywords?: string
}

/** A command surfaced in the command palette (Cmd/Ctrl+K).
 *
 * Navigation only (open a view, switch a panel). Real *actions* — parameterized, headless-able work
 * like "analyze this link" — must NOT be registered as commands: `run(): void` has no parameter slot,
 * and the command table lives in the renderer where the chat agent and automation cannot reach it.
 * Ship such capabilities as engine-side bundle assets instead (`agents/<slug>/` + `skills/`) — the
 * agent invokes them via `delegate(agentSlug)`, automation via the `agent_run` action.
 * (2026-08-24 引擎原生路拍板; pattern: the bluebird workbench UI stays renderer-side while its
 * analysis pipeline is the bundled `bluebird` agent.) */
export interface CommandContribution {
  id: string
  title: string
  run(): void
  keywords?: string
}

/** An accent theme a plugin can contribute (CSS is injected into a <style> when enabled). */
/** A font a plugin ships with itself. Appears in 设置 → 外观 → 字体 alongside the built-in
 *  presets, under a separate "from plugins" group.
 *
 *  `stack` is what actually lands in `font-family`, so give a **full stack**, not one family —
 *  a bare Latin family leaves every CJK glyph falling back to whatever the machine has, which is
 *  exactly what the built-in presets exist to avoid. End it with a CJK face you ship (or the
 *  host's `'Noto Sans SC'`) plus a generic keyword.
 *
 *  `files` are loaded via the FontFace API. Point them at assets inside your own plugin folder;
 *  remote URLs are rejected (the app runs under `default-src 'self'` and must work offline). */
export interface FontContribution {
  /** Stable slug, unique within your plugin. Host namespaces it as `plugin:<pluginId>:<id>`. */
  id: string
  /** Shown in the dropdown. */
  label: string
  /** Which of the three slots (界面/正文/等宽) may use it. Defaults to sans slots. */
  slots?: Array<'ui' | 'body' | 'mono'>
  /** Full `font-family` stack. */
  stack: string
  files?: Array<{ url: string; weight?: string; style?: string }>
}

export interface ThemeContribution {
  id: string
  label: string
  swatch: string
  /** CSS defining [data-theme='<id>'][data-mode='light'|'dark'] variable blocks. */
  css: string
}

/** App actions exposed to plugins (no direct store access). */
/**
 * ⚠️ 库依赖契约(2026-09-02 立规,起因:服务器总览误依赖笔记库,用户实报「太奇怪了」):
 * 下面**凡走库内路径**的方法都要求一个**已打开**的笔记库 —— `readFile / writeFile / watchFile /
 * openFile / loadPage / createPage / listPages / listFiles / searchVault / reveal / workFolder(的落点)`。
 * 没有活动库时:写类方法 reject、只读查询给空数组、`vaultRoot()` 给 null(**用它探测**)。
 * 而且库是**惰性恢复**的:用户这一程没进过 Amadeus 之前 `vaultRoot()` 就是 null,哪怕他有库。
 * 结论:与笔记无关的插件功能(仪表盘/远程系统面板/工具面)**不得**建立在这些方法上 ——
 * 用不依赖库的面(`ctx.dashboard.mount` / `ctx.loadData` / `ctx.saveData` / 自己的视图 DOM)。
 * 新增方法时把「需库 / 无需库」写进它的注释,别让下一个人再踩。
 */
export interface PluginAppApi extends BlockSurfaceApi {
  /** Vault-relative path of the note the active panel is showing (both carriers), or null. */
  getActivePage(): string | null
  /** The active note's whole body as markdown — same value (and same staleness) as `getPage().text`. */
  getActivePageText(): string
  loadPage(path: string): void
  createPage(): void
  toggleMode(): void
  setTheme(theme: string): void
  openSearch(): void
  openSwitcher(): void
  /** Show a transient toast. */
  notify(message: string): void
  /** Read a vault file's UTF-8 text by its exact vault-relative path; null if missing/out-of-vault.
   *  For plugin file types (registerFileType) to load their file.
   *  ⚠️需要活动库。**没有活动库时静默返回 `null`,不抛异常** —— 与「文件不存在」同形,
   *  try/catch 照不到;别拿它当可用性探针(用 `vaultRoot()`)。 */
  readFile(path: string): Promise<string | null>
  /** Atomically write a vault file's UTF-8 text by its exact vault-relative path (self-write ledger →
   *  the app's own saves don't bounce back as external changes). Creates the file if absent.
   *  ⚠️需要活动库。没有活动库时**reject**(主进程 `vaultManager` 抛 `Error('No vault is open')`)——
   *  与只读侧的静默 null 不同形,启动期的写一律 try/catch。 */
  writeFile(path: string, text: string): Promise<void>
  /** 读-改-写一张多维表(2026-09-02+):**比对交换**,不是整文件覆盖。`fn` 拿到宿主校验过的 DbFile,
   *  返回新对象即写、返回 `null` 不写(幂等升级「已是最新」就该返 null);写入撞上别人的新版本会重读再套一次
   *  fn(≤3 次),所以 fn 必须是纯函数。宿主认为 corrupt 的文件**不进 fn**(`{ ok:false, corrupt:true }`)。
   *  ⚠️改活表(升级列属性、补视图)一律走这条 —— `readFile` + `writeFile` 整文件覆盖会盖掉读写之间
   *  自动化/用户刚写进去的行,而且零报错。
   *  ⚠️需要活动库且需要桌面桥的 CAS 写口:没有活动库 → `{ ok:false, error }`(不抛);云端/移动端桥没有
   *  CAS → 同样 `{ ok:false, error }`,插件自己决定回落还是放弃。旧宿主没有这个方法:`ctx.app.mutateDb?.(…)`。 */
  mutateDb?(path: string, fn: (db: import('../../../../shared/amadeus/db/schema').DbFile) => import('../../../../shared/amadeus/db/schema').DbFile | null): Promise<{ ok: boolean; conflict?: boolean; corrupt?: boolean; error?: string }>
  /** 订阅某个 vault 文件的**外部**内容改动(2026-08-15+),返回退订。用途:插件把配置/片段库写成
   *  库里的一个文件,用户拿别的编辑器改完要能热重载。
   *  ⚠️只报「内容变了」这一类事件 —— 新建/删除/改名不报(那是文件树的事)。
   *  ⚠️自写不回声:经 `writeFile` 落的盘走自写账本,不会把自己的保存当外部改动弹回来。
   *  ⚠️路径必须与 `readFile` 用的是同一个字符串(vault 相对、`/` 分隔);大小写按平台。
   *  旧宿主 / 非桌面宿主没有:`const off = ctx.app.watchFile?.(p, cb)`,缺位时自己退化成轮询。 */
  watchFile?(path: string, cb: () => void): () => void
  /** The plugin's work folder for file output, vault-relative without leading/trailing slash.
   *  Every plugin automatically gets a "工作文件夹" setting (key `workFolder`) on its detail page;
   *  this returns that value, defaulting to the plugin's display name. Use it as the base for
   *  readFile/writeFile paths (`${ctx.app.workFolder()}/note.md`) — folders spring into existence
   *  on first write. Older hosts lack this method: feature-check `ctx.app.workFolder` first. */
  workFolder(): string
  /** Open a file into the view registered for its file type (post-create / cross-navigation). Refreshes
   *  the tree first if the path is newly created; falls back to the OS default app for non-plugin files. */
  openFile(path: string): void

  // ── 只读 vault 查询面(2026-08-14+)。纯透传主进程既有能力,**没有任何写口**。
  //    定位(codex 2026-08-14 评审的措辞,别写成「读写自然包含枚举」):这是把外置插件**本来就有的**
  //    renderer ambient authority(它跑在主世界,`window.amadeus` 上的 listPages/listFiles/search 一直够得着)
  //    正式收进受支持的 `ctx.app` 契约 —— 而不是新开一档权限。当前信任模型是「只装可信插件」,
  //    不是严格的 capability sandbox。
  //    全部可选:旧宿主没有 → 一律 `ctx.app.listPages?.()`,缺席时降级而不是抛错。
  //    统一语义:**没有活动库 / 桥缺席 → 三条 list/search 一律给空数组(不 reject)**,vaultRoot 给 null。
  //    路径一律 `/` 分隔(Windows 上主进程会返回 `\`,这层已归一)。

  /** 页面(笔记)清单,vault 相对路径。插件声明为自定义文件类型的后缀已被主进程排除在外。**不截断**。 */
  listPages?(): Promise<string[]>
  /** **文件树可见的**非页面文件(附件 / 图片 / .db / PDF…),vault 相对路径。**不截断**。
   *  ⚠️范围有洞,别声称「库里所有图片」:主进程的遍历跳过一切**点目录 / 点文件 / node_modules**,
   *  所以经 `saveAsset()` 落进 `.amadeus/` 的页面附件**枚举不到**(codex 评审指出)。 */
  listFiles?(): Promise<string[]>
  /** **全库笔记**全文检索(主进程既有索引)。只索引 `listPages()` 那批笔记 —— 不搜附件、`.db`、
   *  插件自定义文件类型。**最多 50 条且可能截断**,要穷举别靠它。
   *  `line` 是剥掉 frontmatter/标记后的行号,**不是磁盘编辑坐标**;`score` 是不透明排序值,跨版本不保证稳定。 */
  searchVault?(query: string): Promise<PluginSearchHit[]>
  /** 在系统文件管理器里定位一个库内路径(2026-08-29+):打开它所在的目录并高亮该项。
   *  用途:插件把用户素材放在自己的工作文件夹里(`.glb` / 配置 json …),设置页给一颗
   *  「打开文件夹」——用户得先找得到那个目录,才谈得上往里放东西。
   *  ⚠️**目标不存在时系统什么都不会发生**(showItemInFolder 对不存在的路径是静默 no-op)。
   *  文件夹是首次写入才诞生的,所以正确姿势是先 `writeFile('<workFolder>/README.md', …)`
   *  再 reveal 这个文件 —— 一步同时把目录建出来并在文件管理器里选中它。
   *  旧宿主 / 桥缺席(web / 移动端 / 台架)时**方法整个不存在**:`ctx.app.reveal?.(p)`。 */
  reveal?(path: string): void
  /** 当前库的**绝对路径**(没打开库时 null)。用途:把路径交给 Agent 的 host 模式工具(view_image /
   *  run_bash)—— 它们跑在真实文件系统上,只有 vault 相对路径喂不进去。读的是渲染进程已有的
   *  pageStore 状态,**不会重开库、无副作用**。
   *  ⚠️**敏感信息**:里面可能有用户名、组织目录、Dropbox/iCloud 路径。插件**不得默认持久化、上报或写进遥测**;
   *  这是「可信插件」契约的一部分,不是最小权限接口。
   *  ⚠️**切库竞态**:本值来自渲染进程 store,而 list/search 来自主进程 —— 切换本地/云端库的那一瞬间
   *  主进程先换根、渲染进程后更新,两边可能短暂不同源。拿它拼绝对路径前后都要复核,别缓存过夜。 */
  vaultRoot?(): string | null
}

/** 插件契约自己的检索结果 DTO(**刻意不复用宿主内部的 SearchHit**:内部结构以后要改,不该牵动插件 API)。 */
export interface PluginSearchHit {
  /** vault 相对路径(`/` 分隔)。 */
  path: string
  title: string
  /** 命中处的上下文片段(已剥 frontmatter/标记)。 */
  snippet: string
  /** 剥离后文本里的 1-based 行号 —— 展示用,**不是磁盘行号**。 */
  line: number
  /** 不透明排序值,只用来比大小,别当分数显示。 */
  score: number
}

/** A read-only view of the ACTIVE NOTE. Amadeus is single-active-page (one page per panel, shared by
 *  the note editor and any file-type view) — plugins ride that same model rather than getting a second
 *  page state that would save over the first.
 *
 *  ⚠️ Two note carriers exist (2026-08-20). Branch on `model`, never assume blocks:
 *  - `'blocks'` — the v3 marker-based page. `blocks`/`order` are the real thing.
 *  - `'text'`   — the v4/unified note (the default carrier for ordinary notes). There are **no block
 *                 ids at all**; `blocks`/`order` are permanently empty and `text` is the content.
 *  `path` / `token` / `status` / `text` / `fmExtra` are true under both. */
export interface PageSnapshot {
  /** Opaque identity of "the note this snapshot came from". Pass it back to every mutator — block ids
   *  are PER PAGE (both pages have a `b1`), so acting on a stale snapshot after the user switched notes
   *  would insert into, or delete from, the wrong file. Mismatched token = the call is refused. */
  token: string
  /** Vault-relative path of the active note, or null when none is open. */
  path: string | null
  status: string
  /** The whole note body as markdown. v3 = blocks joined in `order`; v4 = the unified instance's body.
   *  ⚠️ On v4 this is the snapshot **as of the last save** (≤800ms stale — the same beat as the
   *  backlink / outline / word-count panels), not a per-keystroke value.
   *  ⚠️ Read-only. To change content use `insertMarkdown` — never read-modify-write the whole text:
   *  the staleness window means you would erase whatever the user typed in the meantime. */
  text: string
  /** Which carrier this note uses; the branch predicate for everything below.
   *  Absent (`undefined`) on hosts older than 2026-08-20 → treat as `'blocks'`, which is what they were. */
  model: 'blocks' | 'text'
  /** blockId → markdown source. **v3 only; always empty when `model === 'text'`.** Identity-stable
   *  between edits (compare by reference to skip work). Frozen and shared between plugins — never mutate it. */
  blocks: Readonly<Record<string, string>>
  /** Block ids in document order (columns flattened). **v3 only; always empty when `model === 'text'`.** */
  order: readonly string[]
  /** Foreign frontmatter keys the page compiler round-trips verbatim — where a plugin stores its own
   *  per-page data (the built-in mindmap keeps parent/position/relations here).
   *  Readable under both carriers; `setFmExtra` is v3-only for now. */
  fmExtra: string
}

export interface MountBlockOptions {
  /** The `token` from the PageSnapshot these ids came from (see PageSnapshot.token). */
  token: string
  /** Which block to render. Must exist in the active page. */
  blockId: string
  /** Providing this declares "I own block structure": the note-shaped structural keys inside the block
   *  (backspace-at-start merge, arrow-out, move up/down) are neutralised, and anything that would create
   *  a following block (a `/database` scaffold, Shift+Enter in a non-empty block) is routed here instead.
   *  Omit it and the block behaves exactly like one in the note editor. */
  onInsertAfter?(blockId: string, content: string): void
}

/** The block surface: real Amadeus blocks, rendered by the host into DOM the plugin owns.
 *  Exists so an external plugin can build a "nodes are real blocks" UI (the mindmap) without the host
 *  having to ship it — built-in and external plugins get the same capabilities, the only difference
 *  being that built-ins come pre-installed. */
export interface BlockSurfaceApi {
  /** Frozen snapshot — mutating it does nothing (it is shared between plugins). */
  getPage(): Readonly<PageSnapshot>
  /** Fires when the active page's blocks / order / foreign frontmatter change. Returns an unsubscribe. */
  subscribePage(cb: (page: PageSnapshot) => void): () => void
  /** Replace the foreign-frontmatter text wholesale (patch it surgically yourself — other plugins and
   *  the user's own keys live in there too). Goes through the page's undo stack. */
  setFmExtra(token: string, text: string): void
  /** Insert a block after `afterId` (null = at the very start) and return its new id, or null if the
   *  token was stale, no note is loaded, or the note is v4 (`model === 'text'` — no block model to
   *  address; use `insertMarkdown`). Refusals are logged, never silent. */
  insertBlockAfter(token: string, afterId: string | null, content: string): string | null
  /** Insert a chunk of markdown into the active note. **Works under both carriers** — this is the
   *  write path to reach for unless you genuinely need block ids.
   *  `where`: `'cursor'` (default) = after the top-level block holding the caret, replacing it when
   *  empty; `'start'` / `'end'` = the very start / end of the note, leaving the caret and focus alone.
   *  ⚠️ v3 has no caret source of truth, so `'cursor'` degrades to `'end'` there (logged).
   *  ⚠️ What you insert must round-trip through markdown unchanged (runs of spaces get collapsed →
   *  the host reloads the document → any editor state your plugin holds is gone).
   *  Returns false when refused (stale token / no note / nothing to insert / no live editor).
   *  Older hosts lack it: `ctx.app.insertMarkdown?.(…)`. */
  insertMarkdown(token: string, md: string, where?: 'cursor' | 'start' | 'end'): boolean
  /** v3 only — refused (and logged) on a v4 note. */
  deleteBlock(token: string, id: string): Promise<void>
  /** v3 only — refused (and logged) on a v4 note. */
  requestFocus(id: string, place?: 'start' | 'end'): void
  /** v3 only — refused (and logged) on a v4 note. */
  consumeFocus(id: string): void
  /** v3 only — v4 keeps its own unified undo timeline, which is not exposed here yet. */
  undo(token: string): void
  /** v3 only — see `undo`. */
  redo(token: string): void
  /** Modal text input. Electron has no `window.prompt` — use this, never the DOM one. */
  prompt(title: string, initial?: string, opts?: { label?: string }): Promise<string | null>
  /** Render a real, editable block into `el`. Returns a dispose function; call it when you drop the node.
   *  **v3 only** — a v4 note has no blocks to mount, so this is refused (and logged) there. In practice
   *  this is the surface plugin FILE TYPES use (`file.surface`), and those are pinned to v3 by design. */
  mountBlocks(el: HTMLElement, opts: MountBlockOptions): () => void
}

/** Per-view page surface (2026-08-14): handed to FileTypeContribution.mount as `file.surface`.
 *  Same shape as BlockSurfaceApi but bound to the view's OWN pageStore scope — the file-type view and
 *  the note editor panels edit different files at the same time, no "one page at a time" contention.
 *  Feature-detect it (`file.surface?.mountNoteView`); on older hosts fall back to ctx.app + the
 *  active-page model.
 *
 *  ⚠️ v3-marker pages only. Plugin file types are pinned to the v3 format (the v4 upgrader refuses
 *  them by extension and by foreign fm key), and loadPage imports plain files into v3 on first open —
 *  that is the intended lifecycle. Feeding a NORMAL v4/plain note through this loadPage would rewrite
 *  it into v3 on the first debounced save (= data corruption), so loadPage refuses any path outside
 *  the file type's registered extensions. */
export interface PluginPageSurface extends BlockSurfaceApi {
  /** Load a file of THIS file type into the view's scope. Paths outside the registered extensions are
   *  refused (see the invariant above). Nonexistent paths spring a blank page into existence — check
   *  with readFile first if "may have been deleted" is a real state for you. */
  loadPage(path: string): void
  /** The path currently loaded in this view's scope (null before the first loadPage resolves). */
  getActivePage(): string | null
  /** Render the native note editor (the same body a normal note gets: block list, ⠿ drag handles,
   *  enter/backspace semantics, slash menu, click-below-to-append) into `el`, bound to this view's
   *  scope. Title bar / cover / properties are deliberately not included (renaming compound suffixes
   *  and exposing plugin fm keys are both corruption paths). Returns a dispose function. */
  mountNoteView(el: HTMLElement): () => void
}

/** One achievement inside a plugin-registered series. Titles/descriptions are literal strings
 *  (plugins don't go through app i18n). `event` is the counter key the plugin bumps via
 *  ctx.achievements.track(); the host prefixes ids/events with `plugin:<pluginId>:` automatically. */
export interface AchievementContribution {
  id: string
  title: string
  desc: string
  event: string
  goal: number
  points: number
}

/** An achievement series a plugin can contribute (shows up in the Achievements panel).
 *  medals = claimed-points thresholds for bronze/silver/gold; omit to auto-derive from total points. */
export interface AchievementSeriesContribution {
  id: string
  title: string
  medals?: { bronze: number; silver: number; gold: number }
  achievements: AchievementContribution[]
}

/** A collapsible panel a plugin contributes to the sidebar. (React component; built-in plugins.)
 *  @deprecated Dead since the LCL shell — panels only ever rendered in the retired VaultSidebar.
 *  Contribute a workbench view via `registerView` instead. */
export interface PanelContribution {
  id: string
  title: string
  component: ComponentType
}

/** An item a plugin contributes to the global bottom status bar.
 *  (Revived 2026-07-23: the LCL shell now renders a global status bar — deprecation lifted.)
 *  Two forms: `component` (React; built-in plugins) or data-driven `text`/`title`/`onClick`
 *  (external plugins — no React needed; mutate via the handle returned by registerStatusItem).
 *  The host namespaces the id as `plugin:<pluginId>:<id>` and lists it in
 *  设置 → 通知与状态栏, where users can hide/reorder it. Cleared on plugin disable. */
export interface StatusItemContribution {
  id: string
  /** React form (built-ins). Takes precedence over the data-driven fields. */
  component?: ComponentType
  /** Data-driven form: the text shown in the bar. Update via handle.update(). */
  text?: string
  /** Hover tooltip. */
  title?: string
  /** Ordering segment — the bar renders right-aligned as one row; 'left' items come before
   *  'right' items. Default 'right'. */
  side?: 'left' | 'right'
  /** Makes the item clickable (hover highlight). */
  onClick?(): void
}

/** Returned by registerStatusItem — lets the plugin update its item in place. */
export interface StatusItemHandle {
  update(patch: { text?: string; title?: string }): void
  dispose(): void
}

/** A workbench view a plugin can contribute (plain DOM mount — no React needed in the plugin).
 *  The host registers it into the engine view registry as `plugin:<pluginId>:<viewId>`, so custom
 *  Spaces can compose it (and declare it under `requires.views`), and the plugin's own commands
 *  can open it via `ctx.openView(viewId)`. Unregistered again when the plugin is disabled
 *  (open instances are closed first). */
export interface ViewContribution {
  /** View id, unique within the plugin (kebab-case recommended). */
  id: string
  /** Tab title shown in the workbench. */
  title: string
  /** Build the view's DOM into the host-provided element; called once per opened instance.
   *  Return a cleanup to run when the instance closes (clear timers/observers here). */
  mount(el: HTMLElement): (() => void) | void
  /** Default true: at most one instance app-wide (re-opening focuses the existing one). */
  singleton?: boolean
  /** Id of one of THIS plugin's list sources (2026-08-25+): while this view is the active main
   *  view, the unified workspace sidebar auto-switches to that list. Old hosts ignore it. */
  workspaceSource?: string
}

/** One row in a plugin list source (kept deliberately flat — no tree). */
export interface ListItem {
  /** Stable key within the source (dedupe / React key). */
  key: string
  title: string
  /** Optional static section header; items sharing a group render under one collapsible section.
   *  Ignored when the source declares `groups()` — those are selectable filters, not sections. */
  group?: string
  /** Optional dim text on the right (count, date, status). */
  hint?: string
  /** Leading icon, by name from the host icon vocabulary (same table as manifest icons —
   *  keys are [a-z0-9-]; unknown names fall back to the generic row icon). Use it to keep
   *  per-item recognisability (e.g. one icon per source platform) inside the shared row UI. */
  icon?: string
  /** Optional image URL for the leading icon (e.g. a platform favicon) — wins over `icon`,
   *  and the host falls back to `icon` if it fails to load. Older hosts ignore the field
   *  and just render `icon`, so always set both. */
  iconUrl?: string
}

/** A selectable filter row (≈ a folder). The host owns which one is active and passes the
 *  selection back through `items()` — the plugin stays stateless about the UI. */
export interface ListGroup {
  key: string
  title: string
  /** Leading icon by vocabulary name (same as ListItem.icon); defaults to a folder glyph. */
  icon?: string
  /** Shown right-aligned; the plugin computes it (the host does not count for you). */
  count?: number
}

/** A button the host renders for a list source (top bar, group header, or context menu). */
export interface ListAction {
  id: string
  label: string
  run(): void
}

/** A list source a plugin can contribute to the unified workspace sidebar (View 基座 P2).
 *  The host renders it with the same UI as the built-in session/note lists and wires it into
 *  the sidebar's auto mode: a view registered with `workspaceSource` pointing at this source
 *  makes the sidebar switch to this list whenever that view is the active main view.
 *  Registered as `plugin:<pluginId>:<sourceId>`; disappears when the plugin is disabled. */
export interface ListSourceContribution {
  /** Source id, unique within the plugin (kebab-case recommended). */
  id: string
  /** Section title shown above the list. */
  title: string
  /** Current items snapshot, already filtered by the host-owned search text and selected group.
   *  Called on every render — keep it cheap (cache inside the plugin). */
  items(filter?: { query?: string; group?: string }): ListItem[]
  /** Notify the host when items() changed. Return an unsubscribe. */
  subscribe(cb: () => void): () => void
  /** Stable key of the item currently open in the main view. The host applies its shared `active`
   *  row state; notify the subscriber when this value changes. Keep this synchronous and cheap. */
  activeKey?(): string | null
  /** Open one item (the plugin decides what that means — usually ctx.openView / ctx.app.openFile). */
  open(item: ListItem, opts?: { newTab?: boolean }): void
  /** Render the shared search box above the list; the text arrives via `items({ query })`. */
  search?: boolean
  /** Selectable filter rows (folders). The host renders them with an "all" row on top, tracks the
   *  selection, and passes it back via `items({ group })`. */
  groups?(): ListGroup[]
  /** Buttons above the whole list (e.g. "New analysis"). */
  actions?: ListAction[]
  /** Buttons on the groups section header (e.g. "New folder"). */
  groupActions?: ListAction[]
  /** Right-click menu for one row (e.g. "Move to…", "Delete"). */
  itemMenu?(item: ListItem): ListAction[]
  /** Drop target support. **The plugin decides**: omit and the list takes no drops at all (today's
   *  behaviour). The host owns hit-testing and the highlight, and hands over the resolved target —
   *  a group row, an item row, or the list background (neither field set = the selected group).
   *  `accepts` gates which payloads light up: 'files' = OS files (given as File[]), 'paths' = in-app
   *  path drags such as rows from the file tree (given as absolute host paths). */
  drop?: {
    accepts: Array<'files' | 'paths'>
    onDrop(payload: { files?: File[]; paths?: string[] }, target: { group?: string; item?: ListItem }): void | Promise<void>
  }
}

/** A custom file type a plugin owns end-to-end (like the built-in Excalidraw whiteboard): its own tree
 *  icon, a dedicated editor view opened when the file is clicked, and — paired with registerEmbedRenderer —
 *  an inline `![[file.ext]]` block. Declare the SAME suffixes in manifest `fileExtensions`, so the main
 *  process keeps these files out of the note/page list (its compiler would otherwise rewrite = corrupt them).
 *  The host opens one shared engine view (`amadeus-plugin-file`) that re-derives the type from the file path
 *  at mount time — so a plugin loading after boot still works. */
export interface FileTypeContribution {
  /** Type id, unique within the plugin (kebab-case recommended). */
  id: string
  /** File suffixes this type claims, e.g. ['.mindmap.md']. Case-insensitive suffix match; keep in sync
   *  with the plugin's manifest `fileExtensions`. */
  extensions: string[]
  /** 文件树上的图标。同 SlashContribution.icon:优先写图标词表里的名字(画 SVG),
   *  没命中就当字形(emoji,渲染方式同 frontmatter 的 `icon:`)。 */
  icon?: string
  /** Optional display label for the type. The file view titles its tab by the file's basename; this is a
   *  fallback (used when the basename is empty). */
  title?: string
  /** frontmatter keys this type OWNS on its files (e.g. ['canvas'] for the canvas geometry key).
   *  The host hides them from the note properties panel on matching files — they're plugin data,
   *  hand-editing corrupts the view and a plain note has no such keys. Hidden ≠ droppable: the
   *  panel still round-trips them verbatim on every properties edit. (2026-08-14) */
  fmKeys?: string[]
  /** Build the editor for one file into the host element; called once per opened instance. Return a
   *  cleanup (flush/save-on-close, clear timers here). Read/write the file via ctx.app.readFile/writeFile.
   *  `file.surface` (2026-08-14, when present): a per-view page surface scoped to this tab — prefer it
   *  over ctx.app's active-page model so the view coexists with the note editor. */
  mount(el: HTMLElement, file: { filePath: string; surface?: PluginPageSurface }): (() => void) | void
}

/** A "New …" file-creation entry a plugin contributes to the file tree's right-click menu (root + folder
 *  submenus), sitting alongside the built-in 新建笔记 / 新建 Base / 新建白板. The host renders `icon`+`label`;
 *  on click it calls `run(parentFolder)` where parentFolder is the clicked folder's vault-relative path
 *  ('' = vault root). The plugin creates its file there (ctx.app.writeFile) and opens it (ctx.app.openFile).
 *  Pairs naturally with registerFileType so the new file gets its own icon + dedicated view. */
export interface FileCreatorContribution {
  /** Creator id, unique within the plugin. */
  id: string
  /** Menu label, e.g. '新建思维导图'. */
  label: string
  /** 标签前的图标。同 SlashContribution.icon:优先写图标词表里的名字,没命中就当字形。 */
  icon?: string
  /** Create the file inside `parentFolder` (vault-relative, '' = root) and open it. Invoked on menu click.
   *  Return the promise when the work is async — the host awaits it and toasts on failure; a bare `void`
   *  return means a rejected creation would fail silently after the menu closes. */
  run(parentFolder: string): void | Promise<void>
}

/** An inline renderer for a `![[target]]` transclusion whose target this plugin recognises (typically its
 *  own file type). Consulted before the built-in file-card fallback, so `![[x.mindmap.md]]` renders as a
 *  live preview instead of a generic "open file" card. */
export interface EmbedRendererContribution {
  /** Renderer id, unique within the plugin. */
  id: string
  /** True if this renderer handles the embed target (the inside of `![[…]]`; pipe/anchor already split off). */
  match(target: string): boolean
  /** Render the embed (read-only preview) into the host element; return a cleanup.
   *  `showSource()` flips this block into its raw `![[…]]` source line for editing; it re-renders
   *  once the caret leaves. The host already draws a hover `</>` button for every embed block —
   *  call this only if you want a second entry point inside your own UI (a menu item, a hotkey).
   *  Optional: older hosts don't pass it, so always call as `embed.showSource?.()`. */
  mount(
    el: HTMLElement,
    embed: { target: string; pagePath: string; showSource?: () => void },
  ): (() => void) | void
}

/** A user-tunable setting a plugin declares. The host renders the form on the plugin's detail
 *  page and persists values to localStorage `plugin.<pluginId>.<key>` — the plugin reads the
 *  same key at use time (poll-loop reads pick changes up next round; no change notification). */
export interface SettingContribution {
  /** Storage key suffix (localStorage `plugin.<pluginId>.<key>`). */
  key: string
  label: string
  type: 'number' | 'boolean' | 'text'
  default: string | number | boolean
  min?: number
  max?: number
  description?: string
}

/** 插件自绘的设置面板(2026-08-15,Obsidian `PluginSettingTab` 的对位)。
 *  `registerSetting` 那套「一行一个 number/boolean/text」只够调旋钮;需要列表编辑、多标签页、
 *  内嵌代码编辑器的插件(片段库、规则表)装不下 —— 这里直接给一个裸 DOM 容器,插件自己画。
 *
 *  渲染在插件详情页的声明式设置表**下方**(两者可并存:旋钮交给宿主渲染,复杂面自绘)。
 *  ⚠️宿主主题的 CSS 变量在容器上照常可用,但**没有任何样式重置** —— 自己带样式。 */
export interface SettingsViewContribution {
  /** 本插件内唯一(同 id 重注册即覆盖)。 */
  id: string
  /** 可选小标题;省略则不画标题行。 */
  title?: string
  /** 详情页打开时调用。返回的函数在面板关闭 / 插件禁用时执行(定时器、订阅、第三方编辑器实例在此收)。
   *  ⚠️同一插件的面板可能被反复挂载卸载(用户来回进出详情页),别把状态放在闭包外的模块级单例里。 */
  mount(el: HTMLElement): void | (() => void)
}

/** 宿主交给编辑器扩展的 ProseMirror 工具箱(2026-08-15)。
 *
 *  外置插件是 `new Function('ctx', code)` 求值的裸 setup 体 —— **没有 import**,自己造不出
 *  `new Plugin({...})`。所以宿主把编辑器底层库递进去,和 Obsidian 把 CodeMirror 递给插件是同一招。
 *  这些就是宿主编辑器自己在用的那一份实例(不是副本),`instanceof` 与 PluginKey 查找都对得上。 */
export interface PmToolkit {
  Plugin: typeof import('@milkdown/kit/prose/state').Plugin
  PluginKey: typeof import('@milkdown/kit/prose/state').PluginKey
  Selection: typeof import('@milkdown/kit/prose/state').Selection
  TextSelection: typeof import('@milkdown/kit/prose/state').TextSelection
  NodeSelection: typeof import('@milkdown/kit/prose/state').NodeSelection
  Decoration: typeof import('@milkdown/kit/prose/view').Decoration
  DecorationSet: typeof import('@milkdown/kit/prose/view').DecorationSet
  Slice: typeof import('@milkdown/kit/prose/model').Slice
  Fragment: typeof import('@milkdown/kit/prose/model').Fragment
  keymap: typeof import('@milkdown/kit/prose/keymap').keymap
  InputRule: typeof import('@milkdown/kit/prose/inputrules').InputRule
  inputRules: typeof import('@milkdown/kit/prose/inputrules').inputRules
}

/** 每个编辑器实例调一次,返回要挂上去的 ProseMirror 插件。 */
export type EditorExtensionFactory = (
  pm: PmToolkit,
) => import('@milkdown/kit/prose/state').Plugin[]

export interface EditorExtensionOptions {
  /** `'high'` = 排在宿主全部插件**之前**,能抢在内置行为前处理按键。
   *
   *  什么时候需要:插件要接管一个宿主已经占用的键(最典型的是 `Tab` —— 宿主用它做列表缩进)。
   *  ⚠️代价与义务:高优先级插件坐在每一次按键的最前面,**不该自己处理的必须返回 false**,
   *  否则整个编辑器的内置行为在它手里静默消失。缺省 `'normal'`(排在宿主之后,只捡没人处理的)。 */
  priority?: 'high' | 'normal'
}

export interface PluginContext {
  app: PluginAppApi
  registerSlashItem(item: SlashContribution): void
  registerCommand(command: CommandContribution): void
  registerTheme(theme: ThemeContribution): void
  /** Contribute a font to 设置 → 外观 → 字体. Returns a disposer; the host also revokes it on
   *  disable/reload, so plugins may ignore the return value.
   *  Old hosts (< 2026-08-28) lack it — call as `ctx.registerFont?.(…)`. */
  registerFont?(font: FontContribution): (() => void) | void
  /** @deprecated No live render surface — use registerView. */
  registerPanel(panel: PanelContribution): void
  /** Contribute an item to the global bottom status bar (host-namespaced `plugin:<pluginId>:<id>`;
   *  user-manageable in 设置 → 通知与状态栏). Returns a handle for in-place updates.
   *  Old hosts (< 2026-07-23) return void — call as `const h = ctx.registerStatusItem?.(…)`
   *  and guard `h?.update(…)`. */
  registerStatusItem(item: StatusItemContribution): StatusItemHandle | void
  /** Contribute a workbench view (registered as engine view type `plugin:<pluginId>:<id>`). */
  registerView(view: ViewContribution): void
  /** Contribute a custom file type: tree icon + dedicated editor view + click-to-open. Declare the same
   *  suffixes in manifest `fileExtensions`. See FileTypeContribution. */
  /** Returns false when EVERY declared suffix is already owned by a built-in file type — the host
   *  refuses the registration (built-ins always win) and the plugin should stand down entirely
   *  (skip its file creator / slash item too, or the user sees duplicate "New X" entries).
   *  Older hosts return undefined, so test with `=== false`. */
  registerFileType(def: FileTypeContribution): boolean | void
  /** Contribute an inline renderer for `![[…]]` embeds this plugin recognises (e.g. its own file type). */
  registerEmbedRenderer(def: EmbedRendererContribution): void
  /** Contribute a "新建 …" entry into the file tree's right-click menu (root + folder). See FileCreatorContribution. */
  registerFileCreator(def: FileCreatorContribution): void
  /** Open (or focus) one of this plugin's own registered views. Defaults to the main area;
   *  pass { location: 'left' | 'right' } to dock it into a sidebar (2026-08-25+, older hosts
   *  ignore the option and open in main). No-op on hosts without a workbench. */
  openView(viewId: string, opts?: { location?: 'main' | 'left' | 'right' }): void
  /** Contribute a list source to the unified workspace sidebar (2026-08-25+). Old hosts lack it:
   *  always call as `ctx.registerListSource?.(…)`. See ListSourceContribution. */
  registerListSource?(src: ListSourceContribution): void
  /** Show a top-right notification card (2026-07-23+). Source is auto-labelled with the plugin
   *  name and users can mute per plugin in 设置 → 通知与状态栏 — treat it as a mutable hint, not a
   *  data channel. error level is sticky (manual close) by default. Old hosts lack this API:
   *  always call as `ctx.notify?.(…)`. For persistent state prefer registerStatusItem. */
  notify?(message: string, opts?: { level?: 'info' | 'success' | 'warning' | 'error'; title?: string; sticky?: boolean }): void
  /** The host UI's current language (2026-08-14+). Plugins ship bilingual strings and pick with this.
   *  Optional in the type only because API v1 hosts predate it — every current host injects it, so
   *  always call as `ctx.getLocale?.() ?? 'zh'` (Chinese is the canonical fallback). */
  getLocale?(): 'zh' | 'en'
  /** Fires when the user switches language — re-render your DOM here (only *changes* are reported;
   *  read the initial value from getLocale()). Returns an unsubscribe. The host also drops every
   *  subscription a plugin made when it is disabled/reloaded/its setup throws, so a forgotten
   *  unsubscribe can't leak — but dispose yours anyway. Old hosts lack it: `ctx.subscribeLocale?.(…)`. */
  subscribeLocale?(cb: (locale: 'zh' | 'en') => void): () => void
  /** Declare a tunable setting (rendered on the plugin detail page; localStorage-backed). */
  registerSetting(def: SettingContribution): void
  /** 自绘设置面板(2026-08-15+)。声明式旋钮装不下的复杂设置走这里。见 SettingsViewContribution。
   *  旧宿主没有:`ctx.registerSettingsView?.(…)`。 */
  registerSettingsView?(def: SettingsViewContribution): void
  /** 往笔记编辑器里注 ProseMirror 插件(2026-08-15+)。片段展开、按键拦截、行内装饰这类
   *  「必须住在编辑器里」的能力靠它 —— v3 块编辑器与 v4 统一编辑器共用同一个编辑器工厂,注一次两端到位。
   *
   *  factory 在**每个编辑器实例**创建时调用一次(一篇笔记在 v3 下是很多个小编辑器),返回的插件
   *  归那一个实例所有。宿主把返回插件的 `props.*` 处理器包了 try/catch:第三方代码在按键热路径上
   *  抛错不会连坐整个编辑器(state.apply 不包 —— 那里吞异常等于放任状态损坏)。
   *
   *  ⚠️能力边界:拿到 EditorView 就能读写当前打开笔记的全文。这是把外置插件**本来就有的**
   *  renderer ambient authority 收进受支持契约,不是新开权限档(同只读 vault 查询面的口径)。
   *  ⚠️插件禁用后已建好的编辑器不会当场摘掉扩展 —— 宿主会让编辑器重建,但那是下一拍的事。
   *
   *  旧宿主没有:`ctx.registerEditorExtension?.(…)`。 */
  registerEditorExtension?(factory: EditorExtensionFactory, opts?: EditorExtensionOptions): void
  /** 读本插件的私有 JSON blob(`~/.forsion/plugins-data/<id>.json`)。没写过 / 宿主缺位 → null。
   *  registerSetting 是「一键一个字符串」,存不下片段库这类大块数据,也没有原子性。
   *  旧宿主没有:`await ctx.loadData?.() ?? 默认值`。 */
  loadData?<T = unknown>(): Promise<T | null>
  /** 原子写本插件的私有 JSON blob(整体覆盖)。宿主缺位时静默 no-op。 */
  saveData?(value: unknown): Promise<void>
  /** Dashboard 配方编译(2026-09-01+):声明式配方 → 一份真 `.dashboard.md` 字节。
   *  插件自己经 `ctx.app.writeFile` 落进 workFolder、`ctx.app.openFile` 打开 —— 宿主的
   *  amadeusNav 会把 `.dashboard.md` 路由到原生 Dashboard tab(网格/卡片/排版台全套)。
   *  围栏与 frontmatter 词表**留在宿主**(格式无版本契约,手抄=将来破兼容);再生成时把
   *  现有文件字节传 `existingFileText`,用户手排的布局(dashboard3/3x)与页面筛选会存活,
   *  读不懂的现有布局会拒编译(ok:false)——绝不拿默认值覆盖用户布局。
   *  旧宿主没有:`ctx.dashboard?.source(…)`。 */
  dashboard?: {
    source(
      recipe: import('../../../../shared/amadeus/dashboardRecipe').DashboardRecipe,
      opts?: { existingFileText?: string },
    ): import('../../../../shared/amadeus/dashboardRecipe').RecipeResult
    /** 在插件自己的容器里渲染一页**原生** Dashboard(真 dashboard3 网格/卡片/排版台),
     *  **不依赖笔记库**(库开没开、有没有库都能用 —— 与 source+writeFile 那条「住在库里」的路线
     *  刻意区分)。`el` 通常就是 registerView 的 mount(el) 给的容器。返回卸载函数;插件禁用时
     *  宿主也会统一卸掉。
     *  布局持久化归插件:用户在排版台手排后 `onLayout(text)` 交出整页文本,存进 `ctx.saveData`
     *  之类;下次挂载把它作 `layoutText` 传回,手排的卡按卡 id 保留、数据照常刷新。
     *  旧宿主没有:`ctx.dashboard?.mount?.(…)`。 */
    mount?(
      el: HTMLElement,
      opts: {
        recipe: import('../../../../shared/amadeus/dashboardRecipe').DashboardRecipe
        layoutText?: string | null
        onLayout?: (text: string) => void
        locked?: boolean
      },
    ): () => void
  }
  /** Register a custom Database property/column type (Obsidian-style open extension point). */
  registerPropertyType(def: PropertyTypeContribution): void
  /** Achievements: register a series and bump its counters. Series/achievement ids and events
   *  are auto-prefixed `plugin:<pluginId>:` (can't collide with or forge official ones). */
  achievements: {
    registerSeries(def: AchievementSeriesContribution): void
    track(event: string, n?: number): void
  }
  /** Tangu 侧的只读探针(2026-08-29+):**当前主区聊天要用的模型** + **模型目录** + **当前 Space id**。
   *  聊天状态住在 Tangu 的 store 里,`ctx.app` 是 Amadeus 的页面/库面 —— 两者不通,所以单开这一截。
   *
   *  ⚠️**整个 `ctx.tangu` 在非 Tangu 宿主上不存在**(纯 Amadeus 壳 / unit 设备页 / 云端):
   *  一律 `ctx.tangu?.activeModel()`。这是能力探测,不是权限闸 —— 模型名不敏感,不用在 manifest
   *  `capabilities` 里声明(那道双闸留给 `system.activeWindow` 那类敏感能力)。
   *
   *  `activeModel()` = 输入栏药丸显示的那个(会话已选 → 会话的;空白新对话 → 记忆/后端默认),
   *  一个都没有时 null。`models()` 给全部对话模型(只含 llm;目录未就绪时空数组),供插件设置页做
   *  逐模型绑定。`activeSpace()` 给 Space id(`'tangu'` / `'__home__'` / 用户 Space …)。
   *  `subscribe()` **只在这两个值真的变了**时回调 —— 不是每次 store 变更(流式回答期间每个 SSE
   *  增量都会动 store)。退订宿主也会在插件禁用/重载时统一收掉,但自己也 dispose。 */
  tangu?: {
    activeModel(): import('./tanguSeam').TanguModelInfo | null
    models(): import('./tanguSeam').TanguModelInfo[]
    activeSpace(): string | null
    subscribe(cb: () => void): () => void
    /** 主区聊天的用量/档位快照:上下文窗口、已用 tokens、生效思考档(2026-08-29+,旧宿主没有 →
     *  `ctx.tangu.session?.()`,缺席时把这几行整段不画,别显示 0)。
     *  ⚠️**拉取式**:这些值在流式回答里每个 SSE 增量都在动,故意不进 `subscribe` 的变更键。
     *  要跟着动就自己 setInterval 拉,别指望订阅回调。 */
    session?(): import('./tanguSeam').TanguSessionInfo | null // 宿主装了探针但探针不给值时返回 null
  }
  /** 前台窗口采样(host-only 接缝)——「现在焦点在哪个 app」。**两道闸都过了才有值**:
   *  ① 插件在 manifest `capabilities` 里声明了 'activeWindow'(没声明 → `ctx.system` 整个不存在);
   *  ② 用户在 设置 → 开发者选项 打开了「前台窗口采样」(主进程配置,默认关)。
   *  任一条不满足 → 恒 null,不抛。⚠️darwin 拿不到窗口标题(title 恒 ''),Wayland 恒 null。
   *  ⚠️`idleSeconds` 不是装饰:采样式数据里人离开后前台 app 不变,不据此丢挂机时段的话,
   *  挂机时长会整段记到最后那个 app 头上。永远 `ctx.system?.activeWindow?.()`。 */
  system?: {
    activeWindow(): Promise<import('../../../../shared/activeWindow').ActiveWindowSample | null>
  }
  /** Activity log: report user actions inside the plugin's UI to the local activity journal
   *  (feeds background agents like Muse). Events are auto-prefixed `plugin:<pluginId>:`;
   *  `detail` values are sanitized/truncated by the host (`text` key = trailing snippet). */
  activity?: {
    log(event: string, detail?: Record<string, unknown>): void
  }
  /** 自动化规则播种(2026-09-02+,Tangu 宿主 only)。插件给一批**多维表触发**规则,宿主幂等 upsert
   *  到引擎(`POST /agent/special/muse/triggers`),每次 setup 都可以重放:
   *  - 规则 id 由**宿主**拼 `plugin:<pluginId>:<key>`(插件只给 key,`[a-z0-9-]+`;伪造不了别家的规则);
   *  - `vault` 由宿主绑当前库;`path` 是库相对路径(插件自己拼 `${ctx.app.workFolder()}/x.db`,宿主**不**替你前缀),
   *    归一口径与引擎同(反斜杠→正斜杠、去首尾斜杠与空段);
   *  - actions 只许 notify / db_row_add / db_row_edit —— `agent_run` / `tool_call` 该条被拒(引擎路由同样兜底);
   *  - **异步等待**:后端就绪(cfg 已加载且连通)且库已恢复才发,最多等 60s;超时 / 没开库 → 整批不发,
   *    errors 里 `No vault is open`;单条坏规则(key 形态 / path / where / actions)只拒那一条,其余照发;
   *  - 恒传 `enabled:true`:用户在自动化面板里单独关掉的插件规则,下次插件重载会被开回来;
   *  - 插件被用户**禁用** → 本插件全部规则 `enabled=false`(不删);再启用时引擎重新播种游标(停用期间的行不爆发)。
   *  ⚠️**非 Tangu 宿主上整个 `ctx.automation` 不存在**(纯 Amadeus 壳 / unit 设备页 / 云端 / 台架)——一律
   *  `void ctx.automation?.ensure(rules)`(别 await 阻塞 setup)。 */
  automation?: {
    ensure(rules: PluginAutomationRule[]): Promise<{ ok: boolean; errors: string[] }>
  }
  /** 日历成员登记(2026-09-02+)。Calendar Space 是显式成员制 —— 插件种下的任务表不会自动进日历,
   *  用这条把 `dbPath`(库相对路径)以 `dateColId` 为日期锚(可选 `checkboxColId` 为完成勾选)登记进去。
   *  已是成员 → no-op(不覆盖用户改过的列映射);库还没恢复 → 等库恢复后再登记(最多 60s),
   *  同步返回 void。旧宿主没有:`ctx.calendar?.ensureMember(…)`。 */
  calendar?: {
    ensureMember(dbPath: string, dateColId: string, checkboxColId?: string): void
  }
}

/** `ctx.automation.ensure` 的一条规则 = 引擎 upsert 入参的**子集**(只有 db_changed 触发;id / vault /
 *  agent_slug / prompt 由宿主定或不开放)。字段含义见 `MuseTriggerUpsert` / `AutomationActionSpec`。 */
export interface PluginAutomationRule {
  /** 规则键,`[a-z0-9-]+`;宿主拼成 `plugin:<pluginId>:<key>`。同 key 重放 = 幂等更新。 */
  key: string
  desc: string
  cond_type: 'db_changed'
  /** 触发表,库相对路径,须以 .db 结尾。 */
  path: string
  event: 'row_added' | 'cell_changed'
  /** cell_changed 必填:被盯那列的 id。 */
  column_id?: string
  /** cell_changed 可选:只有变成这个值才算数。 */
  equals?: string
  /** 附加条件(与 equals AND;≤10 条)。 */
  where?: import('../../types').AutomationWhere[]
  /** 动作链(1–24 步),只许 notify / db_row_add / db_row_edit。 */
  actions: Array<Extract<import('../../types').AutomationActionSpec, { type: 'notify' | 'db_row_add' | 'db_row_edit' }>>
  /** 冷却小时;纯动作链缺省 0(链式规则需要),可显式给 0。 */
  cooldown_hours?: number
}

export interface AmadeusPlugin {
  id: string
  /** Canonical (Chinese) name — also the source of the default work folder, so it never changes with
   *  the UI language. For display, go through `pluginDisplayName(p, locale)`. */
  name: string
  version: string
  description?: string
  /** English display name / description (manifest `nameEn` / `descriptionEn`). External plugins only. */
  nameEn?: string
  descriptionEn?: string
  /** Package-root icon.png, exposed by the host as a validated data URL. */
  iconUrl?: string
  /** Built-in plugins ship with the app and can't be uninstalled (only disabled). */
  builtin?: boolean
  /** Manifest apiVersion (missing → 1). */
  apiVersion?: number
  minAppVersion?: string
  /** Companion app id (manifest.requiresApp); detail page renders install/probe UI when whitelisted in KNOWN_APPS. */
  requiresApp?: string
  /** 声明要用的宿主敏感能力(manifest `capabilities`,主进程已按白名单过滤)。没声明的能力宿主不注入。 */
  capabilities?: import('@amadeus-shared/ipc').PluginCapability[]
  /** README.md content for the detail page (external plugins only). */
  readme?: string
  /** CHANGELOG.md content — rendered as the "更新日志" section on the detail page (external plugins only). */
  changelog?: string
  /** Declarative first-run setup card (manifest `onboarding`; sanitized by the host). */
  onboarding?: PluginOnboardingSpec
  /** Present → gated out by the host: 'api' = apiVersion mismatch, 'minApp' = app too old. Never activated. */
  blocked?: 'api' | 'minApp'
  /** 捆绑包内嵌内容清单(引擎插件 id / agent / 技能 / Space;缺省 = 纯 UI 插件)。External plugins only. */
  bundle?: import('@amadeus-shared/ipc').PluginBundleInfo
  /** 插件声明会发的活动事件(manifest `events`,宿主已消毒)——自动化构建器事件目录用。External plugins only. */
  events?: import('@amadeus-shared/ipc').PluginEventDecl[]
  /** Wire up contributions; optionally return a disposer for teardown on disable. */
  setup(ctx: PluginContext): void | (() => void)
}
