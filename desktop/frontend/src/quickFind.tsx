import { amadeusAvailable, sessionsAvailable } from './features/runtime'
/** 全局快速查找(Notion quick-find 式,居中悬浮):按名称模糊搜 笔记 / 文件 / chat 会话,回车打开。
 *  另按正文搜会话:「对话内容」一段 + 右边预览最后 3 轮,⌘↵ 跳到命中那条(10-24 借鉴 Comma §2.8)。
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
import { Search, FileText, Database, MessageSquare, File, Plus } from 'lucide-react'
import { openSession } from './sessionNav'
import { usePageStore } from './amadeus/store/pageStore'
import { useAllDatabases } from './amadeus/store/dbAggregateStore'
import { fuzzyScore } from './amadeus/lib/fuzzy'
import { useApp } from './stores/appStore'
import { openNote, openDb, openFile } from './amadeusNav'
import { registerMessages, useI18n } from './i18n'
import { pageKey } from '@amadeus-shared/links'
import { isImeKeyEvent, isMacPlatform, useExitGhost, useNativeChromeClaim, useNativeChromeInstalled, type NativeChromeClaim } from '@lcl/engine'
import { listMessages, searchSessions, type SessionSearchHit } from './services/backendService'
import { homeTarget, targetForSession } from './services/engine/targets'
import type { MessageRecord } from './types'

registerMessages({
  'quickfind.catAll': { zh: '全部', en: 'All' },
  'quickfind.catNote': { zh: '笔记', en: 'Notes' },
  'quickfind.catFile': { zh: '文件', en: 'Files' },
  'quickfind.catSession': { zh: '会话', en: 'Sessions' },
  'quickfind.subSession': { zh: '会话', en: 'Session' },
  'quickfind.untitledSession': { zh: '未命名会话', en: 'Untitled session' },
  'quickfind.placeholder': { zh: '搜索笔记、文件、会话…', en: 'Search notes, files and sessions…' },
  'quickfind.scopeLabel': { zh: '搜索范围', en: 'Search scope' },
  'quickfind.secPickable': { zh: '可选', en: 'Available' },
  'quickfind.secRecent': { zh: '最近', en: 'Recent' },
  'quickfind.emptyNoMatch': { zh: '无匹配', en: 'No matches' },
  'quickfind.emptyNoPickable': { zh: '库里没有可选的文件', en: 'No selectable files in this vault' },
  'quickfind.emptyNoRecent': { zh: '还没有最近项', en: 'No recent items yet' },
  'quickfind.footSelect': { zh: '选择', en: 'Select' },
  'quickfind.footChoose': { zh: '选中', en: 'Choose' },
  'quickfind.footCancel': { zh: '取消', en: 'Cancel' },
  'quickfind.footScope': { zh: '分类', en: 'Scope' },
  'quickfind.footOpen': { zh: '打开', en: 'Open' },
  'quickfind.footClose': { zh: '关闭', en: 'Close' },
  'quickfind.footNewTab': { zh: '新标签打开', en: 'Open in new tab' },
  'quickfind.createNote': { zh: '新建笔记「{name}」', en: 'Create note “{name}”' },
  'quickfind.subNewNote': { zh: '新建', en: 'New' },
  'quickfind.secContent': { zh: '对话内容', en: 'In conversations' },
  'quickfind.footJump': { zh: '跳到这一条', en: 'Jump to message' },
  'quickfind.previewTurns': { zh: '最后 3 轮', en: 'Last 3 turns' },
  'quickfind.previewEmpty': { zh: '选中一条对话内容，这里显示最后 3 轮', en: 'Select a conversation result to see its last 3 turns' },
  'quickfind.previewHint': { zh: '↵ 打开对话 · {jump} 跳到这一条', en: '↵ open · {jump} jump to this message' },
})

/** ⌘P 正文搜索(10-24 借鉴 Comma §2.8)的查询串:不到 2 个字不搜(两个字的中文词也能搜),超过 128 字截到 128。
 *  按**码点**截,同 searchSessions 头注:`String.slice` 劈开代理对,encodeURIComponent 当场抛。 */
export const contentNeedle = (q: string): string | null => {
  const cps = [...q.trim()]
  return cps.length < 2 ? null : cps.slice(0, 128).join('').trim()
}

