/**
 * Chat 画布(方案 docs/ToBeImproved/Chat画布分支方案_2026-10-18 第二步):同一棵会话树的另一种看法,一轮问答一张卡(Flowith 式)。
 * 会话照旧存 DB,这里什么都不存:位置全按树自动排(拖动摆位是第三步),只记每棵树用不用画布、竖排还是横排(本机偏好)。
 *
 *  - 舞台 / 平移缩放 / 手势 / 缩略图 / 缩放胶囊全用 canvasKit(Amadeus 画布、仪表盘、自动化同一套),外观照 Amadeus 画布。
 *    卡里是真消息渲染器(EditorialMessage),卡上只留两个动词:接着问(= 从这一轮分出一支)/ 顺便问。
 *  - 竖排缺省:接着问的那一轮长在卡下面,兄弟并排;横排:往右长,兄弟上下叠。卡里直接读全文(超过约 40 行原地折起)。
 *    「只看这一支」:当前这一支全文,旁支只露问题和两行、淡一档,点一下就切过去。
 *  - 自动跟随:当前这一支有卡在生成时,像 Chat View 一样跟着往下走(卡底停在输入框上方);一滚走 / 拖走就停,
 *    那张卡出了可读区就出一颗箭头(同「回到底部」),点了飞回去并恢复跟随。
 *  - 单击卡 = 选中(不在当前这一支上就切到那一支,主区就地换);双击 = 切回对话、滚到那一轮。
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownRight, Hand, ListTree, MoveDown, MoveRight } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { UiMessage } from '../../types'
import { useApp } from '../../stores/appStore'
import { registerMessages, useI18n } from '../../i18n'
import { useChatWaitDetailsEnabled } from '../../chatWaitDetails'
import {
  CanvasChrome, CanvasMiniMap, gridLayerStyle, hostSize, recallViewport, useCanvasGestures, useCanvasViewport, zoomAt,
  type Box, type CanvasViewportApi, type Viewport,
} from '../../amadeus/unified/canvasKit'
import { canvasMiniMapEnabled, setCanvasMiniMapEnabled } from '../../amadeus/unified/canvasPrefs'
import { EditorialMessage, type FileCtx, type MessageHandlers } from './EditorialMessage'
import { openBtw } from './btwStore'
import { splitLeadingRefs } from './RefChipView'
import { splitLeadingQuotes } from './quotes'
import { buildTurnTree, type TurnTree } from './canvasTree'

registerMessages({
  'chatcanvas.seg.aria': { zh: '对话的看法', en: 'Chat layout' },
  'chatcanvas.seg.chat': { zh: '对话', en: 'Chat' },
  'chatcanvas.seg.canvas': { zh: '画布', en: 'Canvas' },
  'chatcanvas.aria': { zh: '对话画布', en: 'Chat canvas' },
  'chatcanvas.vertical': { zh: '竖排', en: 'Vertical layout' },
  'chatcanvas.horizontal': { zh: '横排', en: 'Horizontal layout' },
  'chatcanvas.focus': { zh: '只看这一支', en: 'Focus on this branch' },
  'chatcanvas.hand': { zh: '抓手：拖到哪都是平移', en: 'Hand: drag anywhere to pan' },
  'chatcanvas.more': { zh: '展开全文', en: 'Show full reply' },
  'chatcanvas.follow': { zh: '回到正在生成的那张卡', en: 'Back to the reply being written' },
  'chatcanvas.attach': { zh: '接在', en: 'Continues after' },
  'chatcanvas.openHint': { zh: '双击在对话里打开', en: 'Double-click to open in the chat' },
  'chatcanvas.empty': { zh: '还没有对话。在下面输入第一句。', en: 'No messages yet. Type the first one below.' },
})

// ── 每棵树用不用画布、竖排还是横排(本机偏好,按树根记;切到分支不翻回对话) ──
export type CanvasDir = 'v' | 'h'
export interface CanvasPref { on: boolean; dir: CanvasDir }
const PREF_KEY = 'tangu.chatCanvas'
const PREF_CAP = 200 // ponytail: 只留最近 200 棵树,超出按写入先后丢
function readPrefs(): Record<string, Partial<CanvasPref>> {
  try { const v = JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); return v && typeof v === 'object' ? v : {} } catch { return {} }
}
export function useChatCanvasPref(rootId: string | null): [CanvasPref, (patch: Partial<CanvasPref>) => void] {
  const [all, setAll] = useState(readPrefs)
  const set = useCallback((patch: Partial<CanvasPref>): void => {
    if (!rootId) return
    setAll((prev) => {
      const next = { ...prev }
      delete next[rootId] // 删了再放 = 排到最后,裁掉的是最久没碰的
      next[rootId] = { ...prev[rootId], ...patch }
      for (const k of Object.keys(next).slice(0, -PREF_CAP)) delete next[k]
      try { localStorage.setItem(PREF_KEY, JSON.stringify(next)) } catch { /* 隐私模式 / 存满:本次会话内照样生效 */ }
      return next
    })
  }, [rootId])
  const saved = rootId ? all[rootId] : undefined
  return [{ on: !!saved?.on, dir: saved?.dir === 'h' ? 'h' : 'v' }, set]
}

