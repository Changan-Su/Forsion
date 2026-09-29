// 标题 / 列表折叠的**命令动作与本机记忆**(B-13,评审 2026-09-27;拍板 #4)。命令定义本身在
// foldCommands.ts(轻模块,开机就进命令集;这里连着 Milkdown,只随编辑器分块加载,命令执行时再懒取)。
//
//  · 命令没有 view 参数 → 作用在「焦点所在、否则最近一次聚焦过」的统一编辑器上(createFoldMemory 记账)。
//  · 折叠状态按「智库 + 路径」记在本机 localStorage(与 viewMemory 的笔记模式同一把 noteMemoryId),
//    重开 / 切源码再切回 / 切走再切回都复原;md 一个字不碰。锚不能存文档坐标(外部改一行就全错位),
//    存的是「级别 + 文字 + 同名第几个」这种内容指纹;对不上的指纹直接丢,宁可少折不许折错。
import { $prose } from '@milkdown/kit/utils'
import { NodeSelection, Plugin, Selection } from '@milkdown/kit/prose/state'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { foldableHeadings, headingFoldKey, hiddenRanges } from './headingFold'
import { foldableListItems, listFoldKey, listHiddenRangesOf } from './listFold'
import { noteMemoryId } from './viewMemory'
import { effectiveHotkey, eventToHotkey } from '@lcl/engine'
import { FOLD_BINDINGS } from './foldCommands'

// ── 目标编辑器:焦点所在的那个;命令面板抢走焦点时退回最近一次聚焦过的。──────────────
const liveViews = new Set<EditorView>()
let lastFocused: EditorView | null = null

function activeView(): EditorView | null {
  const ae = typeof document !== 'undefined' ? document.activeElement : null
  if (ae) for (const v of liveViews) if (v.dom.contains(ae)) return v
  return lastFocused && lastFocused.dom.isConnected ? lastFocused : null
}

// ── 三条命令的事务(纯函数:state → tr | null)。──────────────────────────────────────

type Target = { kind: 'heading' | 'list'; pos: number }

/** 光标 / 块选中要切换的那一处:最内层可折叠的列表项 → 光标所在的标题 → 光标所在小节的标题。
 *  第三档让「正文里按一下 = 收起这一节」成立(Obsidian 同);光标本身在标题上时不越级找上一节。 */
function toggleTarget(state: EditorState): Target | null {
  const heads = new Set(foldableHeadings(state.doc))
  const items = new Set(foldableListItems(state.doc))
  const sel = state.selection
  if (sel instanceof NodeSelection) {
    if (heads.has(sel.from)) return { kind: 'heading', pos: sel.from }
    if (items.has(sel.from)) return { kind: 'list', pos: sel.from }
    return null
  }
  const $f = sel.$from
  for (let d = $f.depth; d >= 1; d--) {
    if ($f.node(d).type.name === 'list_item' && items.has($f.before(d))) return { kind: 'list', pos: $f.before(d) }
  }
  if ($f.parent.type.name === 'heading') {
    const at = $f.before($f.depth)
    return heads.has(at) ? { kind: 'heading', pos: at } : null
  }
  // 小节:逐层往外,在光标所在块的**同一容器**里往前找最近的标题 —— 它和光标之间没有别的标题,
  // 小节必然盖到光标(sectionEndIndex 的口径)。
  for (let d = $f.depth; d >= 1; d--) {
    const parent = $f.node(d - 1)
    let at = $f.start(d - 1)
    let found: number | null = null
    for (let i = 0; i < $f.index(d - 1); i++) {
      if (parent.child(i).type.name === 'heading') found = at
      at += parent.child(i).nodeSize
    }
    if (found != null) return heads.has(found) ? { kind: 'heading', pos: found } : null
  }
  return null
}

/** 折完光标若落进隐藏区,挪到盖住它的最外层折叠的「头」末尾(标题末 / 列表项首段末)。不交给两个
 *  fold 层的光标守卫 —— 守卫按移动方向把光标推到**下一节**,用户手上这一行就跳走了。 */
function caretOutOfHidden(tr: Transaction, headings: number[], lists: number[]): void {
  const sel = tr.selection
  if (!sel.empty) return
  const ranges = [...hiddenRanges(tr.doc, headings), ...listHiddenRangesOf(tr.doc, lists)]
    .filter((rg) => sel.from > rg.start && sel.from < rg.after)
    .sort((a, b) => a.start - b.start)
  if (!ranges.length) return
  tr.setSelection(Selection.near(tr.doc.resolve(ranges[0].start), -1))
}

