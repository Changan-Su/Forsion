/**
 * 公开分享页(/share/<token>)的只读 `window.amadeus` 桥(2026-09-07,P4 只读编辑器)。
 *
 * 读全部走 `/api/amadeus/public/shares/:token/{file,tree,asset}`(无鉴权;范围由服务端按发布模式守卫:
 * page = 根页 + <stem>.fd/** + 同目录 .amadeus 二进制;subtree = 前缀;本页 `![[…]]` 显式引用的文件按名放行)。
 * 写方法一律 reject(ShareReadOnlyError)—— UnifiedPage 的 `readOnly` 是第一道闸(源头就不发),
 * 这里是第二道(发了也拒)。事件订阅返回空退订;可选能力(exportCsv / pageIcons / fetchLinkMeta / 回收站 /
 * 插件数据…)刻意缺位,渲染层按契约优雅降级。
 *
 * ⚠️ 必须在任何拉到 `amadeus/api.ts` 的模块求值**之前**装上:api.ts 模块级抓 window.amadeus,
 *    dbStore / noteViewStore 也在模块级看它订阅事件 —— sharePage 装完桥再动态 import shareViewer。
 * ⚠️ 不用「兜底 Proxy 一律 reject」:渲染层对可选方法是 `x?.()` 调用,返回形状各异(订阅要退订函数、
 *    pageIcons 要对象),Proxy 给的 Promise 会在这些点炸出未捕获拒绝。逐个显式声明。
 */
import type { AmadeusApi, DbReadResult, DrawingReadResult, EmbedResolved, PageProps, VaultInfo } from '@amadeus-shared/ipc'
import type { LoadedPage } from '@amadeus-shared/compiler/types'
import { parsePageSource } from '@amadeus-shared/compiler/page'
import { parseBody } from '@amadeus-shared/compiler/markers'
import { parseFrontmatter, stripFrontmatter } from '@amadeus-shared/compiler/split'
import { stripPageBasename } from '@amadeus-shared/compiler/names'
import { parseDb } from '@amadeus-shared/db/schema'
import { pageKey } from '@amadeus-shared/links'
import { setAssetUrlBuilder } from '@amadeus-shared/assets'

export interface ShareTree { root: string; pages: string[]; folders: string[] }

export interface ShareBridgeCfg {
  apiBase: string
  token: string
  /** 分享范围内的页/文件夹(subtree 模式 = 前缀内全部;page 模式 = 根页 + .fd 子页)。 */
  tree: () => ShareTree
  /** 当前打开的页(vault 相对路径):资产 URL 与 db/画板引用按它的目录解析(服务端 `page=` 参数)。 */
  currentPage: () => string | null
  /** 测试注入;缺省 globalThis.fetch。 */
  fetch?: typeof fetch
}

export class ShareReadOnlyError extends Error {
  constructor(op: string) {
    super(`share viewer is read-only: ${op}`)
    this.name = 'ShareReadOnlyError'
  }
}

const nowIso = (): string => new Date().toISOString()
const dirOf = (p: string): string => p.split('/').slice(0, -1).join('/')

/** 页相对 / 裸名引用 → vault 相对路径的**最佳猜测**(页目录拼接 + `..` 归一;只用作读结果里的 path 字段,
 *  真正的解析在服务端 /asset 上做 —— 那边还有「本页显式引用的 basename 跨目录放行」这一手)。 */
export function resolveRefPath(pagePath: string, ref: string): string {
  const raw = ref.trim().replace(/^!?\[\[/, '').replace(/\]\]$/, '').split('|')[0].split('#')[0].trim()
  const joined = raw.startsWith('/') ? raw.slice(1) : [dirOf(pagePath), raw].filter(Boolean).join('/')
  const out: string[] = []
  for (const seg of joined.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') { out.pop(); continue }
    out.push(seg)
  }
  return out.join('/')
}

// ── 块嵌入解析(镜像 server/microserver/amadeus/lib/indexing.ts 的 parseEmbedTarget / findBlock)────────
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
const normId = (s: string): string => s.trim().replace(/\.block$/i, '').toLowerCase()

export function parseEmbedTarget(target: string): { noteKey: string | null; id: string } {
  const hash = target.lastIndexOf('#')
  if (hash < 0) return { noteKey: null, id: normId(target) }
  const note = target.slice(0, hash).trim()
  return { noteKey: note ? pageKey(note) : null, id: normId(target.slice(hash + 1)) }
}