// ── 自动排版 ──
const CARD_W = 340
const GAP = { v: { x: 40, y: 56 }, h: { x: 72, y: 28 } }
const EST_H = 180 // 还没量到的卡先按这个高排
const FOLD_H = 880 // 约 40 行;超过在卡里折起
const START_Z = 0.9 // 竖排正好放下三张并排的卡

/** 朴素的子树宽度排法:竖排 = 子卡在下、兄弟并排、父卡居中;横排 = 子卡在右、兄弟上下叠、父卡与第一张子卡齐顶。
 *  ponytail: 子树按包围盒占位(O(n)),宽树会比 Reingold-Tilford 松;兄弟多了再换紧凑排法。 */
export function layoutTree(tree: TurnTree, heights: ReadonlyMap<string, number>, dir: CanvasDir): Map<string, Box> {
  const out = new Map<string, Box>()
  const h = (k: string): number => heights.get(k) ?? EST_H
  const kids = (k: string): string[] => tree.cards.get(k)?.children ?? []
  const span = new Map<string, number>()
  const gap = GAP[dir]
  // 竖排量宽、横排量高
  const measure = (k: string): number => {
    const cs = kids(k)
    const sum = cs.reduce((s, c, i) => s + measure(c) + (i ? (dir === 'v' ? gap.x : gap.y) : 0), 0)
    const own = dir === 'v' ? CARD_W : h(k)
    const v = Math.max(own, sum)
    span.set(k, v)
    return v
  }
  const kidsSpan = (k: string): number => kids(k).reduce((s, c, i) => s + span.get(c)! + (i ? (dir === 'v' ? gap.x : gap.y) : 0), 0)
  const place = (k: string, a: number, b: number): void => {
    if (dir === 'v') {
      const w = span.get(k)!
      out.set(k, { x: a + (w - CARD_W) / 2, y: b, w: CARD_W, h: h(k) })
      let x = a + (w - kidsSpan(k)) / 2
      for (const c of kids(k)) { place(c, x, b + h(k) + gap.y); x += span.get(c)! + gap.x }
    } else {
      out.set(k, { x: a, y: b, w: CARD_W, h: h(k) })
      let y = b
      for (const c of kids(k)) { place(c, a + CARD_W + gap.x, y); y += span.get(c)! + gap.y }
    }
  }
  let at = 0
  for (const r of tree.roots) {
    const s = measure(r)
    if (dir === 'v') place(r, at, 0)
    else place(r, 0, at)
    at += s + (dir === 'v' ? gap.x : gap.y) * 2
  }
  return out
}

function edgePath(a: Box, b: Box, dir: CanvasDir): string {
  if (dir === 'v') {
    const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y, m = (y2 - y1) / 2
    return `M${x1},${y1} C${x1},${y1 + m} ${x2},${y2 - m} ${x2},${y2}`
  }
  const x1 = a.x + a.w, y1 = a.y + 24, x2 = b.x, y2 = b.y + 24, m = (x2 - x1) / 2
  return `M${x1},${y1} C${x1 + m},${y1} ${x2 - m},${y2} ${x2},${y2}`
}