function foldSets(state: EditorState): { headings: number[]; lists: number[] } {
  return {
    headings: headingFoldKey.getState(state)?.folded ?? [],
    lists: listFoldKey.getState(state)?.folded ?? [],
  }
}

/** 同一笔事务把两层折叠态一起定死(meta `set`),再保证光标看得见。 */
function setFoldsTr(state: EditorState, headings: number[], lists: number[]): Transaction {
  const tr = state.tr.setMeta(headingFoldKey, { set: headings }).setMeta(listFoldKey, { set: lists }).setMeta('addToHistory', false)
  caretOutOfHidden(tr, headings, lists)
  return tr
}

export function toggleFoldTr(state: EditorState): Transaction | null {
  const t = toggleTarget(state)
  if (!t) return null
  const cur = foldSets(state)
  const flip = (arr: number[]): number[] => (arr.includes(t.pos) ? arr.filter((p) => p !== t.pos) : [...arr, t.pos])
  return setFoldsTr(state, t.kind === 'heading' ? flip(cur.headings) : cur.headings, t.kind === 'list' ? flip(cur.lists) : cur.lists)
}

export function foldAllTr(state: EditorState): Transaction | null {
  const headings = foldableHeadings(state.doc)
  const lists = foldableListItems(state.doc)
  if (!headings.length && !lists.length) return null
  return setFoldsTr(state, headings, lists)
}

export function unfoldAllTr(state: EditorState): Transaction | null {
  const cur = foldSets(state)
  if (!cur.headings.length && !cur.lists.length) return null
  return setFoldsTr(state, [], [])
}

const BUILD: Record<FoldCommandKind, (state: EditorState) => Transaction | null> = { toggle: toggleFoldTr, foldAll: foldAllTr, unfoldAll: unfoldAllTr }

function runOn(view: EditorView, kind: FoldCommandKind): void {
  const tr = BUILD[kind](view.state)
  if (tr) view.dispatch(tr.scrollIntoView())
  view.focus()
}

/** 热键串归一(修饰键排序):'mod+alt+enter' 与 eventToHotkey 产出的顺序不必一致。 */
function normHotkey(hk: string): string {
  const parts = hk.toLowerCase().split('+').map((p) => p.trim())
  const key = parts.pop() ?? ''
  return [...parts.sort(), key].join('+')
}

/** 编辑器内按键 → 折叠命令(与引擎命令同一份生效热键,含用户改键 / 解绑)。 */
function foldKindOfEvent(event: KeyboardEvent): FoldCommandKind | null {
  if (event.isComposing) return null
  const hk = eventToHotkey(event)
  if (!hk) return null
  const got = normHotkey(hk)
  for (const b of FOLD_BINDINGS) {
    const want = effectiveHotkey(b)
    if (want && normHotkey(want) === got) return b.kind
  }
  return null
}

export type FoldCommandKind = 'toggle' | 'foldAll' | 'unfoldAll'

/** foldCommands.ts 的三条命令执行到这里(命令面板 / 焦点不在正文时的全局热键;懒取本模块,与编辑器共用同一份记账)。 */
export function runFoldCommand(kind: FoldCommandKind): void {
  const view = activeView()
  if (view) runOn(view, kind)
}

// ── 本机记忆:内容指纹 ⇄ 文档坐标。────────────────────────────────────────────────

const FOLD_PREFIX = 'amx.noteFold:'
const MAX_KEYS = 500
const foldKey = (vaultRoot: string | null | undefined, path: string): string => `${FOLD_PREFIX}${noteMemoryId(vaultRoot, path)}`

/** 标题 = `h级别:文字`,列表项 = `l:首段文字`,再按文档序数同名第几个(`#n`)。 */
function walkFingerprints(doc: ProseNode, visit: (fp: string, kind: 'heading' | 'list', pos: number) => void): void {
  const seen = new Map<string, number>()
  doc.descendants((n, pos) => {
    let base: string | null = null
    if (n.type.name === 'heading') base = `h${Number(n.attrs.level) || 1}:${n.textContent}`
    else if (n.type.name === 'list_item') base = `l:${n.firstChild?.textContent ?? ''}`
    if (base != null) {
      const k = seen.get(base) ?? 0
      seen.set(base, k + 1)
      visit(`${base}#${k}`, n.type.name === 'heading' ? 'heading' : 'list', pos)
    }
    return true
  })
}

