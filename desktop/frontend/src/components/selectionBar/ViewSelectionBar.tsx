/**
 * 一个视图的划线条(应用层)。看 `watch` 里的 DOM 选区(或由调用方报 `selection`),在选区上方画共用的 SelectionBar,
 * 接上每个视图都有的动作 —— 带去对话、翻译、插件动作(⋯)—— 和它们的结果卡(InlineAiPanel 的只读形态)。
 * 聊天直接用;插件视图经 ctx.ui.mountSelectionBar(amadeus/plugins/selectionBarSurface.tsx)用同一个。
 * 笔记不用它:选区在 ProseMirror 里,条是 InlineToolbar,动作区嵌的是 @lcl/components 的 SelectionBarActions。
 *
 * ⚠️ 条和卡都 portal 到 body:聊天区自上而下几层 `container-type`(蕴含 layout containment)会让 fixed 后代以卡片
 *    而不是视口为包含块(见 lcl/engine/menuAnchor 的 useEdgeNudge 顶注)。OverlayAt 自己补偿缩放,坐标直接给视口 px。
 * ⚠️ 归属 ≠ 画的位置(划线菜单方案 B,2026-11-08):画在 body 下,归属是 owner(看选区的那个元素 / 插件视图根)。
 *    条和卡锚在那段字上(lcl/engine/textAnchor):滚动、视图尺寸变了跟着走,滚出可见区 / 视图被 Dockview 摘下就藏,
 *    回来原样出现;那段字没了(节点被重渲染)才收。只有给不出锚点的选区(插件 show() 只报了一个矩形)照旧一滚就收。
 * ⚠️ 不做全局监听:只看调用方交过来的那个元素。输入框、别的视图、插件自己画的菜单都不会被这里碰到。
 */