/** 停手 ms 再搜;换了词就清掉还在等的那次、abort 已发出去的那次(晚到的旧结果不落地)。null = 不搜。 */
export function debouncedSearch<T>(run: (q: string, signal: AbortSignal) => Promise<T>, onResult: (q: string, r: T) => void, ms = 180) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let ctl: AbortController | undefined
  const stop = (): void => { clearTimeout(timer); ctl?.abort(); ctl = undefined }
  return {
    set(q: string | null): void {
      stop()
      if (!q) return
      timer = setTimeout(() => {
        const c = (ctl = new AbortController())
        run(q, c.signal).then((r) => { if (!c.signal.aborted) onResult(q, r) }, () => {})
      }, ms)
    },
    dispose: stop,
  }
}

/** 片段按查询词切成「命中 / 没命中」几截,命中的那截渲染成 <mark>。分词同引擎 splitTerms:空白分词,成对引号算一个短语;不分大小写。 */
export function hitSlices(text: string, q: string): Array<{ s: string; hit: boolean }> {
  const terms = (q.match(/"[^"]+"|[^\s"]+/g) || []).map((t) => t.replace(/"/g, '').trim()).filter(Boolean).sort((a, b) => b.length - a.length)
  if (!terms.length) return [{ s: text, hit: false }]
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'iu')
  return text.split(re).map((s, i) => ({ s, hit: i % 2 === 1 })).filter((x) => x.s)
}

const Marked = ({ text, q }: { text: string; q: string }) => <>{hitSlices(text, q).map((x, i) => (x.hit ? <mark key={i}>{x.s}</mark> : x.s))}</>

/** 预览栏:最后 n 轮(一轮 = 一条提问 + 它后面的回答),只留有正文的提问 / 回答,过程消息(只调工具没说话)不算。 */
export function lastTurns(msgs: Pick<MessageRecord, 'id' | 'role' | 'content'>[], n = 3): Array<{ id: string; user: boolean; text: string }> {
  const said = msgs.filter((m) => typeof m.content === 'string' && m.content.trim() && m.role !== 'tool' && m.role !== 'system')
  const starts = said.flatMap((m, i) => (m.role === 'user' ? [i] : []))
  return said.slice(starts.length > n ? starts[starts.length - n] : 0).map((m) => ({ id: m.id, user: m.role === 'user', text: String(m.content).trim() }))
}

type Turns = ReturnType<typeof lastTurns>
function ContentPreview({ hit, q }: { hit: SessionSearchHit; q: string }) {
  const { t } = useI18n()
  const [turns, setTurns] = useState<{ id: string; turns: Turns } | null>(null)
  useEffect(() => {
    let live = true
    // 取一页 200 条(= 打开会话时 ChatView 那一页):过程消息也占条数,40 条会被一轮密集的工具调用占满,凑不出 3 轮(Codex 评审)。
    // ponytail: 不缓存,换一条就重取一次;窄窗口里预览栏被 CSS 藏起来时也照取。工具更密的会话一页仍凑不满时就少几轮,要补再按 before 往前翻
    listMessages(targetForSession(hit.id), hit.id, 200).then((ms) => { if (live) setTurns({ id: hit.id, turns: lastTurns(ms) }) }, () => {})
    return () => { live = false }
  }, [hit.id])
  return (
    <div className="amx-qf-preview" data-testid="qf-preview">
      <div className="amx-qf-pv-head"><span>{hit.title || t('quickfind.untitledSession')}</span><span>{t('quickfind.previewTurns')}</span></div>
      <div className="amx-qf-pv-body">
        {turns?.id === hit.id && turns.turns.map((m) => (
          <div key={m.id} className={m.user ? 'amx-qf-pv-user' : 'amx-qf-pv-reply'}><Marked text={m.text} q={q} /></div>
        ))}
      </div>
      <div className="amx-qf-pv-hint">{t('quickfind.previewHint', { jump: isMacPlatform() ? '⌘↵' : 'Ctrl+↵' })}</div>
    </div>
  )
}

/** 选取模式(2026-08-25,仪表盘嵌卡要「挑一个文件」):同一个面板,回车不导航而是回调给调用方。
 *  刻意复用本面板而不另造 picker —— 模糊搜索 / 键盘 / 样式 / 最近项这一整套已经在这儿了。 */
export interface QFPick {
  /** 输入框 placeholder,直接当标题用(面板没有标题栏)。 */
  title: string
  /** 该候选能不能选。kind 见 `Kind`;path 对 note/db/file 是库内路径,对 session 是会话 id。 */
  accept(kind: string, path: string): boolean
  onPick(path: string): void
}

interface QFState { open: boolean; pick: QFPick | null; openPalette(): void; openPicker(pick: QFPick): void; close(): void }
export const useQuickFind = create<QFState>((set) => ({
  open: false,
  pick: null,
  openPalette: () => set({ open: true, pick: null }),
  openPicker: (pick) => set({ open: true, pick }),
  close: () => set({ open: false, pick: null }),
}))