export function foldFingerprints(doc: ProseNode, headings: number[], lists: number[]): string[] {
  if (!headings.length && !lists.length) return []
  const hs = new Set(headings)
  const ls = new Set(lists)
  const out: string[] = []
  walkFingerprints(doc, (fp, kind, pos) => { if ((kind === 'heading' ? hs : ls).has(pos)) out.push(fp) })
  return out.slice(0, MAX_KEYS)
}

export function resolveFingerprints(doc: ProseNode, fps: string[]): { headings: number[]; lists: number[] } {
  const want = new Set(fps)
  const headings: number[] = []
  const lists: number[] = []
  if (!want.size) return { headings, lists }
  walkFingerprints(doc, (fp, kind, pos) => { if (want.has(fp)) (kind === 'heading' ? headings : lists).push(pos) })
  return { headings, lists }
}

export function readFoldMemory(vaultRoot: string | null | undefined, path: string): string[] {
  try {
    const raw = localStorage.getItem(foldKey(vaultRoot, path))
    const v = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function writeFoldMemory(vaultRoot: string | null | undefined, path: string, fps: string[]): void {
  try {
    if (fps.length) localStorage.setItem(foldKey(vaultRoot, path), JSON.stringify(fps))
    else localStorage.removeItem(foldKey(vaultRoot, path))
  } catch { /* 私有模式 / 配额满:本次会话的折叠照常,只是不跨重开 */ }
}

/** 行内改名:记忆跟着新路径走(与 remapNoteViewMemory 同一时机调)。 */
export function remapFoldMemory(vaultRoot: string | null | undefined, oldPath: string, newPath: string): void {
  if (oldPath === newPath) return
  const fps = readFoldMemory(vaultRoot, oldPath)
  if (fps.length) {
    writeFoldMemory(vaultRoot, newPath, fps)
    writeFoldMemory(vaultRoot, oldPath, []) // 旧键删掉:旧路径日后新建的笔记不继承这篇的折叠
  }
}

/** 每个 UnifiedPage 一份(闭包现读智库与路径)。挂上即:登记为命令目标、按记忆复原折叠、之后折叠一变就写回。 */
export function createFoldMemory(where: () => { vaultRoot: string | null | undefined; path: string }): MilkdownPlugin[] {
  return [
    $prose(
      () =>
        new Plugin({
          view: (view) => {
            liveViews.add(view)
            let restored = false
            let last = ''
            let timer: ReturnType<typeof setTimeout> | null = null
            const save = (): void => {
              timer = null
              const { vaultRoot, path } = where()
              const f = foldSets(view.state)
              const fps = foldFingerprints(view.state.doc, f.headings, f.lists)
              const s = JSON.stringify(fps)
              if (s === last) return
              last = s
              writeFoldMemory(vaultRoot, path, fps)
            }
            // 编辑器构造期间 Milkdown 还没把 view 交进 ctx,事务推迟到微任务里发(首帧绘制之前,不闪)。
            queueMicrotask(() => {
              if (!liveViews.has(view)) return // 构造完当拍就被拆了
              const { vaultRoot, path } = where()
              const fps = readFoldMemory(vaultRoot, path)
              last = JSON.stringify(fps)
              restored = true
              if (!fps.length) return
              const r = resolveFingerprints(view.state.doc, fps)
              if (r.headings.length || r.lists.length) view.dispatch(setFoldsTr(view.state, r.headings, r.lists))
            })
            return {
              update: (v, prev) => {
                if (!restored) return // 复原之前的变化不许写回,否则先落一份空记忆把旧的冲掉
                if (headingFoldKey.getState(v.state) === headingFoldKey.getState(prev) && listFoldKey.getState(v.state) === listFoldKey.getState(prev)) return
                if (timer) clearTimeout(timer)
                timer = setTimeout(save, 300)
              },
              destroy: () => {
                if (timer) { clearTimeout(timer); save() }
                liveViews.delete(view)
                if (lastFocused === view) lastFocused = null
              },
            }
          },
          props: {
            handleDOMEvents: {
              focus: (view) => {
                lastFocused = view
                return false
              },
            },
            handleKeyDown: (view, event) => {
              const kind = foldKindOfEvent(event)
              if (!kind) return false
              runOn(view, kind)
              return true
            },
          },
        }),
    ),
  ].flat()
}
