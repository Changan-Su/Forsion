/** Amadeus 侧栏面板(Tangu 原生 amx- 外观,只复用 vendored 组件的逻辑):全文搜索 / 标签 / 局部关系图。 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Search } from 'lucide-react'
import { usePageStore } from '@amadeus/store/pageStore'
import { amadeus } from '@amadeus/api'
import type { SearchHit, TagCount } from '@amadeus-shared/ipc'
import { parseWikiLinks, resolvePageName } from '@amadeus-shared/links'
import { stripFrontmatter } from '@amadeus-shared/compiler'
import { resolveFileName } from '@amadeus/lib/vaultFiles'
import { openNote } from './amadeusNav'
import { create } from 'zustand'
import { useAmadeusPrefs } from './amadeusPrefs'
import { askString } from '@amadeus/components/askString'
import { registerMessages, useI18n } from './i18n'

registerMessages({
  'amxpanel.searchHead': { zh: '全文搜索', en: 'Full-text search' },
  'amxpanel.searchPlaceholder': { zh: '搜索全部笔记…', en: 'Search all notes…' },
  'amxpanel.saveCollection': { zh: '存为集合', en: 'Save as collection' },
  'amxpanel.saveCollectionTip': { zh: '存为集合(左栏可一键回放这次搜索)', en: 'Save as a collection (replay this search from the sidebar in one click)' },
  'amxpanel.saveCollectionHint': { zh: '集合会出现在左栏,点击即重放这次搜索。', en: 'The collection shows up in the sidebar — click it to replay this search.' },
  'amxpanel.noVault': { zh: '先打开一个 Vault。', en: 'Open a vault first.' },
  'amxpanel.searchEmpty': { zh: '输入关键词,搜遍全部笔记内容。', en: 'Type a keyword to search the contents of every note.' },
  'amxpanel.noResults': { zh: '无结果', en: 'No results' },
  'amxpanel.tagsHead': { zh: '标签 · {n}', en: 'Tags · {n}' },
  'amxpanel.tagsEmpty': { zh: '还没有 #标签。在笔记里写 #灵感 这样的行内标签即可出现在这里。', en: 'No #tags yet. Write an inline tag like #idea in a note and it will show up here.' },
  'amxpanel.graphHead': { zh: '关系图 · 当前笔记', en: 'Graph · current note' },
  'amxpanel.graphNoNote': { zh: '未打开笔记', en: 'No note open' },
  'amxpanel.graphEmpty': { zh: '这篇笔记还没有链接(出链 [[…]] 或反链)。', en: 'This note has no links yet — no outgoing [[…]] links and no backlinks.' },
})

const ps = () => usePageStore.getState()
const baseName = (p: string): string => (p.split(/[\\/]/).pop() ?? p).replace(/\.md$/i, '')

// ─────────────────────────────── 全文搜索(左栏 tab;后端 = 主进程 vault 索引) ───────────────────────────────

/** 「集合」点击注入搜索词:视图是 singleton,经种子 store 解耦(n 自增以重触发同词)。 */
export const useSearchSeed = create<{ seed: { q: string; n: number } | null; request(q: string): void }>((set) => ({
  seed: null,
  request: (q) => set((s) => ({ seed: { q, n: (s.seed?.n ?? 0) + 1 } })),
}))