type Kind = 'note' | 'db' | 'session' | 'file'

/** 可走的分类格(顺序即 ←/→ 的顺序)。「全部」不在其中 —— 见顶注:它是「光标还在正文里」。 */
type Cat = 'all' | 'note' | 'file' | 'session'
/** ⚠️ 存的是 i18n **键**不是文案:模块作用域求值一次,写死文案会在切语言时不更新。 */
const CATS: Array<{ id: Exclude<Cat, 'all'>; labelKey: string }> = [
  { id: 'note', labelKey: 'quickfind.catNote' },
  { id: 'file', labelKey: 'quickfind.catFile' },
  { id: 'session', labelKey: 'quickfind.catSession' },
]
/** 胶囊上真正画出来的四格(第 0 格 = 全部 = pos -1)。同样只存键,渲染时 `t()`。 */
const SEGS: Array<{ id: Cat; labelKey: string }> = [{ id: 'all', labelKey: 'quickfind.catAll' }, ...CATS]
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

/** open 的 newTab = ⌘/Ctrl+Enter(评审 G4-11:合并前 Amadeus 那个快切有「新标签打开」的对标缺口,这里一并补上)。 */
interface Item { kind: Kind; id: string; title: string; sub: string; emoji?: string; open: (opts?: { newTab?: boolean }) => void }

export function QuickFind() {
  const open = useQuickFind((s) => s.open)
  if (!open) return null
  return <QuickFindInner />
}

const CHROME_HIDDEN: NativeChromeClaim = { mode: 'hidden' }

