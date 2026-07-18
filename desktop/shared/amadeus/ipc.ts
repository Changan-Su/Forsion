// The IPC contract shared by main (handlers), preload (bridge), and renderer (consumer).
import type { LoadedPage, PageManifest } from './compiler/types'
import type { DbFile } from './db/schema'

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
  openVaultFile: 'vault:open-file',
  exportPdf: 'page:export-pdf',
  externalChange: 'page:external-change',
  search: 'vault:search',
  backlinks: 'vault:backlinks',
  reindex: 'vault:reindex',
  listTags: 'vault:tags',
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
  fetchLinkMeta: 'web:link-meta',
  searchImages: 'web:search-images',
  structureChange: 'vault:structure-change',
  listPlugins: 'plugins:list',
  openPluginsFolder: 'plugins:open-folder',
  scaffoldPlugin: 'plugins:scaffold',
  revealInFileManager: 'shell:reveal',
  dbRead: 'db:read',
  dbWrite: 'db:write',
  dbChange: 'db:external-change',
  drawingRead: 'drawing:read',
  drawingWrite: 'drawing:write',
  setPageFrontmatter: 'page:set-frontmatter',
  listPageProps: 'vault:page-props',
  renamePageFile: 'page:rename-file',
  renameDbFile: 'db:rename-file',
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

/** Declarative first-run onboarding a plugin ships in its manifest (`onboarding` key).
 *  Rendered by the host as a setup card on first enable; skipping leaves a badge + one inbox nudge. */
export interface PluginOnboardingSpec {
  /** One-liner shown at the top of the setup card. */
  intro?: string
  steps?: PluginOnboardingStep[]
  /** true = embed all of the plugin's registered settings in the card; or a list of setting keys. */
  settings?: boolean | string[]
  recommends?: PluginOnboardingRecommend[]
}

const REC_TYPES = new Set(['skill', 'agent', 'plugin', 'space', 'theme', 'amadeus-plugin'])
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
  if (Array.isArray(r.steps)) {
    const steps: PluginOnboardingStep[] = []
    for (const s of r.steps.slice(0, 8)) {
      const title = str((s as Record<string, unknown>)?.title, 120)
      if (!title) continue
      const description = str((s as Record<string, unknown>)?.description, 500)
      steps.push(description ? { title, description } : { title })
    }
    if (steps.length) out.steps = steps
  }
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
  return out.intro || out.steps || out.settings || out.recommends ? out : undefined
}