export function AmadeusSearchView() {
  const { t } = useI18n()
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const [query, setQuery] = useState('')
  const seed = useSearchSeed((s) => s.seed)
  useEffect(() => {
    if (seed) setQuery(seed.q)
  }, [seed])
  const [hits, setHits] = useState<SearchHit[]>([])
  const seq = useRef(0)

  // 挂载先落盘当前编辑,让最新内容可检索(vendored SearchPanel 同款)。
  useEffect(() => { void ps().flushSave() }, [])
  useEffect(() => {
    const q = query.trim()
    if (!q) { setHits([]); return }
    const id = ++seq.current
    const timer = setTimeout(() => { void amadeus.search(q).then((r) => { if (id === seq.current) setHits(r) }) }, 120)
    return () => clearTimeout(timer)
  }, [query])

  // 命中 → 打开笔记 → 滚到首个含关键词的块并短暂高亮。
  // SearchHit.line 是对 strip 后文本的行号(不可靠),按块内容匹配定位更稳。
  const choose = (h: SearchHit): void => {
    const q = query.trim().toLowerCase()
    void openNote(h.path).then(() => {
      if (!q) return
      const hit = Object.values(ps().blocks).find((b) => b.content.toLowerCase().includes(q))
      if (!hit) return
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-block-id="${hit.id}"]`)
        if (!el) return
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.classList.add('amx-block-flash')
        setTimeout(() => el.classList.remove('amx-block-flash'), 1300)
      })
    })
  }

  return (
    <div className="amx-panel">
      <div className="amx-panel-head">{t('amxpanel.searchHead')}</div>
      <div className="t2s-search amx-search-box">
        <Search size={13} className="t2s-dim" />
        <input autoFocus value={query} placeholder={t('amxpanel.searchPlaceholder')} onChange={(e) => setQuery(e.target.value)} />
        {query.trim() && (
          <button
            className="amx-search-save"
            title={t('amxpanel.saveCollectionTip')}
            onClick={() => {
              void askString(t('amxpanel.saveCollection'), query.trim(), { label: t('amxpanel.saveCollectionHint') }).then((name) => {
                const n = name?.trim()
                if (n) useAmadeusPrefs.getState().saveCollection(n, query.trim())
              })
            }}
          >
            {t('amxpanel.saveCollection')}
          </button>
        )}
      </div>
      {!vaultRoot ? (
        <div className="amx-panel-empty">{t('amxpanel.noVault')}</div>
      ) : !query.trim() ? (
        <div className="amx-panel-empty">{t('amxpanel.searchEmpty')}</div>
      ) : hits.length === 0 ? (
        <div className="amx-panel-empty">{t('amxpanel.noResults')}</div>
      ) : (
        <div className="amx-list">
          {hits.map((h) => (
            <button key={h.path} className="amx-list-item" onClick={() => choose(h)} title={h.path}>
              {h.title}
              {h.snippet && <span className="amx-backlink-snippet amx-search-snippet">{highlight(h.snippet, query.trim())}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function highlight(snippet: string, q: string): ReactNode {
  if (!q) return snippet
  const idx = snippet.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return snippet
  return (
    <>
      {snippet.slice(0, idx)}
      <mark>{snippet.slice(idx, idx + q.length)}</mark>
      {snippet.slice(idx + q.length)}
    </>
  )
}

// ─────────────────────────────── 标签(左栏 tab;#tag 计数 + 展开跳转) ───────────────────────────────

export function AmadeusTagsView() {
  const { t } = useI18n()
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const version = usePageStore((s) => s.linkGraphVersion)
  const [tags, setTags] = useState<TagCount[]>([])
  const [openTag, setOpenTag] = useState<string | null>(null)
  const [tagPages, setTagPages] = useState<string[]>([])

  useEffect(() => {
    let live = true
    if (!vaultRoot) { setTags([]); return }
    void amadeus.listTags().then((list) => { if (live) setTags(list) })
    return () => { live = false }
  }, [vaultRoot, version])
  useEffect(() => {
    let live = true
    if (!openTag) { setTagPages([]); return }
    void amadeus.pagesByTag(openTag).then((p) => { if (live) setTagPages(p) })
    return () => { live = false }
  }, [openTag, version])

  return (
    <div className="amx-panel">
      <div className="amx-panel-head">{t('amxpanel.tagsHead', { n: tags.length })}</div>
      {!vaultRoot ? (
        <div className="amx-panel-empty">{t('amxpanel.noVault')}</div>
      ) : tags.length === 0 ? (
        <div className="amx-panel-empty">{t('amxpanel.tagsEmpty')}</div>
      ) : (
        <div className="amx-list">
          {tags.map((tc) => (
            <div key={tc.tag}>
              <button
                className={`amx-list-item amx-tag${openTag === tc.tag ? ' active' : ''}`}
                onClick={() => setOpenTag((cur) => (cur === tc.tag ? null : tc.tag))}
              >
                <span className="amx-tag-name">#{tc.tag}</span>
                <span className="amx-tag-count">{tc.count}</span>
              </button>
              {openTag === tc.tag && tagPages.map((p) => (
                <button key={p} className="amx-list-item amx-tag-page" onClick={() => void openNote(p)} title={p}>
                  {baseName(p)}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────── 局部关系图(右栏 tab;当前笔记的出/入链) ───────────────────────────────

interface GNode { path: string; label: string; center: boolean; ghost?: boolean; x: number; y: number; vx: number; vy: number; pinned: boolean }
interface GEdge { a: number; b: number }

const W = 320
const H = 280
const clampN = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** 单帧力仿真(斥力 + 弹簧 + 向心;力随 alpha 降温):rAF 逐帧驱动,拖拽/换页时升温。
 *  力常数沿用旧一次性版;alpha≈0.5 时与旧版单 tick 等效。pinned 节点(中心/被拖)位置外部控制。 */
function step(nodes: GNode[], edges: GEdge[], alpha: number): void {
  const cx = W / 2
  const cy = H / 2
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (n.pinned) continue
    let fx = (cx - n.x) * 0.005 // 向心
    let fy = (cy - n.y) * 0.005
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue
      const o = nodes[j]
      const dx = n.x - o.x
      const dy = n.y - o.y
      const d2 = Math.max(64, dx * dx + dy * dy)
      const f = 1400 / d2 // 斥力
      fx += (dx / Math.sqrt(d2)) * f
      fy += (dy / Math.sqrt(d2)) * f
    }
    for (const e of edges) {
      if (e.a !== i && e.b !== i) continue
      const o = nodes[e.a === i ? e.b : e.a]
      const dx = o.x - n.x
      const dy = o.y - n.y
      const d = Math.max(1, Math.hypot(dx, dy))
      const f = (d - 86) * 0.02 // 弹簧,静止长 86
      fx += (dx / d) * f
      fy += (dy / d) * f
    }
    n.vx = (n.vx + fx * alpha * 2) * 0.82 // 阻尼
    n.vy = (n.vy + fy * alpha * 2) * 0.82
    n.x = clampN(n.x + n.vx, 16, W - 16)
    n.y = clampN(n.y + n.vy, 16, H - 16)
  }
}

export function AmadeusLocalGraphView() {
  const { t } = useI18n()
  // v4/unified 笔记不设 activePage(见 pageStore.activeNotePath)→ 回落到它,否则本视图对 v4 全空。
  const activePage = usePageStore((s) => s.activePage ?? s.activeNotePath)
  const version = usePageStore((s) => s.linkGraphVersion)
  const [graph, setGraph] = useState<{ nodes: GNode[]; edges: GEdge[] } | null>(null)
  const [, setFrame] = useState(0) // 仿真帧计数:节点位置就地突变,靠它触发重渲
  const [hover, setHover] = useState<number | null>(null)
  const [view, setView] = useState({ x: 0, y: 0, k: 1 }) // pan/zoom(viewBox 坐标系)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const graphRef = useRef(graph)
  graphRef.current = graph
  const viewRef = useRef(view)
  viewRef.current = view
  const simRef = useRef({ alpha: 0, raf: 0, dragging: false })
  const movedRef = useRef(false) // 拖过就抑制 click 跳转

  const ensureLoop = (): void => {
    if (simRef.current.raf) return
    const loop = (): void => {
      const g = graphRef.current
      const s = simRef.current
      if (!g) { s.raf = 0; return }
      step(g.nodes, g.edges, s.alpha)
      if (!s.dragging) s.alpha -= 0.006 // 冷却 ~2.5s;静止后停帧省电
      setFrame((f) => f + 1)
      if (s.alpha > 0.02 || s.dragging) s.raf = requestAnimationFrame(loop)
      else s.raf = 0
    }
    simRef.current.raf = requestAnimationFrame(loop)
  }
  useEffect(() => () => { if (simRef.current.raf) cancelAnimationFrame(simRef.current.raf) }, [])

  /** 屏幕坐标 → svg viewBox 坐标(未去 pan/zoom)。 */
  const toLocal = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const ctm = svgRef.current?.getScreenCTM()
    if (!ctm) return null
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse())
    return { x: p.x, y: p.y }
  }
  /** 屏幕坐标 → 世界坐标(去掉 pan/zoom,即节点坐标系)。 */
  const toWorld = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const p = toLocal(clientX, clientY)
    if (!p) return null
    const v = viewRef.current
    return { x: (p.x - v.x) / v.k, y: (p.y - v.y) / v.k }
  }

  useEffect(() => {
    let live = true
    if (!activePage) { setGraph(null); graphRef.current = null; return }
    void (async () => {
      const incoming = await amadeus.backlinks(activePage).catch(() => [])
      if (!live) return
      const st = ps()
      // 出链一律读**盘上原文**:v3 的块内容在 store 里,v4 的在 UnifiedPage 自己的 ref 型 pipe 里
      // (根本不进 store)—— 读 blocks 就是 v4 图谱只剩反链的原因。原文对两条路由都齐全,
      // 且与主进程 vaultIndex 算反链用的是同一份文本(同样先剥 frontmatter,免得出链/反链对不上)。
      const raw = await amadeus.readTextFile(activePage).catch(() => null)
      if (!live) return
      const contents = stripFrontmatter(raw ?? '')
      // 出链拆两桶:解析到的 → 实体节点;解析不到的 → ghost 节点(黯淡显示,点击询问创建)。
      const outs: string[] = []
      const ghosts: string[] = []
      const seenGhost = new Set<string>()
      for (const n of parseWikiLinks(contents)) {
        const r = resolvePageName(n, st.pages, activePage)
        if (r) {
          if (r !== activePage && !outs.includes(r)) outs.push(r)
        } else if (!seenGhost.has(n.toLowerCase())) {
          seenGhost.add(n.toLowerCase())
          // [[xxx.db]]/[[photo.png]] 命中真实文件的不是「未创建页面」,不进幽灵(点击有自己的打开语义)。
          if (!resolveFileName(n, st.files, activePage)) ghosts.push(n)
        }
      }
      const others = [...new Set([...outs, ...incoming.map((r) => r.path).filter((p) => p !== activePage)])]
      const ring = [...others, ...ghosts]
      const nodes: GNode[] = [
        { path: activePage, label: baseName(activePage), center: true, x: W / 2, y: H / 2, vx: 0, vy: 0, pinned: true },
        ...ring.map((p, i) => {
          const ang = (i / Math.max(1, ring.length)) * Math.PI * 2
          const ghost = i >= others.length
          return { path: p, label: ghost ? p : baseName(p), center: false, ghost, x: W / 2 + Math.cos(ang) * 90, y: H / 2 + Math.sin(ang) * 90, vx: 0, vy: 0, pinned: false }
        }),
      ]
      const idx = new Map(nodes.slice(0, 1 + others.length).map((n, i) => [n.path, i]))
      const edges: GEdge[] = []
      const seen = new Set<string>()
      for (const p of [...outs, ...incoming.map((r) => r.path)]) {
        const b = idx.get(p)
        if (b === undefined || seen.has(p)) continue
        seen.add(p)
        edges.push({ a: 0, b })
      }
      for (let i = 0; i < ghosts.length; i++) edges.push({ a: 0, b: 1 + others.length + i }) // ghost 恒连中心
      if (!live) return
      const g = { nodes, edges }
      graphRef.current = g
      setGraph(g)
      setHover(null)
      simRef.current.alpha = 1 // 从初始圆环动画展开
      ensureLoop()
    })()
    return () => { live = false }
  }, [activePage, version])

  /** 节点拖拽:pin 住跟随指针 + 升温(斥力推开邻居);松手叶子解 pin 回弹,中心留在原地。 */
  const onNodePointerDown = (i: number) => (e: ReactPointerEvent): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    const g = graphRef.current
    if (!g) return
    const n = g.nodes[i]
    const wasPinned = n.pinned
    n.pinned = true
    movedRef.current = false
    simRef.current.dragging = true
    simRef.current.alpha = Math.max(simRef.current.alpha, 0.6)
    ensureLoop()
    const move = (ev: PointerEvent): void => {
      const p = toWorld(ev.clientX, ev.clientY)
      if (!p) return
      movedRef.current = true
      n.x = clampN(p.x, 16, W - 16)
      n.y = clampN(p.y, 16, H - 16)
      n.vx = 0
      n.vy = 0
      simRef.current.alpha = Math.max(simRef.current.alpha, 0.6)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      n.pinned = wasPinned
      simRef.current.dragging = false
      simRef.current.alpha = Math.max(simRef.current.alpha, 0.5)
      ensureLoop()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** 拖空白处平移画布。 */
  const onBgPointerDown = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (e.button !== 0 || e.target !== e.currentTarget) return
    const start = toLocal(e.clientX, e.clientY)
    if (!start) return
    const v0 = viewRef.current
    const move = (ev: PointerEvent): void => {
      const p = toLocal(ev.clientX, ev.clientY)
      if (p) setView({ k: v0.k, x: v0.x + (p.x - start.x), y: v0.y + (p.y - start.y) })
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // 滚轮缩放(以指针为焦点)。原生监听:React 的 onWheel 走 passive,preventDefault 不生效。
  const hasGraph = !!graph && graph.nodes.length > 1
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || !hasGraph) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const p = toLocal(e.clientX, e.clientY)
      if (!p) return
      const v = viewRef.current
      const k = clampN(v.k * Math.exp(-e.deltaY * 0.0022), 0.4, 3)
      const wx = (p.x - v.x) / v.k
      const wy = (p.y - v.y) / v.k
      setView({ k, x: p.x - wx * k, y: p.y - wy * k })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [hasGraph])

  return (
    <div className="amx-panel">
      <div className="amx-panel-head">{t('amxpanel.graphHead')}</div>
      {!activePage ? (
        <div className="amx-panel-empty">{t('amxpanel.graphNoNote')}</div>
      ) : !graph || !hasGraph ? (
        <div className="amx-panel-empty">{t('amxpanel.graphEmpty')}</div>
      ) : (
        <svg
          ref={svgRef}
          className="amx-graph"
          viewBox={`0 0 ${W} ${H}`}
          onPointerDown={onBgPointerDown}
          onDoubleClick={() => setView({ x: 0, y: 0, k: 1 })}
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {graph.edges.map((e, i) => (
              <line
                key={i}
                x1={graph.nodes[e.a].x} y1={graph.nodes[e.a].y}
                x2={graph.nodes[e.b].x} y2={graph.nodes[e.b].y}
                className={`amx-graph-edge${hover !== null ? (e.a === hover || e.b === hover ? ' hl' : ' dim') : ''}`}
              />
            ))}
            {graph.nodes.map((n, i) => {
              const lit = hover === null || i === hover
                || graph.edges.some((e) => (e.a === hover && e.b === i) || (e.b === hover && e.a === i))
              return (
                <g
                  key={n.ghost ? `g:${n.path}` : n.path}
                  className={`amx-graph-node${n.center ? ' center' : ''}${n.ghost ? ' ghost' : ''}${hover !== null ? (lit ? ' hl' : ' dim') : ''}`}
                  onPointerDown={onNodePointerDown(i)}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                  onClick={() => {
                    if (movedRef.current || n.center) return
                    // ghost = 未解析链接:进与编辑器同款的「是否创建」确认流(源 = 中心笔记)。
                    if (n.ghost) ps().openWikiLink(n.path)
                    else void openNote(n.path)
                  }}
                >
                  <circle cx={n.x} cy={n.y} r={n.center ? 8 : 5.5} />
                  <text x={n.x} y={n.y + (n.center ? 20 : 16)} textAnchor="middle">{n.label.length > 12 ? `${n.label.slice(0, 12)}…` : n.label}</text>
                </g>
              )
            })}
          </g>
        </svg>
      )}
    </div>
  )
}