import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Languages, MessageSquareQuote } from 'lucide-react'
import { OverlayAt, mountLineSelection, rangeAnchor, rectAnchor, type TextAnchor } from '@lcl/engine'
import { SelectionBar, type SelectionBarAction, type SelectionBarTool } from '@lcl/components'
import { registerMessages, translate, useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { readTangu } from '@amadeus/plugins/tanguSeam'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { resolveIcon } from '@amadeus/components/icons'
import { InlineAiPanel, type InlineAiRun } from '@amadeus/unified/InlineAiPanel'
import { listSelectionActions, runSelectionAction, selectionActionKey, selectionBarOrder, type OwnedSelectionAction } from '../../selectionActions'
import { translateTargetOf } from '../../translateTarget'
import { selectionMarkdown } from './selectionMarkdown'

registerMessages({
  'selbar.ask': { zh: '问 Tangu', en: 'Ask Tangu' },
  'selbar.askTitle': { zh: '把选中的文字带到侧栏对话里问', en: 'Ask about the selection in the side chat' },
})

/** 选中的那一段。rect = 选区外接矩形(视口 px);markdown 给不出就等于 text。 */
export interface BarSelection {
  text: string
  markdown?: string
  rect: { left: number; right: number; top: number; bottom: number }
  /** 拖选的方向:条顺着它滑进来(借鉴 Comma 方案,10-24)。双击 / 三击选词选段没有拖的方向,不给。 */
  dir?: 'forward' | 'backward'
  /** 宿主自己看到的选区(克隆的):条和卡锚在它的起止节点上,跟着滚动走。 */
  range?: Range
  /** 调用方现量的矩形(插件 show({ getRect })):null = 现在看不见。没有 range 也没有它 = 只有 rect 快照,一滚就收。 */
  getRect?: () => { left: number; right: number; top: number; bottom: number } | null
}
export interface BarSource { title?: string; path?: string; sessionId?: string; page?: number }
/** 动的是变换、不是滚动的视图(画布):视口一挪就在 `watch` 里面的元素上派发这个事件,条跟着收(条是固定定位,不收会飘在原处)。 */
export const SELBAR_VIEWPORT_MOVED = 'selbar:viewport-moved'

export interface ViewSelectionBarProps {
  /** 'chat' 或 '<插件 id>:<视图 id>':插件动作的 scope / when 按它过滤。 */
  view: string
  /** 条和卡归谁(视图根):它被摘下 / 藏起来时条和卡跟着藏。缺省 = watch。插件视图不看选区(watch: false)时也要给。 */
  owner?: RefObject<HTMLElement | null>
  /** 这个视图是哪个插件的(scope: 'own' 认它)。宿主自己的视图不给。 */
  pluginId?: string
  /** 看谁的 DOM 选区(松开鼠标时出,选区收起 / 滚动 / 点到外面时收)。不给 = 不看,选区只由 `selection` 报。 */
  watch?: RefObject<HTMLElement | null>
  /** `watch` 指的元素会换(聊天切会话)时,把会换的东西放这里,监听跟着重挂。 */
  watchKey?: unknown
  selection?: BarSelection | null
  /** 条收起(动作点了 / Esc)时告诉调用方;自己报选区的要跟着清。 */
  onDismiss?: () => void
  tools?: (sel: BarSelection) => SelectionBarTool[]
  /** 接管「带去对话」那一格(聊天:引用 / 在侧栏提问 / 顺便问)。done() = 收起条并清掉选区。不给 = 缺省的「问 Tangu」。 */
  lead?: (sel: BarSelection, done: () => void) => SelectionBarAction[]
  /** 只换「问 Tangu」点了之后做什么(比如带上页码);false = 不要这一格。 */
  ask?: ((sel: BarSelection) => void) | false
  source?: (sel: BarSelection) => BarSource | undefined
  /** 条开在侧栏那种拿不到背景的面上:Genesis 材质加厚一档(body 下的浮层选择器认不出自己在哪,只能由调用方说)。 */
  dense?: boolean
}

interface Card {
  key: number
  title: string
  text: string
  markdown: string
  source?: BarSource
  x: number
  y: number
  top: number
  /** 锚点来源(从选区带过来):卡跟着那段字走。 */
  range?: Range
  getRect?: BarSelection['getRect']
  /** 翻译的目标语言;插件动作没有。 */
  language?: string
  /** 插件动作的键;没有 = 内置的翻译。 */
  action?: string
}

const pluginIcon = (icon: string | undefined): ReactNode => {
  const el = resolveIcon(icon)
  return el ? <span className="selbar-ico">{el}</span> : null
}

/** 选区 → 文字锚点(没有 range / getRect 的只有快照,不跟)。只建对象不挂监听:监听等 OverlayAt 订阅才挂(textAnchor)。 */
function anchorOf(owner: HTMLElement | null | undefined, src: { range?: Range; getRect?: BarSelection['getRect'] } | null, onLost: () => void): TextAnchor | null {
  if (!owner || !src) return null
  if (src.range) return rangeAnchor(owner, src.range, { onLost })
  if (src.getRect) return rectAnchor(owner, src.getRect, owner, { onLost })
  return null
}

/** 缺省的「问 Tangu」交给侧栏对话的引用:文字 + 一行出处(库里的文件写成 [[路径]],和笔记那枚同形)。 */
function quoteOf(sel: BarSelection, source: BarSource | undefined): string {
  const from = source?.path ? `[[${source.path}]]` : source?.title
  return (from ? `${sel.text}\n— ${from}` : sel.text).slice(0, 20_000)
}

export function ViewSelectionBar(p: ViewSelectionBarProps): ReactElement | null {
  const { t } = useI18n()
  const [own, setOwn] = useState<BarSelection | null>(null)
  const [card, setCard] = useState<Card | null>(null)
  const plugins = usePluginStore((s) => s.selectionActions)
  const { watch, watchKey } = p
  const onDismissRef = useRef(p.onDismiss)
  onDismissRef.current = p.onDismiss
  // 这一条能不能跟着那段字走(有锚点):能跟的,滚动 / 盒子变了不收(锚点跟着走或藏起来);只有快照的照旧收
  const followRef = useRef(false)

  useEffect(() => {
    const el = watch?.current
    if (!el) return
    const paint = mountLineSelection(el)
    // 按在条上的那一下(按钮按下即执行,条随即收起):它的松手可能落回这个元素,那不是一次新的选择,不能把条再弹出来。
    let fromBar = false
    const read = (e: MouseEvent): void => {
      if (fromBar) return
      const s = window.getSelection()
      if (!s || s.isCollapsed || !s.rangeCount) { setOwn(null); return }
      const content = selectionMarkdown(s, el)
      const text = content?.text ?? ''
      const range = s.getRangeAt(0)
      const at = range.commonAncestorContainer
      const host = at.nodeType === Node.ELEMENT_NODE ? (at as Element) : at.parentElement
      // 输入框 / 可编辑区里的选区不归这一条管(那里有自己的工具栏或什么都不该出)。
      if (!text || !el.contains(at) || host?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) { setOwn(null); return }
      const r = range.getBoundingClientRect()
      const back = s.anchorNode === s.focusNode ? s.focusOffset < s.anchorOffset
        : !!(s.anchorNode && s.focusNode && s.anchorNode.compareDocumentPosition(s.focusNode) & Node.DOCUMENT_POSITION_PRECEDING)
      const dir = e.detail > 1 ? undefined : back ? 'backward' : 'forward'
      setOwn({ text, markdown: content?.markdown, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, dir, range: range.cloneRange() })
    }
    const onSelection = (): void => { if (window.getSelection()?.isCollapsed) setOwn(null) }
    // 调用方自己报的选区(插件的 show())也跟着收:它是按当时的位置报的,滚了 / 盒子变了就不在那儿了。
    const clear = (): void => { setOwn(null); onDismissRef.current?.() }
    // 滚动 / 盒子变了 / 画布挪视口:能跟的条不收(锚点跟着走,看不见就藏),只有快照的才收
    const moved = (): void => { if (!followRef.current) clear() }
    // 条挂在 body 下,不会跟着这个视图一起被藏起来 / 挪走:点到视图和条的外面、视图的盒子变了(切标签页、拖分栏、缩窗口)都收。
    const onDown = (e: MouseEvent): void => {
      const at = e.target as Element | null
      fromBar = !!at?.closest?.('.selbar')
      if (at && !el.contains(at) && !fromBar) clear()
    }
    // 标记只管这一次按下到松手:松手过去就清。留到「下一次按下」的话,之后前面没有按下的松手(脚本派发的那种)会被它吞掉。
    // 冒泡阶段挂在 document 上,排在 el 自己的 read 后面。
    const onUp = (): void => { fromBar = false }
    let sized = false
    // 第一次回调是 observe 本身,不算。视图被摘下 / 藏起(切标签,盒子没了):条照旧收 —— 选区已经不在用户眼前,切回来也不该
    // 自己冒出来(方案 B §7);开着的结果卡是另一份状态,由它的锚点藏起、切回来还在。只是尺寸变了(拖分栏、缩窗口)才按 moved 走。
    const ro = new ResizeObserver(() => {
      if (!sized) { sized = true; return }
      if (!el.isConnected || !el.getClientRects().length) clear()
      else moved()
    })
    ro.observe(el)
    el.addEventListener('mouseup', read)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('selectionchange', onSelection)
    document.addEventListener('mousedown', onDown, true)
    // capture:滚动不冒泡,里面哪一层滚了都要收(选区的位置已经变了)。
    el.addEventListener('scroll', moved, { passive: true, capture: true })
    el.addEventListener(SELBAR_VIEWPORT_MOVED, moved, true)
    return () => {
      paint.dispose()
      ro.disconnect()
      el.removeEventListener('mouseup', read)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('selectionchange', onSelection)
      document.removeEventListener('mousedown', onDown, true)
      el.removeEventListener('scroll', moved, { capture: true })
      el.removeEventListener(SELBAR_VIEWPORT_MOVED, moved, true)
    }
  }, [watch, watchKey])

  const sel = p.selection ?? (watch ? own : null) // 调用方报的优先(插件的 show());没报才用自己看到的
  const dismiss = (): void => { setOwn(null); p.onDismiss?.() }
  const ownerEl = (p.owner ?? watch)?.current ?? null
  followRef.current = !!ownerEl && !!(sel?.range || sel?.getRect)
  const dismissRef = useRef(dismiss)
  dismissRef.current = dismiss
  // 条和卡各一个锚点(同一段字);那段字没了 → 收。随选区 / 卡换新,旧的在下面的 effect 里收拾
  const barAnchor = useMemo(() => anchorOf(ownerEl, sel, () => dismissRef.current()), [ownerEl, sel])
  useEffect(() => () => barAnchor?.dispose(), [barAnchor])
  // 只随那段字本身(range / getRect)重建:卡头换语言会换一个 card 对象,而切标签回来之后 card.range 这份活 Range 已经塌缩,
  // 拿它重建会被当成「字没了」把卡收掉;锚点自己记的起止节点没丢,沿用它。
  const cardSrc = card ? { range: card.range, getRect: card.getRect } : null
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cardAnchor = useMemo(() => anchorOf(ownerEl, cardSrc, () => setCard(null)), [ownerEl, !!card, card?.range, card?.getRect])
  useEffect(() => () => cardAnchor?.dispose(), [cardAnchor])
  /** 收起并清掉选区(动作把这段文字拿走了)。 */
  const done = (): void => { dismiss(); window.getSelection()?.removeAllRanges() }

  let bar: ReactElement | null = null
  if (sel) {
    const probe = readTangu()
    const source = p.source?.(sel)
    const openCard = (title: string, extra: Pick<Card, 'language' | 'action'>): void => {
      setCard({ key: Date.now(), title, text: sel.text, markdown: sel.markdown ?? sel.text, source, x: sel.rect.left, y: sel.rect.bottom + 6, top: sel.rect.top - 6, range: sel.range, getRect: sel.getRect, ...extra })
      dismiss() // 选区留着:卡在它下面,看得出译的是哪一段
    }
    const runPlugin = (o: OwnedSelectionAction): void => {
      if (o.item.output !== 'none') { openCard(o.item.title, { action: selectionActionKey(o) }); return }
      const cx = { text: sel.text, markdown: sel.markdown ?? sel.text, view: p.view, editable: false, source }
      dismiss()
      void runSelectionAction(o, cx).catch((e: unknown) => useApp.getState().toast(translate('selbar.failed', { title: o.item.title, e: String((e as Error)?.message || e) }), true))
    }
    const ask = p.ask
    const lead: SelectionBarAction[] = p.lead
      ? p.lead(sel, done)
      : ask === false || (!ask && !probe?.askInChat)
        ? []
        : [{ id: 'ask', label: t('selbar.ask'), title: t('selbar.askTitle'), icon: <MessageSquareQuote size={14} />, lead: true, testId: 'selection-ask', onRun: () => { done(); if (ask) ask(sel); else probe?.askInChat?.(quoteOf(sel, source)) } }]
    const actions: SelectionBarAction[] = [
      ...lead,
      ...(probe?.complete ? [{ id: 'translate', label: t('inlineai.action.translate'), icon: <Languages size={14} />, testId: 'selection-translate', onRun: () => openCard(t('inlineai.action.translate'), { language: translateTargetOf(sel.text) }) }] : []),
    ]
    const more: SelectionBarAction[] = listSelectionActions(plugins, { view: p.view, editable: false, length: sel.text.length })
      .map((o) => ({ id: selectionActionKey(o), label: o.item.title, icon: pluginIcon(o.item.icon), onRun: () => runPlugin(o) }))
    const tools = p.tools?.(sel) ?? []
    if (actions.length || more.length || tools.length) {
      bar = (
        <OverlayAt
          className="ui-popover selbar"
          x={(sel.rect.left + sel.rect.right) / 2}
          y={sel.rect.bottom + 8}
          anchorTop={sel.rect.top - 8}
          anchor={barAnchor}
          keep=".selbar-row"
          prefer="above"
          center
          role="toolbar"
          aria-label={t('chat.selection.actions')}
          data-testid="selection-bar"
          data-view={p.view}
          data-dir={sel.dir}
          data-dense={p.dense ? '' : undefined}
          // 点在条的空白处也不能丢选区(按钮自己各有一份 preventDefault)。
          onMouseDown={(e) => e.preventDefault()}
        >
          <SelectionBar tools={tools} actions={actions} more={more} moreHeading={t('selbar.plugins')} moreLabel={t('selbar.more')} order={selectionBarOrder()} onClose={dismiss} />
        </OverlayAt>
      )
    }
  }

  const runCard: InlineAiRun = async (_instruction, onDelta, signal) => {
    if (!card) return { text: '' }
    if (card.action) {
      const o = usePluginStore.getState().selectionActions.find((x) => selectionActionKey(x) === card.action)
      if (!o) throw new Error(translate('selbar.err.gone'))
      return { text: await runSelectionAction(o, { text: card.text, markdown: card.markdown, view: p.view, editable: false, source: card.source, signal, onDelta: (d) => { if (typeof d === 'string') onDelta(d) } }) }
    }
    const complete = readTangu()?.complete
    if (!complete) throw new Error(translate('inlineai.unavailable'))
    return complete({ action: 'translate', selection: card.markdown, language: card.language }, { signal, onDelta })
  }

  if (!bar && !card) return null
  return createPortal(
    <>
      {bar}
      {card && (
        <InlineAiPanel
          key={card.key}
          x={card.x}
          y={card.y}
          anchorTop={card.top}
          anchor={cardAnchor}
          title={card.title}
          hasSelection
          askFirst={false}
          run={runCard}
          onClose={() => setCard(null)}
          language={card.language ? { value: card.language, onChange: (id) => setCard({ ...card, key: Date.now(), language: id }) } : undefined}
        />
      )}
    </>,
    document.body,
  )
}
