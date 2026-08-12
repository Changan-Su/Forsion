import { Fragment, useEffect, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  closestCorners,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { usePageStore, type Status } from '../store/pageStore'
import { findTotal, useFindStore } from '../blocks/markdown/findInPage'
import { BlockSelectionKeys, useBlockSelection } from '../store/blockSelection'
import { edgeBlock } from '../lib/blockEdges'
import { takeModeCursor } from '../lib/modeCursor'
import { activePageScope, pageStoreFor, usePageScope, useScopedPageStore, type PageStoreApi } from '../store/pageStore'
import { foldedSet, headingLevel, sectionBoundaryLevel, useHeadingFold } from '../store/headingFoldStore'
import { Row } from './Row'
import { BacklinksPanel } from './BacklinksPanel'

/** 页内查找浮条(Cmd/Ctrl+F 在编辑器内呼出):输入 / x/y 计数 / 上下条 / 关闭。 */
function FindBar() {
  const query = useFindStore((s) => s.query)
  const active = useFindStore((s) => s.active)
  const counts = useFindStore((s) => s.counts)
  void counts // 订阅计数变化以刷新 x/y
  const total = findTotal()
  // 激活命中变化 → 滚到可视区(等装饰画完一帧)。
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      document.querySelector('.amx-find-active')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(id)
  }, [active, query, total])
  return (
    <div className="amx-findbar">
      <input
        autoFocus
        placeholder="在本页查找…"
        value={query}
        onChange={(e) => useFindStore.getState().setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') useFindStore.getState().step(e.shiftKey ? -1 : 1)
          else if (e.key === 'Escape') useFindStore.getState().close()
          e.stopPropagation()
        }}
      />
      <span className="amx-findbar-count">{total ? `${Math.min(active + 1, total)}/${total}` : query ? '0' : ''}</span>
      <button onClick={() => useFindStore.getState().step(-1)} title="上一个(Shift+Enter)" aria-label="previous match">‹</button>
      <button onClick={() => useFindStore.getState().step(1)} title="下一个(Enter)" aria-label="next match">›</button>
      <button onClick={() => useFindStore.getState().close()} title="关闭(Esc)" aria-label="close find">✕</button>
    </div>
  )
}

function statusLabel(s: Status): string {
  return s === 'saving' ? '保存中…' : s === 'loading' ? '加载中…' : s === 'ready' ? '已保存' : ''
}

