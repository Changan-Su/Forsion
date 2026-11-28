/**
 * 绑定范围的几样纯计算(智库同步第 2 步 U 包;范围语义同 Extend 引擎:page = `X.md` + `X.fd/`,folder = 子树,file = 那一个)。
 * 右键「同步这篇… / 同步这个文件夹…」沿用今天开启弹窗的关联闭包和缺省勾选(契约 §3.10、Codex 15):
 * 关联笔记、附件、子页面缺省全勾,上次显式剔除的子页面保持剔除。单测在 v2.test.ts。
 */
import type { BindingScope, ScopeItem, ScopeItemKind } from './types'

const noSlash = (p: string): string => p.replace(/^\/+|\/+$/g, '')
const pageDir = (p: string): string | null => (/\.md$/i.test(p) ? `${p.slice(0, -3)}.fd/` : null)

/** 一项覆盖不覆盖 path(path 是库内相对路径)。 */
export function itemCovers(it: ScopeItem, path: string): boolean {
  const p = noSlash(path), s = noSlash(it.path)
  if (it.kind === 'file') return p === s
  if (it.kind === 'folder') return p === s || p.startsWith(`${s}/`)
  const dir = pageDir(s)
  return p === s || (!!dir && (p.startsWith(dir) || p === dir.slice(0, -1)))
}

function excluded(scope: BindingScope, path: string): boolean {
  if (scope.mode !== 'some') return false
  const p = noSlash(path)
  return (scope.exclude ?? []).some((e) => { const x = noSlash(e); const dir = pageDir(x); return p === x || p.startsWith(`${x}/`) || (!!dir && p.startsWith(dir)) })
}

/** 在不在范围里:explicit = 范围里正好有这一项(可以「停止同步这一项」);covered = 被别的项盖住(或整个库)。 */
export function scopeCovers(scope: BindingScope | null | undefined, path: string): 'explicit' | 'covered' | false {
  if (!scope) return false
  if (scope.mode === 'all') return 'covered'
  if (excluded(scope, path)) return false
  const p = noSlash(path)
  if (scope.items.some((it) => noSlash(it.path) === p)) return 'explicit'
  return scope.items.some((it) => itemCovers(it, p)) ? 'covered' : false
}

/** 去掉正好这一项(引擎认的「纯收缩」:同路径同类、旧排除一个不少)。不是显式项 / 去掉后一项不剩 → null。 */
export function removeItem(scope: BindingScope, path: string): BindingScope | null {
  if (scope.mode !== 'some') return null
  const p = noSlash(path)
  const items = scope.items.filter((it) => noSlash(it.path) !== p)
  if (items.length === scope.items.length || !items.length) return null
  return { mode: 'some', items, ...(scope.exclude?.length ? { exclude: scope.exclude } : {}) }
}

/** 今天开启弹窗的关联闭包(window.amadeusSync.entrySyncClosure 的回复)→ 要加进范围的项与要剔除的子页面。 */
export function closureItems(
  path: string, kind: ScopeItemKind,
  closure: { pages: string[]; files: string[]; subPages?: string[] } | null,
  excludedBefore: (p: string) => boolean,
): { items: ScopeItem[]; exclude: string[] } {
  const items: ScopeItem[] = [{ path: noSlash(path), kind }]
  if (!closure || kind === 'file') return { items, exclude: [] }
  for (const p of closure.pages) items.push({ path: noSlash(p), kind: 'page' })
  for (const f of closure.files) items.push({ path: noSlash(f), kind: 'file' })
  // 子页面随页进范围;上次剔除过的保持剔除(否则重开会显示「全含」而实际仍排除,同今天弹窗)
  const exclude = (closure.subPages ?? []).map(noSlash).filter(excludedBefore)
  return { items, exclude }
}

/** 已有范围 + 新加的项 → 新范围(去重;被新项显式点名的路径从排除里拿掉)。整个库 → 原样。 */
export function mergeScope(cur: BindingScope | null | undefined, add: ScopeItem[], addExclude: string[] = []): BindingScope {
  if (cur?.mode === 'all') return cur
  const items: ScopeItem[] = []
  const seen = new Set<string>()
  for (const it of [...(cur?.mode === 'some' ? cur.items : []), ...add]) {
    const k = noSlash(it.path)
    if (seen.has(k)) continue
    seen.add(k)
    items.push({ path: k, kind: it.kind })
  }
  const named = new Set(add.map((a) => noSlash(a.path)))
  const exclude = [...new Set([...(cur?.mode === 'some' ? cur.exclude ?? [] : []), ...addExclude].map(noSlash))].filter((e) => !named.has(e))
  return { mode: 'some', items, ...(exclude.length ? { exclude } : {}) }
}

/** 新范围里比旧范围多出来的项(汇总卡上标「刚勾上」)。 */
export function addedItems(prev: BindingScope | null | undefined, next: BindingScope): ScopeItem[] {
  if (next.mode !== 'some') return []
  return next.items.filter((it) => !scopeCovers(prev ?? null, it.path))
}

/** 当前库的页面与附件清单 → 顶层的文件夹与文件(范围清单里列出来给人勾)。 */
export function topLevelEntries(pages: string[], files: string[]): ScopeItem[] {
  const folders = new Set<string>()
  const out: ScopeItem[] = []
  const pageSet = new Set(pages.map(noSlash))
  for (const raw of [...pages, ...files]) {
    const p = noSlash(raw)
    if (!p || p.startsWith('.')) continue
    const i = p.indexOf('/')
    if (i > 0) {
      const top = p.slice(0, i)
      // 页面的子页面目录 X.fd 跟着 X.md 走,不单列
      if (top.endsWith('.fd') && pageSet.has(`${top.slice(0, -3)}.md`)) continue
      if (!top.startsWith('.')) folders.add(top)
    } else out.push({ path: p, kind: /\.md$/i.test(p) ? 'page' : 'file' })
  }
  const cmp = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  return [...[...folders].sort(cmp).map((f) => ({ path: f, kind: 'folder' as const })), ...out.sort((a, b) => cmp(a.path, b.path))]
}