/** A user (Forsion) plugin discovered under ~/.forsion/plugins/. */
export interface ExternalPluginSource {
  id: string
  name: string
  version: string
  description?: string
  /** The plugin's main JS source; evaluated in the renderer with a `ctx` argument. '' when blocked (never evaluated). */
  code: string
  /** Manifest apiVersion (missing → 1). */
  apiVersion: number
  minAppVersion?: string
  /** Companion app this plugin needs (manifest.requiresApp); only ids in the host KNOWN_APPS table get install UI. */
  requiresApp?: string
  /** README.md content from the plugin folder (capped), for the settings detail page. */
  readme?: string
  /** Declarative first-run setup card (manifest `onboarding`, sanitized by the main process). */
  onboarding?: PluginOnboardingSpec
  /** Present → listed but not loadable: 'api' = apiVersion mismatch, 'minApp' = app too old. */
  blocked?: 'api' | 'minApp'
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

/** A note that links to the active page via a [[wikilink]]. */
export interface BacklinkRef {
  path: string
  title: string
  /** The sentence/line containing the [[link]]. */
  snippet: string
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
export type DbReadResult =
  | { status: 'ok'; path: string; data: DbFile } // path = 解析后的 vault 相对路径,后续写回用它
  | { status: 'missing' }
  | { status: 'corrupt'; path: string; message: string }

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
  favicon?: string
  siteName?: string
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
   *  Returns the page-folder-relative path, e.g. ".amadeus/img-xyz.png". */
  saveAsset(pagePath: string, fileName: string, bytes: Uint8Array): Promise<string>
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
  ): Promise<{ pageRel: string; base: string }>
  /** Open an attachment (ref = page-relative path or bare basename) with the OS default app. */
  openAttachment(pagePath: string, ref: string): Promise<void>
  /** Open an EXACT vault-relative path with the OS default app(树/侧栏用:不做 URL 解码、不做 basename 兜底搜索). */
  openVaultFile(vaultRel: string): Promise<void>
  /** 把当前窗口按 @media print 样式打成 PDF(渲染端先挂好 #amx-print-root 克隆);
   *  弹保存对话框,成功返回保存路径并在文件管理器中显示,取消返回 null。 */
  exportPdf(defaultName: string): Promise<string | null>
  /** Subscribe to external main.md changes. Returns an unsubscribe function. */
  onExternalChange(cb: (pagePath: string) => void): () => void
  /** Full-text search across the vault (main-process index). */
  search(query: string): Promise<SearchHit[]>
  /** Notes that link to `pagePath` via a [[wikilink]]. */
  backlinks(pagePath: string): Promise<BacklinkRef[]>
  /** Force a full rebuild of the vault index. */
  reindex(): Promise<void>
  /** All tags in the vault with their note counts. */
  listTags(): Promise<TagCount[]>
  /** Page paths that carry the given tag. */
  pagesByTag(tag: string): Promise<string[]>
  /** Delete a page and all its sidecar files. */
  deletePage(pagePath: string): Promise<void>
  /** Move a page into another folder ('' = vault root); returns its new path. */
  movePage(pagePath: string, destFolder: string): Promise<string>
  /** Resolve a `![[ ]]` block embed target (by basename) to its content + owning note. */
  resolveEmbed(target: string): Promise<EmbedResolved | null>
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
  /** 页面 emoji 图标表(fm icon: 键;可选:桌面索引提供,其余端优雅缺位)。 */
  pageIcons?(): Promise<Record<string, string>>
  /** 抓取链接 og 元数据(书签卡;可选:桌面主进程实现,缺位端卡片降级纯链接)。 */
  fetchLinkMeta?(url: string): Promise<LinkMeta | null>
  /** 封面图搜索(Openverse 免 key;可选:桌面主进程实现,缺位端只留 URL/上传两来源)。 */
  searchImages?(query: string): Promise<Array<{ thumb: string; full: string; author?: string }>>
  /** Subscribe to vault structure changes (pages/folders added/removed). Returns unsubscribe. */
  onStructureChange(cb: () => void): () => void
  /** Subscribe to external `.db` content changes (e.g. the agent editing calendars on disk). Returns unsubscribe. */
  onDbExternalChange(cb: (dbPath: string) => void): () => void
  /** Discover user plugins under the vault's .amadeus/plugins/ folder. */
  listPlugins(): Promise<ExternalPluginSource[]>
  /** Open the vault's plugins folder in the OS file manager (creating it if needed). */
  openPluginsFolder(): Promise<void>
  /** Write a runnable sample plugin into the plugins folder. */
  scaffoldSamplePlugin(): Promise<void>
  /** Reveal a vault-relative file/folder in the OS file manager (Finder/Explorer), selecting it. */
  revealInFileManager(targetPath: string): Promise<void>
  /** 解析 `![[xxx.db]]` 目标(basename 或页相对路径,与附件同一解析语义)并读取数据库。 */
  readDatabase(pagePath: string, ref: string): Promise<DbReadResult>
  /** 按 `db:read` 返回的确切 vault 相对路径原子写回(主进程 schema 校验,坏数据拒写)。 */
  writeDatabase(dbPath: string, data: DbFile): Promise<void>
  /** Excalidraw 画板(`.excalidraw.md` / 裸 `.excalidraw`)读原文;ref 与附件同一 basename 语义。 */
  readDrawing(pagePath: string, ref: string): Promise<DrawingReadResult>
  /** 按 `drawing:read` 返回的确切 vault 相对路径原子写回(记自写账本,watcher 不把自己的写当外部改动)。 */
  writeDrawing(drawingPath: string, source: string): Promise<void>
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