function previewText(content?: string): string {
  if (!content) return '空块'
  const line = content.replace(/[#>*_`\-[\]]/g, '').trim().split('\n')[0]
  return line.length > 48 ? line.slice(0, 48) + '…' : line || '空块'
}

function RowGap({ index }: { index: number }) {
  const { setNodeRef, isOver } = useDroppable({ id: `gap:${index}` })
  return <div ref={setNodeRef} className="row-gap" data-over={isOver || undefined} />
}

/** 标题栏 → 正文:光标进正文第一块(空正文则建首块)。本组件 header 与桌面壳的 NoteTitle 共用。
 *  block id 跨改名稳定,focusRequest 会在块渲染时消费。 */
export function focusBody(store?: PageStoreApi): void {
  // ⚠️ 分屏:不传 store 就落到「活动面板」。面板内的调用方必须把自己那份传进来,
  // 否则点 B 面板的标题栏回车,光标/新块会落进 A 面板那篇(Codex 复审坐实)。
  const st = (store ?? pageStoreFor(activePageScope())).getState()
  const first = st.manifest ? edgeBlock(st.manifest.root, 'first') : null
  if (first) st.requestFocus(first, 'start')
  else st.insertBlockAfter(null) // 自带 requestFocus
}

/** 落点判定跟指针走(Notion/AFFiNE 语义:placement 是 point 的函数,与被拖块矩形无关,
 *  见 AFFiNE calcDropTarget)。closestCorners 用「被拖块矩形」四角算距离 —— 全宽 text 块
 *  的四角永远贴住目标块本体,18px 边缘条一辈子算不赢 → 左右分栏形同虚设(实报,
 *  scripts/block-dnd.e2e.cjs 复现)。指针不在任何落点内(页边距/键盘拖拽无指针)才回退。 */
const pointerFirst: CollisionDetection = (args) => {
  const hits = pointerWithin(args)
  return hits.length ? hits : closestCorners(args)
}

/** 点正文下方空白(.page-tail)= Notion 式在末尾续写;末块已空就聚焦它,别叠一摞空块。
 *  块删完时这是唯一能点出块的地方(桌面 bare 模式没有 footer 的「＋ 新块」)。 */
function appendAtEnd(store: PageStoreApi): void {
  const st = store.getState()
  const last = st.manifest ? edgeBlock(st.manifest.root, 'last') : null
  if (last && !st.blocks[last]?.content) st.requestFocus(last, 'end')
  else st.insertBlockAfter(null)
}

// 分片挂载:切页首帧只同步挂前 INITIAL_ROWS 行,其余空闲帧逐批补。每个文本块都是一个独立
// ProseMirror 实例,大页一次性全量实例化会把主线程钉死数百 ms~数秒(云端/移动端「点不动」主因)。
const INITIAL_ROWS = 24
const MOUNT_BATCH = 16
const idleMount: (cb: () => void) => number =
  typeof requestIdleCallback === 'function'
    ? (cb) => requestIdleCallback(cb, { timeout: 200 })
    : (cb) => window.setTimeout(cb, 16)
const cancelIdleMount: (h: number) => void =
  typeof cancelIdleCallback === 'function' ? cancelIdleCallback : clearTimeout

export function PageView({ bare = false }: { bare?: boolean } = {}) {
  const manifest = usePageStore((s) => s.manifest)
  const blocks = usePageStore((s) => s.blocks)
  const status = usePageStore((s) => s.status)
  const activePage = usePageStore((s) => s.activePage)
  const moveBlock = usePageStore((s) => s.moveBlock)
  const addColumnWithBlock = usePageStore((s) => s.addColumnWithBlock)
  const addRowWithBlock = usePageStore((s) => s.addRowWithBlock)
  const insertBlockAfter = usePageStore((s) => s.insertBlockAfter)
  const renamePage = usePageStore((s) => s.renamePage)
  const setDnd = usePageStore((s) => s.setDnd)

  // 本编辑器面板自己那份文档 store(分屏后每个面板一份)。**写操作一律走它**,
  // 别用 usePageStore.getState() —— 那解析到「活动面板」,异步回调里会写到隔壁那篇去。
  const scope = usePageScope()
  const scoped = useScopedPageStore()

  // 从源码模式切回来:把光标送回它离开时那个块(见 lib/modeCursor)。
  // 只在挂载时取一次;普通的打开笔记不会有待交接的光标(takeModeCursor 返回 null),不受影响。
  useEffect(() => {
    const cur = takeModeCursor(scope)
    if (cur) scoped.getState().requestFocusAt(cur.blockId, cur.anchor)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const [activeId, setActiveId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const foldsByPage = useHeadingFold((s) => s.byPage)
  const findOpen = useFindStore((s) => s.open)

  // 兜底:焦点不在块编辑器里(块选中态/空白处)时的 Cmd+Z / Cmd+Shift+Z / Cmd+Y → 文档级撤销。
  // 焦点在块内时块自身 handleKeyDown 已处理并 stopPropagation;输入框/整篇编辑器(contenteditable)留原生撤销。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return
      const k = e.key.toLowerCase()
      if (k !== 'z' && k !== 'y') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      // 这是 window 级监听:分屏时**两个** PageView 都挂着一份,不认作用域就会一次撤销两篇。
      if (activePageScope() !== scope) return
      e.preventDefault()
      const st = scoped.getState()
      if (k === 'y' || e.shiftKey) st.redo()
      else st.undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ---- 分片挂载:切页重置;编辑同页加行不重置(挂载早已追平,一个 idle 批内补上) ----
  const totalRows = manifest?.root.children.length ?? 0
  const [mountState, setMountState] = useState({ page: activePage, n: INITIAL_ROWS })
  // render 期间重置(非 effect):effect 版第一帧仍按旧上限全量 mount 新页,分片就失效了。
  if (mountState.page !== activePage) setMountState({ page: activePage, n: INITIAL_ROWS })
  const mountedRows = mountState.page === activePage ? mountState.n : INITIAL_ROWS
  useEffect(() => {
    if (mountedRows >= totalRows) return
    const h = idleMount(() => setMountState((s) => ({ ...s, n: s.n + MOUNT_BATCH })))
    return () => cancelIdleMount(h)
  }, [mountedRows, totalRows])

  if (!manifest) return <div className="empty-state">打开一个 Vault，或新建页面开始。</div>
  const root = manifest.root

  // 标题小节折叠:每行取首块的标题级别;被某个折叠标题覆盖的行整行隐藏(拖拽中临时全展开,防拖进黑洞)。
  const afterFirstLine = (s: string | undefined): string => {
    const i = (s ?? '').indexOf('\n')
    return i < 0 ? '' : (s ?? '').slice(i + 1)
  }
  const rowMeta = root.children.map((row) => {
    const firstId = row.columns[0]?.children[0]?.ref
    // 自身级别只看首块首行(决定这行配不配折叠箭头);**边界**要扫整行每个块的每一行 ——
    // 块内标题同样是小节边界,漏检就一折到底(见 headingFoldStore.sectionBoundaryLevel)。
    // self = 本行首行**之后**还藏着的边界(块内第二个标题 / 同行第二个块里的标题)。这一行自己就跨了
    // 小节,行级折叠切不开它 —— 直接不给箭头,免得折下去把不属于它的内容一起吞掉(评审 P1)。
    let bound = 0
    let self = 0
    for (const col of row.columns) {
      for (const ch of col.children) {
        const content = blocks[ch.ref]?.content
        const lv = sectionBoundaryLevel(content)
        if (lv && (!bound || lv < bound)) bound = lv
        const rest = ch.ref === firstId ? sectionBoundaryLevel(afterFirstLine(content)) : lv
        if (rest && (!self || rest < self)) self = rest
      }
    }
    return { firstId, level: headingLevel(firstId ? blocks[firstId]?.content : undefined), bound, self }
  })
  /** 这一行能折起后面多少行;0 = 不给折叠箭头。 */
  const sectionSpan = (i: number): number => {
    const m = rowMeta[i]
    if (!m.level || (m.self && m.self <= m.level)) return 0
    let c = 0
    for (let j = i + 1; j < rowMeta.length; j++) {
      if (rowMeta[j].bound && rowMeta[j].bound <= m.level) break
      c++
    }
    return c
  }
  const folds = foldedSet(foldsByPage, activePage ?? '')
  const hiddenRows = new Set<number>()
  if (!activeId) {
    for (let i = 0; i < rowMeta.length; i++) {
      const m = rowMeta[i]
      if (!m.level || !m.firstId || !folds.has(m.firstId)) continue
      for (let j = i + 1; j <= i + sectionSpan(i); j++) hiddenRows.add(j)
    }
  }

  const titleText = manifest.title || activePage?.split('/').pop() || ''
  const startTitleEdit = (): void => {
    setTitleDraft(titleText)
    setEditingTitle(true)
  }
  const commitTitle = async (): Promise<void> => {
    setEditingTitle(false)
    const name = titleDraft.trim()
    if (name && name !== titleText) await renamePage(name)
  }

  const columnOfBlock = (id: string): string | null => {
    for (const row of root.children)
      for (const col of row.columns) if (col.children.some((r) => r.ref === id)) return col.id
    return null
  }

  const onDragStart = (e: DragStartEvent): void => {
    setActiveId(String(e.active.id))
    setDnd(String(e.active.id), null)
    useBlockSelection.getState().select(String(e.active.id)) // 拖拽期该块保持高亮
  }

  const onDragOver = (e: DragOverEvent): void => {
    const active = String(e.active.id)
    const overId = e.over ? String(e.over.id) : ''
    // Only blocks get the insertion line; columns/edges/gaps highlight themselves.
    const overBlock = overId && !overId.includes(':') && overId !== active ? overId : null
    setDnd(active, overBlock)
  }

  const onDragCancel = (): void => {
    setActiveId(null)
    setDnd(null, null)
  }

  const onDragEnd = (e: DragEndEvent): void => {
    setActiveId(null)
    setDnd(null, null)
    const activeBlock = String(e.active.id)
    if (!e.over) return
    const overId = String(e.over.id)

    if (overId.startsWith('bedge:')) {
      // 块级并排:只与目标那一块成两栏(Notion 语义)
      const [, targetBlock, side] = overId.split(':')
      scoped.getState().pairBlocks(activeBlock, targetBlock, side === 'left' ? 'left' : 'right')
    } else if (overId.startsWith('edge:')) {
      const [, rowId, side] = overId.split(':')
      addColumnWithBlock(rowId, activeBlock, side === 'left' ? 'left' : 'right')
    } else if (overId.startsWith('gap:')) {
      addRowWithBlock(Number(overId.slice(4)), activeBlock)
    } else if (overId.startsWith('col:')) {
      moveBlock(activeBlock, overId.slice(4), null)
    } else if (overId !== activeBlock) {
      const colId = columnOfBlock(overId)
      if (colId) moveBlock(activeBlock, colId, overId)
    }
  }

  return (
    <div
      className="page-view"
      data-bare={bare || undefined}
      onKeyDownCapture={(e) => {
        // 编辑器内 Cmd/Ctrl+F → 页内查找(焦点在编辑器里才接管,别抢应用全局的查找)
        if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F') && !e.shiftKey && !e.altKey) {
          e.preventDefault()
          useFindStore.getState().openBar()
        }
      }}
    >
      {findOpen && <FindBar />}
      <BlockSelectionKeys />
      {!bare && (
      <header className="page-header">
        {editingTitle ? (
          <input
            className="page-title-edit"
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => void commitTitle()}
            onKeyDown={(e) => {
              // focusBody 必须在 commitTitle 之前:renamePage 同步快照 manifest 并在返回时回填,
              // 顺序反了则空正文刚建的首块会被冲掉。
              if (e.key === 'Enter') {
                e.preventDefault()
                focusBody(scoped)
                void commitTitle()
              } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                // 仅当光标在标题末尾(无选区)才跳正文,否则放行原生移动。
                const el = e.currentTarget
                if (el.selectionStart === el.value.length && el.selectionEnd === el.value.length) {
                  e.preventDefault()
                  focusBody(scoped)
                  void commitTitle()
                }
              } else if (e.key === 'Escape') {
                setEditingTitle(false)
              }
            }}
          />
        ) : (
          <div className="page-title" onClick={startTitleEdit} title="点击重命名页面">
            {titleText}
          </div>
        )}
        <div className="page-status" data-status={status}>
          {statusLabel(status)}
        </div>
      </header>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={pointerFirst}
        // 桌面壳把 edge-zone 静止时压成零宽、拖拽中才浮现 → 必须拖拽期间持续重测 droppable 矩形。
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <div className="stack" data-dnd={activeId ? '' : undefined}>
          <RowGap index={-1} />
          {root.children.map((row, i) => {
            if (i >= mountedRows) return null // 分片:后续行在空闲帧逐批补挂
            if (hiddenRows.has(i)) return null
            const meta = rowMeta[i]
            const span = sectionSpan(i) // 自带「本行自己就跨小节 → 不给箭头」的闸
            const folded = !!(meta.firstId && folds.has(meta.firstId))
            return (
              <Fragment key={row.id}>
                {/* ⚠️ 外壳 <div.amx-hfold-wrap> **必须恒定存在**,只在里面按条件放折叠箭头。
                    别改回「有小节才包一层 div、没有就裸渲染 Row」的三元:那样一行从标题变成正文时
                    (行首退格把 `# x` 降级),这个位置的元素类型就变了,React 会把整棵子树卸载重建
                    —— 连同里面的 ProseMirror 编辑器,焦点当场掉回 body,于是「块首退格」在标题块上
                    只生效一次、再按毫无反应、永远并不进上一块(用户实报;取证栈:commitDeletionEffects
                    → removeChild(DIV.amx-hfold-wrap) → focusout)。壳只有 position:relative,常驻无副作用。
                    仪器:npm run check:bsfocus */}
                <div className={`amx-hfold-wrap${span > 0 && meta.firstId ? ' has-fold' : ''}`}>
                  {folded && span > 0 && <span className="amx-hfold-count">{span}</span>}
                  {/* 折叠箭头交给 BlockHost 摆进 .block-gutter(⠿ 旁边)——行壳与块的左缘差着一个
                      .edge-zone,在这里绝对定位必压手柄。仪器:e2e:editor T40 */}
                  <Row
                    row={row}
                    gutterLead={
                      span > 0 && meta.firstId ? (
                        <button
                          className={`amx-hfold${folded ? ' folded' : ''}`}
                          title={folded ? `展开小节(${span} 行)` : '折叠小节'}
                          onClick={(e) => {
                            e.stopPropagation() // 手柄同族:别顺带触发块选中
                            useHeadingFold.getState().toggle(activePage ?? '', meta.firstId!)
                          }}
                        >
                          ›
                        </button>
                      ) : undefined
                    }
                  />
                </div>
                <RowGap index={i} />
              </Fragment>
            )
          })}
        </div>
        <DragOverlay dropAnimation={null}>
          {activeId ? <div className="drag-overlay">{previewText(blocks[activeId]?.content)}</div> : null}
        </DragOverlay>
      </DndContext>

      {/* 正文下方的续写区(点空白 = 末尾建块)。非 bare 有下面 footer 的「＋ 新块」,不需要。 */}
      {bare && <div className="page-tail" onClick={() => appendAtEnd(scoped)} />}

      {!bare && (
        <div className="page-footer">
          <button className="add-block" onClick={() => insertBlockAfter(null)}>
            ＋ 新块
          </button>
          <span className="hint-inline">拖动 ⠿ 到列边缘可分栏 · 拖到行间可新建行</span>
        </div>
      )}

      {!bare && <BacklinksPanel />}
    </div>
  )
}