/** 有 amadeus_ 前缀 fm 键 = v3/结构化家族(锚辖域至下一锚);无 = v4 素文件(锚是惰性的,只命名紧随的一个单元)。 */
function hasAmadeusFm(raw: string): boolean {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1]
  return !!fm && fm.split('\n').some((l) => /^["']?amadeus_/.test(l))
}

function firstBlockUnit(content: string): string {
  const lines = content.split('\n')
  let i = 0
  while (i < lines.length && !lines[i].trim()) i++
  if (i >= lines.length) return ''
  const fence = FENCE_RE.exec(lines[i])
  const out: string[] = []
  if (fence) {
    const mark = fence[1][0]
    out.push(lines[i])
    for (i++; i < lines.length; i++) {
      out.push(lines[i])
      const close = FENCE_RE.exec(lines[i])
      if (close && close[1][0] === mark) break
    }
    return out.join('\n')
  }
  for (; i < lines.length && lines[i].trim(); i++) out.push(lines[i])
  return out.join('\n')
}

/** `[[note#标题]]` 回退:标题文字精确匹配(大小写不敏感)→ 整个小节(至下一同级或更高级标题);围栏内的 `#` 行不当标题。 */
function findHeadingSection(body: string, id: string): string | null {
  const lines = body.split('\n')
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const f = FENCE_RE.exec(lines[i])
    if (f && (!fence || f[1][0] === fence)) {
      fence = fence ? null : f[1][0]
      continue
    }
    if (fence) continue
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i])
    if (!h || h[2].trim().toLowerCase() !== id) continue
    const level = h[1].length
    const out = [lines[i]]
    let inner: string | null = null
    for (let j = i + 1; j < lines.length; j++) {
      const jf = FENCE_RE.exec(lines[j])
      if (jf && (!inner || jf[1][0] === inner)) {
        inner = inner ? null : jf[1][0]
        out.push(lines[j])
        continue
      }
      if (!inner) {
        const hj = /^(#{1,6})\s/.exec(lines[j])
        if (hj && hj[1].length <= level) break
      }
      out.push(lines[j])
    }
    return out.join('\n').trimEnd()
  }
  return null
}

export function findEmbedBlock(raw: string, id: string): string | null {
  const body = stripFrontmatter(raw)
  for (const b of parseBody(body)) {
    if (b.id && b.id.toLowerCase() === id) return hasAmadeusFm(raw) ? b.content : firstBlockUnit(b.content)
  }
  return findHeadingSection(body, id)
}