function QuickFindInner() {
  const { t } = useI18n()
  // 原生外壳(Android):面板是盖住整页的一层,开着时把浮在页面上的胶囊和 Dock 收起来 —— 不收的话两颗胶囊正压在
  // 输入框上(它们是原生视图,永远在页面之上)。面板改成贴顶、通栏,键盘提示那一行不画(手机没有那些键)。
  const phone = useNativeChromeInstalled()
  useNativeChromeClaim(phone ? CHROME_HIDDEN : null)
  const scrimRef = useRef<HTMLDivElement>(null)
  useExitGhost(scrimRef) // 关掉(卸载)时留替身放 80ms 退场
  const close = useQuickFind((s) => s.close)
  const pick = useQuickFind((s) => s.pick)
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
  const allItems = useMemo<Item[]>(() => {
    const notes: Item[] = pages
      .filter((p) => /\.md$/i.test(p))
      .map((p) => ({ kind: 'note', id: p, title: base(p), sub: dirOf(p), open: (o) => void openNote(p, { ...o, focus: 'body' }) }))
    const dbItems: Item[] = dbs.map((d) => ({ kind: 'db', id: d.path, title: d.name || base(d.path), sub: dirOf(d.path), open: (o) => openDb(d.path, o) }))
    // 库里的非笔记文件(pdf/图片/画板/插件文件…)。.db 排掉 —— 上面那份带库名,更好认。
    const fileItems: Item[] = files
      .filter((p) => !/\.db$/i.test(p))
      .map((p) => ({ kind: 'file', id: p, title: fileName(p), sub: dirOf(p), open: (o) => openFile(p, o) }))
    const sess: Item[] = sessions.map((s) => ({
      kind: 'session',
      id: s.id,
      title: s.title || t('quickfind.untitledSession'),
      sub: t('quickfind.subSession'),
      emoji: s.emoji ?? undefined,
      open: (o) => openSession(s.id, o),
    }))
    return [...(amadeusAvailable() ? [...notes, ...dbItems, ...fileItems] : []), ...(sessionsAvailable() ? sess : [])]
  }, [pages, files, dbs, sessions, t])

  const results = useMemo<Item[]>(() => {
    const needle = q.trim()
    // 选取模式:先按调用方的 accept 收窄,后面的分类/模糊/最近项逻辑一个字不改。
    const all = pick ? allItems.filter((it) => pick.accept(it.kind, it.id)) : allItems
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
    // 选取模式空态:直接列可选项(最近项与会话兜底在这儿都不成立 —— 会 accept 成空面板)。
    if (pick) return all.slice(0, 30)
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
  }, [q, allItems, sessions, cat, pick])

  // 「新建笔记」行(评审 G4-11:⌘P 曾被本面板与 Amadeus 的快速切换同时绑定,能新建的那个永远打不开 ——
  // 两个合成本面板一个,新建能力搬过来)。条件同旧快切:有查询、没有 pageKey 精确同名的笔记;
  // 只在「全部 / 笔记」分类、有智库时出现,选取模式没有。落盘走 createWikiPage → birthAndOpen(G4-12 素文件出生)。
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const createName = q.trim()
  const showCreate = !pick && !!createName && !!vaultRoot && amadeusAvailable() && (cat === 'all' || cat === 'note')
    && !pages.some((p) => /\.md$/i.test(p) && pageKey(p) === pageKey(createName))

  // 「对话内容」一段(按正文搜会话):排在名称结果与「新建笔记」之后 —— 它是异步到的,排在前面会让
  // 「打个新名字 + 回车 = 新建笔记」变成看手速。只在「全部 / 会话」分类出现,选取模式没有。
  // 只收正文命中(带 hit)的:标题 / 摘要自证命中的,上面的名称匹配已经列了。
  const needle = !pick && sessionsAvailable() ? contentNeedle(q) : null
  const [content, setContent] = useState<{ q: string; hits: SessionSearchHit[] } | null>(null)
  const searcher = useMemo(() => debouncedSearch(
    (s, signal) => searchSessions(homeTarget(), s, { limit: 20, signal }),
    (s, hits) => setContent({ q: s, hits: hits.filter((h) => h.hit) }),
  ), [])
  useEffect(() => { searcher.set(needle); if (!needle) setContent(null) }, [needle, searcher])
  useEffect(() => searcher.dispose, [searcher])
  // 只认这一个词的结果:换词后旧结果不留(还在等 / 新请求失败时,回车会打开一条不相干的旧命中 —— Codex 评审)
  const contentHits = content && content.q === needle && (cat === 'all' || cat === 'session') ? content.hits : []
  const hit0 = results.length + (showCreate ? 1 : 0) // 第一条「对话内容」的序号
  const total = hit0 + contentHits.length
  const selHit = sel >= hit0 ? contentHits[sel - hit0] : undefined
  const wide = !phone && contentHits.length > 0

  useEffect(() => setSel(0), [q, pos])
  useEffect(() => inputRef.current?.focus(), [])

  const openItem = (it: Item, opts?: { newTab?: boolean }): void => {
    if (pick) { pick.onPick(it.id); close(); return } // 选取模式:不导航、不记最近(选卡片内容 ≠ 我最近开过它)
    pushRecent({ kind: it.kind, id: it.id, title: it.title, sub: it.sub, emoji: it.emoji })
    it.open(opts?.newTab ? { newTab: true } : undefined)
    close()
  }
  const createNote = (): void => {
    close()
    void usePageStore.getState().createWikiPage(createName)
  }
  /** ↵ 打开会话;⌘↵ 打开后跳到命中那条并闪两下(#153 的跳转)。 */
  const openHit = (h: SessionSearchHit, jump: boolean): void => {
    const title = h.title || t('quickfind.untitledSession')
    pushRecent({ kind: 'session', id: h.id, title, sub: t('quickfind.subSession') })
    if (jump && h.hit) useApp.getState().setJumpTarget(h.id, h.hit.messageId) // 目标先落下再开会话(见 setJumpTarget)
    openSession(h.id)
    close()
  }
  const chooseAt = (i: number, opts?: { newTab?: boolean }): void => {
    if (showCreate && i === results.length) { createNote(); return }
    if (i >= hit0) { const h = contentHits[i - hit0]; if (h) openHit(h, !!opts?.newTab); return }
    const it = results[i]
    if (it) openItem(it, opts)
  }

  const onKey = (e: ReactKeyboardEvent): void => {
    if (isImeKeyEvent(e)) return // 组字中的 Enter/↑↓/←→/Esc 归输入法(G4-02:此前组字回车直接打开第一条)
    if (e.key === 'Escape') { e.preventDefault(); close() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(i + 1, total - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); chooseAt(sel, { newTab: e.metaKey || e.ctrlKey }) }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (pick) return // 选取模式没有分类胶囊 → 左右恒归输入框
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
    <div ref={scrimRef} className={`amx-qf-scrim${phone ? ' amx-qf-phone' : ''}`} onMouseDown={close}>
      <div className={`amx-qf${wide ? ' amx-qf-wide' : ''}`} onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="amx-qf-head">
          <Search size={16} className="amx-qf-searchicon" />
          <input
            ref={inputRef}
            className="amx-qf-input"
            placeholder={pick ? pick.title : t('quickfind.placeholder')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            /* 用鼠标把光标点回正文里 = 离开分类格(同一条线上的位置变了),胶囊滑回「全部」。 */
            onMouseUp={() => setPos(-1)}
          />
        </div>
        {/* 分类胶囊:复用「本地|云端」「文档|画布」那颗 `.t2s-vaultseg`(凹轨道 + 滑块弹性平移),
            只是从两格变成四格 —— 格数与当前格走 CSS 变量(见 sidebar2.css)。
            ⚠️ 整条 mousedown preventDefault:点格子不夺焦点,点完还能接着打字。 */}
        {!pick && <div
          className="t2s-vaultseg amx-qf-seg"
          role="tablist"
          aria-label={t('quickfind.scopeLabel')}
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
              {t(c.labelKey)}
            </button>
          ))}
        </div>}
        <div className="amx-qf-body">
        <div className="amx-qf-list">
          {!q.trim() && results.length > 0 && <div className="amx-qf-sec">{t(pick ? 'quickfind.secPickable' : 'quickfind.secRecent')}</div>}
          {results.map((it, i) => (
            <button
              key={`${it.kind}:${it.id}`}
              className={`amx-qf-row${i === sel ? ' sel' : ''}`}
              onMouseMove={() => setSel(i)}
              onClick={(e) => openItem(it, { newTab: e.metaKey || e.ctrlKey })}
            >
              <span className="amx-qf-icon">{icon(it.kind, it.emoji)}</span>
              <span className="amx-qf-title">{it.title}</span>
              <span className="amx-qf-sub">{it.sub}</span>
            </button>
          ))}
          {showCreate && (
            <button
              className={`amx-qf-row amx-qf-create${sel === results.length ? ' sel' : ''}`}
              onMouseMove={() => setSel(results.length)}
              onClick={createNote}
            >
              <span className="amx-qf-icon"><Plus size={15} /></span>
              <span className="amx-qf-title">{t('quickfind.createNote', { name: createName })}</span>
              <span className="amx-qf-sub">{t('quickfind.subNewNote')}</span>
            </button>
          )}
          {contentHits.length > 0 && <div className="amx-qf-sec">{t('quickfind.secContent')}</div>}
          {contentHits.map((h, j) => (
            <button
              key={`hit:${h.id}`}
              data-testid="qf-hit"
              className={`amx-qf-row amx-qf-hit${hit0 + j === sel ? ' sel' : ''}`}
              onMouseMove={() => setSel(hit0 + j)}
              onClick={(e) => openHit(h, e.metaKey || e.ctrlKey)}
            >
              <span className="amx-qf-icon"><MessageSquare size={15} /></span>
              <span className="amx-qf-hitmain">
                <span className="amx-qf-title">{h.title || t('quickfind.untitledSession')}</span>
                <span className="amx-qf-snip"><Marked text={h.hit?.snippet ?? ''} q={content!.q} /></span>
              </span>
              <span className="amx-qf-sub">{h.updatedAt.startsWith(`${new Date().getFullYear()}-`) ? h.updatedAt.slice(5) : h.updatedAt}</span>
            </button>
          ))}
          {results.length === 0 && !showCreate && !contentHits.length && <div className="amx-qf-empty">{t(q.trim() ? 'quickfind.emptyNoMatch' : pick ? 'quickfind.emptyNoPickable' : 'quickfind.emptyNoRecent')}</div>}
        </div>
        {/* 预览栏只在有「对话内容」时出;选中的不是正文命中就空着(栏不收起,免得上下走一格面板宽度跳一下)。窄于 760px 由 CSS 藏起。 */}
        {wide && (selHit ? <ContentPreview hit={selHit} q={content!.q} /> : <div className="amx-qf-preview amx-qf-pv-empty" data-testid="qf-preview">{t('quickfind.previewEmpty')}</div>)}
        </div>
        {!phone && <div className="amx-qf-foot">{pick
          ? <><kbd>↑↓</kbd> {t('quickfind.footSelect')} · <kbd>↵</kbd> {t('quickfind.footChoose')} · <kbd>esc</kbd> {t('quickfind.footCancel')}</>
          : <><kbd>↑↓</kbd> {t('quickfind.footSelect')} · <kbd>←→</kbd> {t('quickfind.footScope')} · <kbd>↵</kbd> {t('quickfind.footOpen')} · <kbd>{isMacPlatform() ? '⌘↵' : 'Ctrl+↵'}</kbd> {t(selHit ? 'quickfind.footJump' : 'quickfind.footNewTab')} · <kbd>esc</kbd> {t('quickfind.footClose')}</>}</div>}
      </div>
    </div>
  )
}
