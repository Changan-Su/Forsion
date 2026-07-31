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
   * 名字没命中就按字面当字形画(emoji / `✎` 等),老插件因此零改动照跑,但视觉不统一。
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

/** A command surfaced in the command palette (Cmd/Ctrl+K). */
export interface CommandContribution {
  id: string
  title: string
  run(): void
  keywords?: string
}

/** An accent theme a plugin can contribute (CSS is injected into a <style> when enabled). */
export interface ThemeContribution {
  id: string
  label: string
  swatch: string
  /** CSS defining [data-theme='<id>'][data-mode='light'|'dark'] variable blocks. */
  css: string
}

/** App actions exposed to plugins (no direct store access). */
export interface PluginAppApi extends BlockSurfaceApi {
  getActivePage(): string | null
  /** Concatenated text of the active page's blocks. */
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
   *  For plugin file types (registerFileType) to load their file. */
  readFile(path: string): Promise<string | null>
  /** Atomically write a vault file's UTF-8 text by its exact vault-relative path (self-write ledger →
   *  the app's own saves don't bounce back as external changes). Creates the file if absent. */
  writeFile(path: string, text: string): Promise<void>
  /** Open a file into the view registered for its file type (post-create / cross-navigation). Refreshes
   *  the tree first if the path is newly created; falls back to the OS default app for non-plugin files. */
  openFile(path: string): void
}

/** A read-only view of the ACTIVE page's blocks. Amadeus is single-active-page (one page loaded at a
 *  time, shared by the note editor and any file-type view) — plugins ride that same model rather than
 *  getting a second page state that would save over the first. */
export interface PageSnapshot {
  /** Opaque identity of "the page these ids belong to". Pass it back to every mutator — block ids are
   *  PER PAGE (both pages have a `b1`), so acting on a stale snapshot after the user switched pages
   *  would insert into, or delete from, the wrong file. Mismatched token = the call is refused. */
  token: string
  /** Vault-relative path of the active page, or null when none is loaded. */
  path: string | null
  status: string
  /** blockId → markdown source. Identity-stable between edits (compare by reference to skip work).
   *  Frozen and shared between plugins — never mutate it. */
  blocks: Readonly<Record<string, string>>
  /** Block ids in document order (columns flattened). */
  order: readonly string[]
  /** Foreign frontmatter keys the page compiler round-trips verbatim — where a plugin stores its own
   *  per-page data (the built-in mindmap keeps parent/position/relations here). */
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
   *  token was stale. */
  insertBlockAfter(token: string, afterId: string | null, content: string): string | null
  deleteBlock(token: string, id: string): Promise<void>
  requestFocus(id: string, place?: 'start' | 'end'): void
  consumeFocus(id: string): void
  undo(token: string): void
  redo(token: string): void
  /** Modal text input. Electron has no `window.prompt` — use this, never the DOM one. */
  prompt(title: string, initial?: string, opts?: { label?: string }): Promise<string | null>
  /** Render a real, editable block into `el`. Returns a dispose function; call it when you drop the node. */
  mountBlocks(el: HTMLElement, opts: MountBlockOptions): () => void
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
  /** Build the editor for one file into the host element; called once per opened instance. Return a
   *  cleanup (flush/save-on-close, clear timers here). Read/write the file via ctx.app.readFile/writeFile. */
  mount(el: HTMLElement, file: { filePath: string }): (() => void) | void
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

export interface PluginContext {
  app: PluginAppApi
  registerSlashItem(item: SlashContribution): void
  registerCommand(command: CommandContribution): void
  registerTheme(theme: ThemeContribution): void
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
  /** Open (or focus) one of this plugin's own registered views in the main area.
   *  No-op on hosts without a workbench (e.g. the standalone notes app). */
  openView(viewId: string): void
  /** Show a top-right notification card (2026-07-23+). Source is auto-labelled with the plugin
   *  name and users can mute per plugin in 设置 → 通知与状态栏 — treat it as a mutable hint, not a
   *  data channel. error level is sticky (manual close) by default. Old hosts lack this API:
   *  always call as `ctx.notify?.(…)`. For persistent state prefer registerStatusItem. */
  notify?(message: string, opts?: { level?: 'info' | 'success' | 'warning' | 'error'; title?: string; sticky?: boolean }): void
  /** Declare a tunable setting (rendered on the plugin detail page; localStorage-backed). */
  registerSetting(def: SettingContribution): void
  /** Register a custom Database property/column type (Obsidian-style open extension point). */
  registerPropertyType(def: PropertyTypeContribution): void
  /** Achievements: register a series and bump its counters. Series/achievement ids and events
   *  are auto-prefixed `plugin:<pluginId>:` (can't collide with or forge official ones). */
  achievements: {
    registerSeries(def: AchievementSeriesContribution): void
    track(event: string, n?: number): void
  }
  /** Activity log: report user actions inside the plugin's UI to the local activity journal
   *  (feeds background agents like Muse). Events are auto-prefixed `plugin:<pluginId>:`;
   *  `detail` values are sanitized/truncated by the host (`text` key = trailing snippet). */
  activity?: {
    log(event: string, detail?: Record<string, unknown>): void
  }
}

export interface AmadeusPlugin {
  id: string
  name: string
  version: string
  description?: string
  /** Built-in plugins ship with the app and can't be uninstalled (only disabled). */
  builtin?: boolean
  /** Manifest apiVersion (missing → 1). */
  apiVersion?: number
  minAppVersion?: string
  /** Companion app id (manifest.requiresApp); detail page renders install/probe UI when whitelisted in KNOWN_APPS. */
  requiresApp?: string
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