export function createShareBridge(cfg: ShareBridgeCfg): AmadeusApi {
  const doFetch: typeof fetch = cfg.fetch ?? ((...args) => fetch(...args))
  const base = `${cfg.apiBase}/amadeus/public/shares/${encodeURIComponent(cfg.token)}`
  const deny = <T = never>(op: string) => (): Promise<T> => Promise.reject(new ShareReadOnlyError(op))
  const unsub = (): (() => void) => () => {}
  const pages = (): string[] => cfg.tree().pages

  /** 页面原文缓存(null = 404):发布内容对访客是静态的,同一页在路由 / 挂载补读 / 嵌入 / 悬停预览之间只拉一次。 */
  const textCache = new Map<string, Promise<string | null>>()
  const fetchText = (p: string): Promise<string | null> => {
    let hit = textCache.get(p)
    if (!hit) {
      hit = (async () => {
        const r = await doFetch(`${base}/file?path=${encodeURIComponent(p)}`)
        if (r.status === 404) return null
        if (!r.ok) throw new Error(`share file ${r.status}`)
        const j = (await r.json()) as { content?: string }
        return typeof j.content === 'string' ? j.content : ''
      })()
      textCache.set(p, hit)
      hit.catch(() => textCache.delete(p)) // 网络瞬断不缓存失败,下次再试
    }
    return hit
  }

  const assetUrl = (ref: string, page: string | null): string => {
    const q = new URLSearchParams({ ref })
    if (page) q.set('page', page)
    return `${base}/asset?${q.toString()}`
  }
  /** 范围内资产(图片 / db / 画板 / PDF…):404 → null。 */
  const fetchAsset = async (ref: string, page: string | null): Promise<Response | null> => {
    const r = await doFetch(assetUrl(ref, page))
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`share asset ${r.status}`)
    return r
  }

  const readPage = async (pagePath: string): Promise<LoadedPage> => {
    const raw = await fetchText(pagePath)
    if (raw == null) throw new Error(`not found: ${pagePath}`)
    return parsePageSource(pagePath, raw, nowIso())
  }

  const vaultInfo = (): VaultInfo => ({ root: `share:${cfg.token}`, pages: pages(), folders: cfg.tree().folders })

  const api: AmadeusApi = {
    openVault: async () => vaultInfo(),
    restoreVault: async () => vaultInfo(),
    listPages: async () => pages(),
    listFiles: async () => [],
    listFolders: async () => cfg.tree().folders,
    loadPage: readPage,
    readPage,
    reconcilePage: (pagePath) => readPage(pagePath), // 回灌 = 重读(只读桥没有「盘上被改」这回事,给的仍是同一份)
    newPage: deny('newPage'),
    savePage: deny('savePage'),
    renamePage: deny('renamePage'),
    saveAsset: deny('saveAsset'),
    saveVaultBytes: deny('saveVaultBytes'),
    readVaultBytes: async (p) => {
      const r = await fetchAsset(p, cfg.currentPage())
      if (!r) throw new Error(`not found: ${p}`)
      return new Uint8Array(await r.arrayBuffer())
    },
    saveAttachment: deny('saveAttachment'),
    openAttachment: async (pagePath, ref) => { window.open(assetUrl(ref, pagePath), '_blank', 'noopener') },
    openVaultFile: async (rel) => { window.open(assetUrl(rel, null), '_blank', 'noopener') },
    exportPdf: async () => { window.print(); return null },
    onExternalChange: unsub,
    onStructureChange: unsub,
    onDbExternalChange: unsub,
    search: async () => [],
    backlinks: async () => [],
    reindex: async () => {},
    listTags: async () => [],
    pagesByTag: async () => [],
    deletePage: deny('deletePage'),
    movePage: deny('movePage'),
    resolveEmbed: async (target): Promise<EmbedResolved | null> => {
      const { noteKey, id } = parseEmbedTarget(target)
      if (!id) return null
      // 指名笔记 → 只看同 pageKey 的;没指名 → 当前页优先,再扫范围内其余页(与服务端「全库可读页」同序,只是范围更小)。
      const cur = cfg.currentPage()
      const all = pages()
      const candidates = noteKey
        ? all.filter((p) => pageKey(p) === noteKey)
        : [...(cur && all.includes(cur) ? [cur] : []), ...all.filter((p) => p !== cur)]
      for (const p of candidates) {
        const raw = await fetchText(p)
        if (raw == null) continue
        const content = findEmbedBlock(raw, id)
        if (content !== null) return { owner: p, content, type: 'markdown' }
      }
      return null
    },
    blockBacklinks: async () => [],
    createFolder: deny('createFolder'),
    renameFolder: deny('renameFolder'),
    deleteFolder: deny('deleteFolder'),
    moveFolder: deny('moveFolder'),
    listPlugins: async () => [],
    openPluginsFolder: async () => {},
    scaffoldSamplePlugin: async () => {},
    revealInFileManager: async () => {},
    readDatabase: async (pagePath, ref): Promise<DbReadResult> => {
      const r = await fetchAsset(ref, pagePath)
      if (!r) return { status: 'missing' }
      const path = resolveRefPath(pagePath, ref)
      const parsed = parseDb(await r.text())
      return parsed.ok ? { status: 'ok', path, data: parsed.data } : { status: 'corrupt', path, message: parsed.error }
    },
    writeDatabase: deny('writeDatabase'),
    readDrawing: async (pagePath, ref): Promise<DrawingReadResult> => {
      // Obsidian 链接省略 .md:`![[Foo.excalidraw]]` 实指 Foo.excalidraw.md → 原样先试,落空补 .md(桌面 / 云桥同款)。
      for (const candidate of /\.md$/i.test(ref) ? [ref] : [ref, `${ref}.md`]) {
        const r = await fetchAsset(candidate, pagePath)
        if (r) return { status: 'ok', path: resolveRefPath(pagePath, candidate), source: await r.text() }
      }
      return { status: 'missing' }
    },
    writeDrawing: deny('writeDrawing'),
    readTextFile: (p) => fetchText(p),
    writeTextFile: deny('writeTextFile'),
    // 「笔记视图」(source=folder 的多维表):行 = 该文件夹直属子页 —— 范围内的名册 + 各页 frontmatter(缓存命中)。
    listPageProps: async (folder): Promise<PageProps[]> => {
      const dir = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      const rows = pages().filter((p) => dirOf(p) === dir)
      const out: PageProps[] = []
      for (const p of rows) {
        const raw = await fetchText(p)
        if (raw == null) continue
        out.push({ path: p, title: stripPageBasename(p), fm: parseFrontmatter(raw) })
      }
      return out
    },
    setPageFrontmatter: deny('setPageFrontmatter'),
    renamePageFile: deny('renamePageFile'),
    renameDbFile: deny('renameDbFile'),
  }
  return api
}

/** 装成 window.amadeus + 把渲染层 toAssetUrl 接到公开资产端点(ref = vault 相对路径,带上当前页做范围与兜底解析)。 */
export function installShareBridge(cfg: ShareBridgeCfg): AmadeusApi {
  const api = createShareBridge(cfg)
  setAssetUrlBuilder((ref) => {
    const q = new URLSearchParams({ ref })
    const page = cfg.currentPage()
    if (page) q.set('page', page)
    return `${cfg.apiBase}/amadeus/public/shares/${encodeURIComponent(cfg.token)}/asset?${q.toString()}`
  })
  if (typeof window !== 'undefined') window.amadeus = api
  return api
}
