/** 全局快速查找(Notion quick-find 式,居中悬浮):按名称模糊搜 笔记 / 文件 / chat 会话,回车打开。
 *  空态显示最近(localStorage 记录,回退最近更新的会话)。ribbon 搜索图标 / ⌘P 唤起;挂在 Root。
 *
 *  分类胶囊(2026-08-20 用户要求):全部 / 笔记 / 文件 / 会话,←/→ 走。
 *
 *  ⚠️ 心智模型是用户给的原话:**分类就像正文后面那几个字**。光标是**一条**线,先走完正文再走分类 ——
 *  `1 2 3 |笔记 文件 会话`。所以:光标顶到正文末尾再按 → 才进分类(第一格 = 笔记);进去之后
 *  ←/→ 就在分类里来回;从第一格再按 ← 就退回正文末尾。第一版写成「两头各自顶到边才切」,左右
 *  不对称 —— 打完字光标本来就在最右,按 → 切得动,想按 ← 切回来却变成一路移光标(用户实报)。
 *  「全部」不是一个要按的格子,它就是**光标还在正文里**的状态(所以 →→ 就到「文件」,不多按一下)。
 *  多维表 .db 归「文件」——它有自己的视图,但用户找它时想的是「那个文件」。 */
import React, { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { create } from 'zustand'
import './quickFind.css'
import { Search, FileText, Database, MessageSquare, File } from 'lucide-react'
import { openSession } from './sessionNav'
import { usePageStore } from './amadeus/store/pageStore'
import { useAllDatabases } from './amadeus/store/dbAggregateStore'
import { fuzzyScore } from './amadeus/lib/fuzzy'
import { useApp } from './stores/appStore'
import { openNote, openDb, openFile } from './amadeusNav'

interface QFState { open: boolean; openPalette(): void; close(): void }
export const useQuickFind = create<QFState>((set) => ({
  open: false,
  openPalette: () => set({ open: true }),
  close: () => set({ open: false }),
}))

type Kind = 'note' | 'db' | 'session' | 'file'

/** 可走的分类格(顺序即 ←/→ 的顺序)。「全部」不在其中 —— 见顶注:它是「光标还在正文里」。 */
type Cat = 'all' | 'note' | 'file' | 'session'
const CATS: Array<{ id: Exclude<Cat, 'all'>; label: string }> = [
  { id: 'note', label: '笔记' },
  { id: 'file', label: '文件' },
  { id: 'session', label: '会话' },
]
/** 胶囊上真正画出来的四格(第 0 格 = 全部 = pos -1)。 */
const SEGS: Array<{ id: Cat; label: string }> = [{ id: 'all', label: '全部' }, ...CATS]
const catOf = (k: Kind): Cat => (k === 'note' ? 'note' : k === 'session' ? 'session' : 'file')
/** 光标位置 → 当前分类。-1 = 还在正文里 = 全部。 */
export const catAt = (pos: number): Cat => (pos < 0 ? 'all' : CATS[Math.min(pos, CATS.length - 1)].id)

/** 左右键按下后光标该落到哪一格;`null` = 这一下归输入框(照旧移动光标/扩选)。
 *  正文与分类是**同一条线**:`…正文 | 笔记 | 文件 | 会话`(pos: -1 = 正文,0.. = 分类格)。
 *  · 在正文里按 → :只有光标顶到正文末尾才跨进第一格,否则移光标
 *  · 在分类里按 →/← :格子间走;左边走到头(第一格再按 ←)= 退回正文末尾
 *  · 右边走到头再按 → :停住(不绕圈)
 *  · 选中着一段字(Shift+←/→ 扩选)一律让给原生 */
export function posOnArrow(pos: number, key: string, caret: { start: number; end: number; len: number }): number | null {
  const dir = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0
  if (!dir) return null
  if (pos < 0) {
    if (dir < 0) return null // 正文里按 ← 永远是移光标
    if (caret.start !== caret.end || caret.start !== caret.len) return null // 还没到正文末尾
    return 0
  }
  if (dir > 0) return pos + 1 >= CATS.length ? null : pos + 1
  return pos - 1 // 可能 = -1:退回正文
}
interface Recent { kind: Kind; id: string; title: string; sub?: string; emoji?: string }
const RKEY = 'forsion.quickfind.recents'
const loadRecents = (): Recent[] => {
  try {
    return JSON.parse(localStorage.getItem(RKEY) || '[]') as Recent[]
  } catch {
    return []
  }
}
const pushRecent = (r: Recent): void => {
  const cur = loadRecents().filter((x) => !(x.kind === r.kind && x.id === r.id))
  try {
    localStorage.setItem(RKEY, JSON.stringify([r, ...cur].slice(0, 24)))
  } catch {
    /* ignore */
  }
}

const base = (p: string): string => (p.split(/[\\/]/).pop() ?? p).replace(/\.(md|db)$/i, '')
/** 文件行显示**带后缀**的文件名:找 pdf/图片时,后缀本身就是用户在找的信息。 */
const fileName = (p: string): string => p.split(/[\\/]/).pop() ?? p
const dirOf = (p: string): string => p.replace(/\\/g, '/').split('/').slice(0, -1).join('/') || '/'

interface Item { kind: Kind; id: string; title: string; sub: string; emoji?: string; open: () => void }

export function QuickFind() {
  const open = useQuickFind((s) => s.open)
  if (!open) return null
  return <QuickFindInner />
}

function QuickFindInner() {
  const close = useQuickFind((s) => s.close)
  const pages = usePageStore((s) => s.pages)
  const files = usePageStore((s) => s.files)
  const dbs = useAllDatabases()
  const sessions = useApp((s) => s.sessions)
  // 光标在这条线上的位置:-1 = 正文(= 全部),0.. = 分类格。每次唤起都从 -1 起(面板关掉即卸载)。
  const [pos, setPos] = useState(-1)
  const cat = catAt(pos)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // 全部候选(名称快切)。open 内构建 → 只在面板打开时加载 .db。
  const all = useMemo<Item[]>(() => {
    const notes: Item[] = pages
      .filter((p) => /\.md$/i.test(p))
      .map((p) => ({ kind: 'note', id: p, title: base(p), sub: dirOf(p), open: () => void openNote(p) }))
    const dbItems: Item[] = dbs.map((d) => ({ kind: 'db', id: d.path, title: d.name || base(d.path), sub: dirOf(d.path), open: () => openDb(d.path) }))
    // 库里的非笔记文件(pdf/图片/画板/插件文件…)。.db 排掉 —— 上面那份带库名,更好认。
    const fileItems: Item[] = files
      .filter((p) => !/\.db$/i.test(p))
      .map((p) => ({ kind: 'file', id: p, title: fileName(p), sub: dirOf(p), open: () => openFile(p) }))
    const sess: Item[] = sessions.map((s) => ({
      kind: 'session',
      id: s.id,
      title: s.title || '未命名会话',
      sub: '会话',
      emoji: s.emoji ?? undefined,
      open: () => openSession(s.id),
    }))
    return [...notes, ...dbItems, ...fileItems, ...sess]
  }, [pages, files, dbs, sessions])

  const results = useMemo<Item[]>(() => {
    const needle = q.trim()
    const inCat = (it: Item): boolean => cat === 'all' || catOf(it.kind) === cat
    if (needle) {
      return all
        .filter(inCat)
        .map((it) => ({ it, s: fuzzyScore(needle, it.title) }))
        .filter((x): x is { it: Item; s: number } => x.s !== null)
        .sort((a, b) => b.s - a.s)
        .slice(0, 30)
        .map((x) => x.it)
    }
    const byKey = new Map(all.map((it) => [`${it.kind}:${it.id}`, it]))
    const recent = loadRecents().map((r) => byKey.get(`${r.kind}:${r.id}`)).filter((x): x is Item => !!x).filter(inCat)
    if (recent.length) return recent.slice(0, 12)
    if (cat !== 'all' && cat !== 'session') return all.filter(inCat).slice(0, 12) // 该分类没最近项 → 直接列它自己
    // 回退:最近更新的会话(唯一有可靠时间戳的源)。
    return [...sessions]
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
      .slice(0, 8)
      .map((s) => byKey.get(`session:${s.id}`))
      .filter((x): x is Item => !!x)
      .filter(inCat)
  }, [q, all, sessions, cat])

  useEffect(() => setSel(0), [q, pos])
  useEffect(() => inputRef.current?.focus(), [])

  const openItem = (it: Item): void => {
    pushRecent({ kind: it.kind, id: it.id, title: it.title, sub: it.sub, emoji: it.emoji })
    it.open()
    close()
  }

  const onKey = (e: ReactKeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); close() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(i + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); const it = results[sel]; if (it) openItem(it) }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const el = inputRef.current
      const next = posOnArrow(pos, e.key, { start: el?.selectionStart ?? 0, end: el?.selectionEnd ?? 0, len: el?.value.length ?? 0 })
      if (next === null) return // 归输入框:移动光标/扩选
      e.preventDefault()
      setPos(next)
      // 退回正文:光标本来就停在末尾(走分类时一步都没动过它),补一次 focus 保证还在输入框里。
      if (next < 0) el?.focus()
    }
  }

  const icon = (k: Kind, emoji?: string): ReactNode =>
    emoji ? <span className="amx-qf-emoji">{emoji}</span>
      : k === 'db' ? <Database size={15} />
        : k === 'session' ? <MessageSquare size={15} />
          : k === 'file' ? <File size={15} />
            : <FileText size={15} />

  return (
    <div className="amx-qf-scrim" onMouseDown={close}>
      <div className="amx-qf" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="amx-qf-head">
          <Search size={16} className="amx-qf-searchicon" />
          <input
            ref={inputRef}
            className="amx-qf-input"
            placeholder="搜索笔记、文件、会话…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            /* 用鼠标把光标点回正文里 = 离开分类格(同一条线上的位置变了),胶囊滑回「全部」。 */
            onMouseUp={() => setPos(-1)}
          />
        </div>
        {/* 分类胶囊:复用「本地|云端」「文档|画布」那颗 `.t2s-vaultseg`(凹轨道 + 滑块弹性平移),
            只是从两格变成四格 —— 格数与当前格走 CSS 变量(见 sidebar2.css)。
            ⚠️ 整条 mousedown preventDefault:点格子不夺焦点,点完还能接着打字。 */}
        <div
          className="t2s-vaultseg amx-qf-seg"
          role="tablist"
          aria-label="搜索范围"
          style={{ '--seg-n': SEGS.length, '--seg-i': pos + 1 } as React.CSSProperties}
        >
          <div className="t2s-vaultseg-thumb" />
          {SEGS.map((c, i) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={c.id === cat}
              className={c.id === cat ? 'on' : ''}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setPos(i - 1); inputRef.current?.focus() }}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="amx-qf-list">
          {!q.trim() && results.length > 0 && <div className="amx-qf-sec">最近</div>}
          {results.map((it, i) => (
            <button
              key={`${it.kind}:${it.id}`}
              className={`amx-qf-row${i === sel ? ' sel' : ''}`}
              onMouseMove={() => setSel(i)}
              onClick={() => openItem(it)}
            >
              <span className="amx-qf-icon">{icon(it.kind, it.emoji)}</span>
              <span className="amx-qf-title">{it.title}</span>
              <span className="amx-qf-sub">{it.sub}</span>
            </button>
          ))}
          {results.length === 0 && <div className="amx-qf-empty">{q.trim() ? '无匹配' : '还没有最近项'}</div>}
        </div>
        <div className="amx-qf-foot"><kbd>↑↓</kbd> 选择 · <kbd>←→</kbd> 分类 · <kbd>↵</kbd> 打开 · <kbd>esc</kbd> 关闭</div>
      </div>
    </div>
  )
}