/** 卡头那句问题:剥掉开头的「已选择」芯片行和引用块(和用户气泡同一套解析)。 */
function questionText(m: UiMessage): string {
  const lead = splitLeadingRefs(m.content)
  const quoted = splitLeadingQuotes(lead ? lead.body : m.content)
  const body = (quoted ? quoted.body : lead ? lead.body : m.content).trim()
  return body || lead?.refs.map((r) => r.name).join(' ') || quoted?.quotes[0] || ''
}

export function ChatCanvas({ rootId, activeId, dir, onDir, onOpenTurn }: {
  rootId: string
  activeId: string
  dir: CanvasDir
  onDir: (dir: CanvasDir) => void
  /** 双击:切回对话、滚到那个会话里的那一条。 */
  onOpenTurn: (sessionId: string, messageId: string) => void
}) {
  const { t } = useI18n()
  const showWaitDetails = useChatWaitDetailsEnabled()
  const sessions = useApp((s) => s.sessions)
  const branches = useMemo(() => sessions.filter((x) => x.parent_session_id === rootId && !!x.fork_message_id), [sessions, rootId])
  const ids = useMemo(() => [rootId, ...branches.map((b) => b.id)], [rootId, branches])
  const msgs = useApp(useShallow((s) => Object.fromEntries(ids.map((id) => [id, s.messagesBySession[id]])) as Record<string, UiMessage[] | undefined>))
  const loading = useApp((s) => !!s.historyLoading[rootId])
  const cfg = useApp((s) => s.cfg)
  const execModes = useApp(useShallow((s) => Object.fromEntries(ids.map((id) => [id, s.configBySession[id]?.execMode]))))
  // 分支的历史不在内存里(只看过主线):画布一开就把整棵树拉齐;拉到一支画一支
  useEffect(() => { for (const id of ids) void useApp.getState().loadSessionHistory(id) }, [ids])
  const tree = useMemo(() => buildTurnTree(rootId, branches, (sid) => msgs[sid]), [rootId, branches, msgs])

  // ── 量卡高(布局用)与正文是否超长(折起用):一个 ResizeObserver 看卡和卡里的正文 ──
  const [heights, setHeights] = useState<Map<string, number>>(() => new Map())
  const [tall, setTall] = useState<Set<string>>(() => new Set())
  const roRef = useRef<ResizeObserver | null>(null)
  if (!roRef.current && typeof ResizeObserver !== 'undefined') {
    let raf = 0
    const dirty = new Set<HTMLElement>()
    roRef.current = new ResizeObserver((entries) => {
      for (const e of entries) dirty.add(e.target as HTMLElement)
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const hs: Array<[string, number]> = []
        const ts: Array<[string, boolean]> = []
        for (const el of dirty) {
          if (!el.isConnected) continue
          const key = el.dataset.cvNode || el.dataset.cvInner
          if (!key) continue
          if (el.dataset.cvNode) hs.push([key, el.offsetHeight])
          else ts.push([key, el.offsetHeight > FOLD_H + 4])
        }
        dirty.clear()
        if (hs.length) setHeights((prev) => (hs.some(([k, v]) => prev.get(k) !== v) ? new Map([...prev, ...hs]) : prev))
        if (ts.length) setTall((prev) => {
          if (ts.every(([k, v]) => prev.has(k) === v)) return prev
          const next = new Set(prev)
          for (const [k, v] of ts) { if (v) next.add(k); else next.delete(k) }
          return next
        })
      })
    })
  }
  useEffect(() => () => roRef.current?.disconnect(), [])
  const track = useCallback((el: HTMLElement | null): void => { if (el) roRef.current?.observe(el) }, [])
  const boxes = useMemo(() => layoutTree(tree, heights, dir), [tree, heights, dir])
  const boxesRef = useRef(boxes)
  boxesRef.current = boxes

  // ── 选中 / 当前这一支 ──
  const activePath = tree.paths[activeId] ?? []
  const [sel, setSel] = useState<string | null>(null)
  const selected = sel && activePath.includes(sel) ? sel : activePath[activePath.length - 1] ?? null
  const hot = new Set<string>() // 树根 → 选中卡这条路上的卡(它们头上那根线加深)
  for (let k: string | null = selected; k; k = tree.cards.get(k)?.parent ?? null) hot.add(k)
  const [focus, setFocus] = useState(false)
  const [hand, setHand] = useState(false)
  const handRef = useRef(hand)
  handRef.current = hand
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const pick = (key: string): void => {
    const c = tree.cards.get(key)
    if (!c) return
    setSel(key)
    if (!c.at[activeId]) useApp.getState().setActiveId(c.sid) // 不在当前这一支上:主区就地换成它那一支
  }
  const openTurn = (key: string): void => {
    const c = tree.cards.get(key)
    if (!c) return
    const sid = c.at[activeId] ? activeId : c.sid
    onOpenTurn(sid, c.at[sid].first)
  }
  const openTurnRef = useRef(openTurn)
  openTurnRef.current = openTurn

  // ── 舞台:canvasKit 的视口 + 手势(空白拖 = 平移;卡里照常选字,不拖不框选) ──
  const host = useRef<HTMLDivElement>(null)
  const memoKey = `chat-canvas:${rootId}:${dir}`
  const followRef = useRef(true)
  const [follow, setFollow] = useState(true)
  const landed = useRef(!!recallViewport(memoKey))
  // 落位后卡还会再长一点(卡里的内容晚一拍渲染完):1.5s 内、用户没碰过、还是同一张卡,就跟着再落一次
  const settle = useRef<{ key: string; until: number } | null>(null)
  // 刚写完的那张:写完后卡底还会长出一行操作条,跟着的话 1.5s 内接着把卡底贴在阅读线上
  const afterglow = useRef<{ key: string; until: number } | null>(null)
  const flyRaf = useRef(0)
  // 用户自己挪了视口(滚轮 / 拖空白 / 捏合 / 缩略图 / 适应内容):停跟;正在往回飞的那一下也作废
  const release = useCallback((): void => {
    cancelAnimationFrame(flyRaf.current)
    settle.current = null
    afterglow.current = null
    if (followRef.current) { followRef.current = false; setFollow(false) }
  }, [])
  const view = useCanvasViewport(host, memoKey, release, { x: 0, y: 0, z: START_Z })
  // 手势层的平移 / 捏合也算「用户挪走了」:包一层 setVp。跟随自己用原版 setVp,不会把自己停掉。
  const userView: CanvasViewportApi = { ...view, setVp: (next: Viewport) => { release(); view.setVp(next) } }
  const gesture = useCanvasGestures(host, userView, {
    boxes: () => boxesRef.current,
    commit: () => {}, // 位置不存(第三步才做拖动摆位)
    hitKey: (el) => (handRef.current ? null : el.closest<HTMLElement>('[data-cv-node]')?.dataset.cvNode ?? null),
    isEditing: () => true, // 卡里的字照常选、按钮照常点:手势层对卡整个让路
    blankPan: true,
    onDoubleClick: (key) => { if (key) openTurnRef.current(key) },
    minW: CARD_W,
    minH: 40,
  }, false)
  useEffect(() => gesture.bind(host.current), [gesture.bind])
  useEffect(() => view.bindWheel(host.current), [view.bindWheel])
  const [mini, setMini] = useState(canvasMiniMapEnabled)

  const composerInset = (): number => {
    const v = host.current ? parseFloat(getComputedStyle(host.current).getPropertyValue('--t2-composer-h')) : NaN
    return (Number.isFinite(v) ? v : 96) + 44 // 让开输入框上方「接在 · …」那一行
  }
  /** 舒服的阅读位置:卡底停在输入框上方(和 Chat View 贴底一样,新出来的字在最下面);卡在横向视野外就居中。 */
  const readingVp = (b: Box, vp: Viewport): Viewport => {
    const { w, h } = hostSize(host.current)
    const z = vp.z
    const left = b.x * z + vp.x
    const x = left < 16 || left + b.w * z > w - 16 ? w / 2 - (b.x + b.w / 2) * z : vp.x
    return { z, x, y: h - composerInset() - (b.y + b.h) * z }
  }

  // 换了排法:这个排法记过视口就回到那里,没记过就重新落位。⚠️ 排在跟随之前:跟随一写视口就落进新排法的记忆,
  // 后读就把记着的那份冲掉了(Codex 评审)
  const lastDir = useRef(dir)
  useLayoutEffect(() => {
    if (lastDir.current === dir) return
    lastDir.current = dir
    const r = recallViewport(memoKey)
    settle.current = null
    if (r) { landed.current = true; view.setVp(r) } else landed.current = false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir])

  // ── 自动跟随:当前这一支上那张在生成的卡 ──
  const streamKey = activePath.find((k) => tree.cards.get(k)!.answers.some((m) => m.status === 'streaming')) ?? null
  const lastStream = useRef<string | null>(null)
  useLayoutEffect(() => {
    // 这一支上新冒出一张在生成的卡(= 刚发出去一句):重新跟上
    if (streamKey && streamKey !== lastStream.current) { followRef.current = true; setFollow(true) }
    // 刚写完的那张不折起:正跟着读到它的末尾,一折视野就落到卡下面的空白里(Codex 评审实测卡跳出视口上方一千多像素)
    const done = lastStream.current
    // 只认真写完的:切到别的支时 streamKey 也会变空,那张其实还在写(Codex 复核)
    if (done && done !== streamKey && !tree.cards.get(done)?.answers.some((m) => m.status === 'streaming')) {
      setExpanded((s) => (s.has(done) ? s : new Set(s).add(done)))
      afterglow.current = followRef.current ? { key: done, until: performance.now() + 1500 } : null
    }
    lastStream.current = streamKey
  }, [streamKey])
  useLayoutEffect(() => {
    const g = afterglow.current
    const k = streamKey ?? (g && performance.now() < g.until && activePath.includes(g.key) ? g.key : null)
    if (!k || !followRef.current || !heights.has(k)) return
    const b = boxes.get(k)
    if (!b) return
    const cur = view.vpRef.current
    const next = readingVp(b, cur)
    landed.current = true // 跟着生成落过位了,生成完不再跳回「最后一张卡顶」
    settle.current = null
    if (Math.abs(next.x - cur.x) > 0.5 || Math.abs(next.y - cur.y) > 0.5) view.setVp(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxes, streamKey, follow])
  // 第一次打开(这棵树、这个排法没记过视口):同 Chat View 打开在末尾 —— 这一支最后一张卡的卡底落在阅读线上,
  // 上面露出前几轮;卡比视口高就卡顶留一点边
  useLayoutEffect(() => {
    if (!selected || streamKey) return
    const s = settle.current
    if (landed.current && !(s && s.key === selected && performance.now() < s.until)) return
    for (let k: string | null = selected; k; k = tree.cards.get(k)?.parent ?? null) if (!heights.has(k)) return // 上面的卡还没量完,位置还会变
    const b = boxes.get(selected)
    const { w, h } = hostSize(host.current)
    if (!b || !w) return
    if (!landed.current) settle.current = { key: selected, until: performance.now() + 1500 }
    landed.current = true
    view.setVp({ z: START_Z, x: w / 2 - (b.x + b.w / 2) * START_Z, y: Math.max(32 - b.y * START_Z, h - composerInset() - (b.y + b.h) * START_Z) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxes, selected])

  // 生成中的那张卡出了可读区:出箭头(朝它在的方向)
  let arrow: 'up' | 'down' | 'left' | 'right' | null = null
  const sb = streamKey ? boxes.get(streamKey) : undefined
  if (!follow && sb && host.current) {
    const { w, h } = hostSize(host.current)
    const vp = view.vp
    const top = sb.y * vp.z + vp.y, bottom = top + sb.h * vp.z, left = sb.x * vp.z + vp.x, right = left + sb.w * vp.z
    if (right < 0) arrow = 'left'
    else if (left > w) arrow = 'right'
    else if (bottom < 0) arrow = 'up'
    else if (bottom > h - composerInset() + 8) arrow = 'down'
  }
  const flyBack = (): void => {
    const b = streamKey ? boxesRef.current.get(streamKey) : undefined
    if (!b) return
    cancelAnimationFrame(flyRaf.current)
    const from = view.vpRef.current
    const to = readingVp(b, from)
    const t0 = performance.now()
    const step = (now: number): void => {
      const p = Math.min(1, (now - t0) / 240)
      const e = 1 - (1 - p) ** 3
      view.setVp({ z: from.z, x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e })
      if (p < 1) flyRaf.current = requestAnimationFrame(step)
      else { followRef.current = true; setFollow(true) }
    }
    flyRaf.current = requestAnimationFrame(step)
  }
  useEffect(() => () => cancelAnimationFrame(flyRaf.current), [])

  // ── 卡里消息的上下文与动作(按会话 / 消息缓存,EditorialMessage 的 memo 才挡得住流式重渲) ──
  const setFilePreview = useApp((s) => s.setFilePreview)
  const ctxCache = useMemo(() => new Map<string, FileCtx>(), [cfg, setFilePreview])
  const ctxFor = (sid: string): FileCtx => {
    const k = `${sid}:${execModes[sid] ?? ''}`
    let c = ctxCache.get(k)
    if (!c) { c = { cfg, sessionId: sid, execMode: execModes[sid], onOpenPreview: setFilePreview }; ctxCache.set(k, c) }
    return c
  }
  const handlerCache = useRef(new Map<string, MessageHandlers>())
  const handlersFor = (sid: string, id: string): MessageHandlers => {
    const k = `${sid}:${id}`
    let h = handlerCache.current.get(k)
    if (!h) {
      h = {
        onCopy: (text) => { try { void navigator.clipboard.writeText(text) } catch { /* ignore */ } },
        onBranch: () => void useApp.getState().branchFromMessage(id, sid),
        onAside: () => {
          const s = useApp.getState().sessions.find((x) => x.id === sid)
          openBtw({ sessionId: sid, title: s?.title, modelId: s?.model_id || undefined, messageId: id })
        },
      }
      handlerCache.current.set(k, h)
    }
    return h
  }

  const tail = activePath.length ? tree.cards.get(activePath[activePath.length - 1]) : undefined
  const tailText = tail ? (tail.user ? questionText(tail.user) : tail.answers[0]?.content || '') : ''
  const vp = view.vp
  const items = [...boxes].map(([key, box]) => ({ key, kind: 'card' as const, box }))
  return (
    <div className="t2cv" data-dir={dir} data-hand={hand ? '' : undefined} data-follow={follow ? '' : undefined}>
      <div className="t2cv-stage" ref={host} tabIndex={-1} aria-label={t('chatcanvas.aria')}>
        <div className="am-app t2cv-am"><div className="amx-stage-grid" style={gridLayerStyle(vp)} /></div>
        <div className="t2cv-world" style={{ transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.z})` }}>
          <svg className="t2cv-edges" aria-hidden="true">
            {[...tree.cards.values()].map((c) => {
              const a = c.parent ? boxes.get(c.parent) : undefined
              const b = boxes.get(c.key)
              return a && b ? <path key={c.key} className={hot.has(c.key) ? 'hot' : undefined} d={edgePath(a, b, dir)} /> : null
            })}
          </svg>
          {[...tree.cards.values()].map((c) => {
            const b = boxes.get(c.key)!
            const dim = focus && !activePath.includes(c.key)
            const streaming = c.answers.some((m) => m.status === 'streaming')
            // 一上来就限高(短卡不受影响):等量出「长」再折,先量到的是展开高,镜头按它落位后卡一缩就落空了
            const clamp = !dim && !streaming && !expanded.has(c.key)
            const folded = clamp && tall.has(c.key)
            return (
              <div
                key={c.key}
                ref={track}
                className="t2cv-card"
                data-cv-node={c.key}
                data-sel={c.key === selected ? '' : undefined}
                data-dim={dim ? '' : undefined}
                data-streaming={streaming ? '' : undefined}
                data-measured={heights.has(c.key) ? '' : undefined}
                style={{ left: b.x, top: b.y, width: b.w }}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest('button, a[href], input, textarea, summary')) return
                  if (!window.getSelection()?.isCollapsed) return // 在卡里选字,不算点卡
                  pick(c.key)
                }}
              >
                {c.user && <div className="t2cv-q" title={t('chatcanvas.openHint')}>{questionText(c.user)}</div>}
                <div className="t2cv-body" data-clamp={clamp ? '' : undefined} data-folded={folded ? '' : undefined}>
                  <div className="t2cv-inner" ref={track} data-cv-inner={c.key}>
                    {c.answers.map((m) => (
                      <EditorialMessage key={m.id} msg={m} fileCtx={ctxFor(c.sid)} handlers={handlersFor(c.sid, m.id)} showWaitDetails={showWaitDetails} />
                    ))}
                  </div>
                </div>
                {folded && (
                  <button type="button" className="t2cv-more" onClick={() => setExpanded((s) => new Set(s).add(c.key))}>{t('chatcanvas.more')}</button>
                )}
              </div>
            )
          })}
        </div>
        <div className="am-app t2cv-am">
          <CanvasChrome
            zoom={vp.z}
            onZoomBy={(f) => { const { w, h } = hostSize(host.current); userView.setVp(zoomAt(vp, vp.z * f, w / 2, h / 2)) }}
            onFit={() => view.fitTo([...boxes.values()], 64)}
            mini={mini}
            onMini={(on) => { setMini(on); setCanvasMiniMapEnabled(on) }}
            extra={<>
              <button type="button" className={dir === 'v' ? 'is-on' : ''} aria-pressed={dir === 'v'} title={t('chatcanvas.vertical')} data-testid="cv-dir-v" onClick={() => onDir('v')}><MoveDown size={12} /></button>
              <button type="button" className={dir === 'h' ? 'is-on' : ''} aria-pressed={dir === 'h'} title={t('chatcanvas.horizontal')} data-testid="cv-dir-h" onClick={() => onDir('h')}><MoveRight size={12} /></button>
              <button type="button" className={focus ? 'is-on' : ''} aria-pressed={focus} title={t('chatcanvas.focus')} data-testid="cv-focus" onClick={() => setFocus((v) => !v)}><ListTree size={12} /></button>
              <button type="button" className={hand ? 'is-on' : ''} aria-pressed={hand} title={t('chatcanvas.hand')} data-testid="cv-hand" onClick={() => setHand((v) => !v)}><Hand size={12} /></button>
            </>}
          />
          {mini && <CanvasMiniMap hostRef={host} vp={vp} items={items} onCenter={view.centerOn} />}
        </div>
      </div>
      {/* 舞台外面:手势层在舞台上拿指针捕获(空白拖 = 平移),放在里面这颗箭头就点不动 */}
      {arrow && (
        <button type="button" className="jump-bottom t2-jump t2cv-jump" data-dir={arrow} title={t('chatcanvas.follow')} aria-label={t('chatcanvas.follow')} onClick={flyBack}>
          {arrow === 'up' ? <ArrowUp size={16} /> : arrow === 'left' ? <ArrowLeft size={16} /> : arrow === 'right' ? <ArrowRight size={16} /> : <ArrowDown size={16} />}
        </button>
      )}
      {!tree.cards.size && !loading && <div className="t2cv-empty">{t('chatcanvas.empty')}</div>}
      {tailText && (
        <div className="t2cv-attach-row"><div className="t2cv-attach"><CornerDownRight size={12} /><span>{t('chatcanvas.attach')}</span><b>{tailText}</b></div></div>
      )}
    </div>
  )
}

