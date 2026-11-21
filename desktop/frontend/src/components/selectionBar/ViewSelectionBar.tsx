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
import { MessageCircle } from 'lucide-react'
import { OverlayAt, mountLineSelection, rangeAnchor, rectAnchor, type TextAnchor } from '@lcl/engine'
import { SelectionBar, type SelectionBarAction, type SelectionBarTool } from '@lcl/components'
import { registerMessages, translate, useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { readTangu } from '@amadeus/plugins/tanguSeam'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { resolveIcon } from '@amadeus/components/icons'
import { InlineAiPanel, type InlineAiRun } from '@amadeus/unified/InlineAiPanel'
import { runSelectionAction, selectionActionKey, selectionActionPrefs, selectionActionTitle, selectionBarOrder, rememberSelectionLanguage, setSelectionAuto, type OwnedSelectionAction } from '../../selectionActions'
import { translateTargetOf } from '../../translateTarget'
import { selectionMarkdown } from './selectionMarkdown'
import { buildSelectionBarModel, cardOptionsOf, speakKeyOf, useSelectionBarLive, type SpeakPhase } from './barModel'
import { TtsSetupCard } from './TtsSetupCard'

registerMessages({
  'selbar.ask': { zh: '问 Tangu', en: 'Ask Tangu' },
  'selbar.askTitle': { zh: '把选中的文字带到侧栏对话里问', en: 'Ask about the selection in the side chat' },
  'selbar.speakFailed': { zh: '朗读没有完成：{e}', en: 'Read aloud did not finish: {e}' },
})

/** 划选后自动(2026-11-21 契约 §4):停下这么久才跑;这个长度范围内才自动(更长的只出条,要手点)。 */
const AUTO_DELAY_MS = 400
const AUTO_MAX_CHARS = 2000
/** 自动跑过的结果:同一个动作、同一段、同一个目标语言,本次会话内不再请求(按出现先后最多留这么多)。 */
const autoCache = new Map<string, string>()
const AUTO_CACHE_MAX = 100
const autoCacheKey = (action: string, language: string | undefined, markdown: string): string => `${action}\u0000${language ?? ''}\u0000${markdown}`
/** 手机没有「停下来」这个时机(选区靠系统菜单),第一轮不自动(契约 §4)。 */
const autoAllowedHere = (): boolean => {
  if (typeof window === 'undefined' || window.tangu?.mobile) return false
  try { return !window.matchMedia?.('(pointer: coarse)').matches } catch { return true }
}


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
  /** 自动跟到新那段时 +1:同一张卡重跑,不卸载(不闪)。 */
  runKey: number
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
  /** 宿主划选后自动开的(契约 §4):条留着,点视图里(要换一段划选)不收,松手没选中东西才收。 */
  auto?: boolean
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
  // 划选后自动:松手停 400ms 再跑(只认看着的元素里的鼠标划选:键盘扩选、程序改选区都不经过这里)
  const autoTimer = useRef<number | null>(null)
  const autoRef = useRef<(sel: BarSelection) => void>(() => {})
  const cardRef = useRef<Card | null>(null)
  const ownRef = useRef<BarSelection | null>(null)
  const [ttsCard, setTtsCard] = useState<{ x: number; y: number; top: number; range?: Range; getRect?: BarSelection['getRect'] } | null>(null)
  useEffect(() => () => { if (autoTimer.current != null) window.clearTimeout(autoTimer.current) }, [])

  useEffect(() => {
    const el = watch?.current
    if (!el) return
    const paint = mountLineSelection(el)
    // 按在条上的那一下(按钮按下即执行,条随即收起):它的松手可能落回这个元素,那不是一次新的选择,不能把条再弹出来。
    let fromBar = false
    const cancelAuto = (): void => { if (autoTimer.current != null) { window.clearTimeout(autoTimer.current); autoTimer.current = null } }
    // 自动开的卡:点一下视图(没划出东西)就收 —— 按下那一下为了不闪没收它(见卡的 keepOnDown)
    const dropAutoCard = (): void => { if (cardRef.current?.auto) setCard(null) }
    const read = (e: MouseEvent): void => {
      if (fromBar) return
      cancelAuto()
      const s = window.getSelection()
      if (!s || s.isCollapsed || !s.rangeCount) { setOwn(null); dropAutoCard(); return }
      const content = selectionMarkdown(s, el)
      const text = content?.text ?? ''
      const range = s.getRangeAt(0)
      const at = range.commonAncestorContainer
      const host = at.nodeType === Node.ELEMENT_NODE ? (at as Element) : at.parentElement
      // 输入框 / 可编辑区里的选区不归这一条管(那里有自己的工具栏或什么都不该出)。
      if (!text || !el.contains(at) || host?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) { setOwn(null); dropAutoCard(); return }
      const r = range.getBoundingClientRect()
      const back = s.anchorNode === s.focusNode ? s.focusOffset < s.anchorOffset
        : !!(s.anchorNode && s.focusNode && s.anchorNode.compareDocumentPosition(s.focusNode) & Node.DOCUMENT_POSITION_PRECEDING)
      const dir = e.detail > 1 ? undefined : back ? 'backward' : 'forward'
      const next: BarSelection = { text, markdown: content?.markdown, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, dir, range: range.cloneRange() }
      ownRef.current = next
      setOwn(next)
      // 停下 400ms 还是这一段,才自动跑(中途又按下 / 又划了一段都会把它取消)
      autoTimer.current = window.setTimeout(() => { autoTimer.current = null; if (ownRef.current === next) autoRef.current(next) }, AUTO_DELAY_MS)
    }
    const onSelection = (): void => { if (window.getSelection()?.isCollapsed) { ownRef.current = null; setOwn(null) } }
    // 调用方自己报的选区(插件的 show())也跟着收:它是按当时的位置报的,滚了 / 盒子变了就不在那儿了。
    const clear = (): void => { setOwn(null); onDismissRef.current?.() }
    // 滚动 / 盒子变了 / 画布挪视口:能跟的条不收(锚点跟着走,看不见就藏),只有快照的才收
    const moved = (): void => { if (!followRef.current) clear() }
    // 条挂在 body 下,不会跟着这个视图一起被藏起来 / 挪走:点到视图和条的外面、视图的盒子变了(切标签页、拖分栏、缩窗口)都收。
    const onDown = (e: MouseEvent): void => {
      const at = e.target as Element | null
      fromBar = !!at?.closest?.('.selbar')
      cancelAuto()
      // 结果卡 / 朗读提示卡和条是一起的(自动开的卡和条同时在):点在卡里不算点到外面
      if (at && !el.contains(at) && !fromBar && !at.closest?.('.am-ai-panel')) clear()
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
  cardRef.current = card
  const dismiss = (): void => { ownRef.current = null; setOwn(null); p.onDismiss?.() }
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
  const ttsAnchor = useMemo(() => anchorOf(ownerEl, ttsCard, () => setTtsCard(null)), [ownerEl, ttsCard])
  useEffect(() => () => ttsAnchor?.dispose(), [ttsAnchor])
  const installed = usePluginStore((s) => s.plugins)
  // 此刻在念的那段;设置改了(钉 / 收进 ⋯ / 卡头开关 / 别的窗)也借它重画 —— 条和卡每次都现读偏好
  const speaking = useSelectionBarLive()
  const tts = readTangu()?.tts
  /** 念一段(条上的「朗读」、卡里的小喇叭):同一个 key 正在念 = 停;没配模型 → 选区下出「去设置」小卡(不回落系统声音)。 */
  const speakText = (key: string, text: string, at: { rect: BarSelection['rect']; range?: Range; getRect?: BarSelection['getRect'] }): void => {
    if (!tts) return
    if (speaking?.key === key) { tts.stop(key); return }
    tts.speak(key, text).catch((e: unknown) => {
      const m = String((e as Error)?.message || e)
      if (m === 'tts_no_model') setTtsCard({ x: at.rect.left, y: at.rect.bottom + 6, top: at.rect.top - 6, range: at.range, getRect: at.getRect })
      else if (m !== 'EMPTY') useApp.getState().toast(translate('selbar.speakFailed', { e: m }), true)
    })
  }
  /** 收起并清掉选区(动作把这段文字拿走了)。 */
  const done = (): void => { dismiss(); window.getSelection()?.removeAllRanges() }

  let bar: ReactElement | null = null
  autoRef.current = () => {}
  if (sel) {
    const probe = readTangu()
    const source = p.source?.(sel)
    /** 开结果卡。auto = 划选后自动开的:条留着;已经开着一张自动卡就在原地跟到新那段(同一个 DOM,重跑,不闪)。 */
    const openCard = (title: string, extra: Pick<Card, 'language' | 'action' | 'auto'>): void => {
      const at = { text: sel.text, markdown: sel.markdown ?? sel.text, source, x: sel.rect.left, y: sel.rect.bottom + 6, top: sel.rect.top - 6, range: sel.range, getRect: sel.getRect }
      const prev = cardRef.current
      if (extra.auto && prev?.auto && prev.action === extra.action) {
        setCard({ ...prev, ...at, ...extra, title, runKey: prev.runKey + 1 })
        return
      }
      setCard({ key: Date.now(), runKey: 0, title, ...at, ...extra })
      if (!extra.auto) dismiss() // 选区留着:卡在它下面,看得出译的是哪一段
    }
    const pluginCardExtra = (o: OwnedSelectionAction, auto: boolean): Pick<Card, 'language' | 'action' | 'auto'> => {
      const key = selectionActionKey(o)
      const lang = cardOptionsOf(o).language ? (selectionActionPrefs().language[key] ?? translateTargetOf(sel.text)) : undefined
      return { action: key, ...(lang ? { language: lang } : {}), ...(auto ? { auto: true } : {}) }
    }
    const runPlugin = (o: OwnedSelectionAction): void => {
      if (o.item.output !== 'none') { openCard(selectionActionTitle(o), pluginCardExtra(o, false)); return }
      const cx = { text: sel.text, markdown: sel.markdown ?? sel.text, view: p.view, editable: false, source }
      dismiss()
      void runSelectionAction(o, cx).catch((e: unknown) => useApp.getState().toast(translate('selbar.failed', { title: selectionActionTitle(o), e: String((e as Error)?.message || e) }), true))
    }
    const ask = p.ask
    const lead: SelectionBarAction[] = p.lead
      ? p.lead(sel, done)
      : ask === false || (!ask && !probe?.askInChat)
        ? []
        : [{ id: 'ask', label: t('selbar.ask'), title: t('selbar.askTitle'), icon: <MessageCircle size={14} />, lead: true, testId: 'selection-ask', onRun: () => { done(); if (ask) ask(sel); else probe?.askInChat?.(quoteOf(sel, source)) } }]
    const selKey = speakKeyOf(sel.text)
    const model = buildSelectionBarModel({
      view: p.view, editable: false, length: sel.text.length, registered: plugins, installed,
      host: {
        ask: lead,
        translate: probe?.complete ? () => openCard(t('inlineai.action.translate'), { language: translateTargetOf(sel.text) }) : undefined,
        // 朗读不收条:三态(静止 → 合成中 → 播放中)就画在这一枚上,点它停
        speak: tts ? { phase: (speaking?.key === selKey ? speaking.phase : null) as SpeakPhase, onRun: () => speakText(selKey, sel.text, sel) } : undefined,
      },
      onPlugin: runPlugin,
    })
    // 划选后自动(契约 §4):1–2000 字、桌面、有支持且用户开了的那个(排最前);同一段同一语言已经在卡里了就不再跑
    autoRef.current = (s2) => {
      const a = model.auto
      if (!a || s2 !== sel || !autoAllowedHere() || sel.text.length < 1 || sel.text.length > AUTO_MAX_CHARS) return
      const extra = pluginCardExtra(a, true)
      const cur = cardRef.current
      if (cur && cur.action === extra.action && cur.text === sel.text && cur.language === extra.language) return
      openCard(selectionActionTitle(a), extra)
    }
    const tools = p.tools?.(sel) ?? []
    const { actions, more } = model
    if (actions.length || model.plugins.length || more.length || model.moreHost.length || tools.length) {
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
          <SelectionBar tools={tools} actions={actions} plugins={model.plugins} more={more} moreHost={model.moreHost} moreNotice={model.notice}
            moreHeading={t('selbar.plugins')} moreLabel={t('selbar.more')} order={selectionBarOrder()} onClose={dismiss} />
        </OverlayAt>
      )
    }
  }

  // 自动卡这一次(runKey)的第一跑才看缓存;用户点「重试」就是要重新请求
  const cacheArmed = useRef<number | null>(null)
  const armedFor = card?.auto ? `${card.key}:${card.runKey}` : null
  const lastArmed = useRef<string | null>(null)
  if (armedFor !== lastArmed.current) { lastArmed.current = armedFor; cacheArmed.current = armedFor ? card!.runKey : null }
  const runCard: InlineAiRun = async (_instruction, onDelta, signal) => {
    if (!card) return { text: '' }
    if (card.action) {
      const o = usePluginStore.getState().selectionActions.find((x) => selectionActionKey(x) === card.action)
      if (!o) throw new Error(translate('selbar.err.gone'))
      const ck = autoCacheKey(card.action, card.language, card.markdown)
      const useCache = card.auto && cacheArmed.current === card.runKey
      cacheArmed.current = null
      const hit = useCache ? autoCache.get(ck) : undefined
      if (hit != null) return { text: hit }
      const text = await runSelectionAction(o, {
        text: card.text, markdown: card.markdown, view: p.view, editable: false, source: card.source, signal,
        onDelta: (d) => { if (typeof d === 'string') onDelta(d) },
        ...(card.language ? { language: card.language } : {}), ...(card.auto ? { auto: true } : {}),
      })
      if (card.auto && text && !signal.aborted) {
        autoCache.delete(ck)
        autoCache.set(ck, text)
        if (autoCache.size > AUTO_CACHE_MAX) autoCache.delete(autoCache.keys().next().value!)
      }
      return { text }
    }
    const complete = readTangu()?.complete
    if (!complete) throw new Error(translate('inlineai.unavailable'))
    return complete({ action: 'translate', selection: card.markdown, language: card.language }, { signal, onDelta })
  }

  const cardOwned = card?.action ? plugins.find((x) => selectionActionKey(x) === card.action) : undefined
  const opts = cardOptionsOf(cardOwned)
  const cardSpeak = card && cardOwned && opts.speak && tts
    ? {
        phase: (which: 'source' | 'result'): SpeakPhase => (speaking?.key === `card:${card.key}:${which}` ? speaking.phase : null),
        onToggle: (which: 'source' | 'result', text: string) => speakText(`card:${card.key}:${which}`, text, { rect: { left: card.x, right: card.x, top: card.top + 6, bottom: card.y - 6 }, range: card.range, getRect: card.getRect }),
      }
    : undefined
  if (!bar && !card && !ttsCard) return null
  return createPortal(
    <>
      {bar}
      {card && (
        <InlineAiPanel
          key={card.key}
          runKey={card.runKey}
          x={card.x}
          y={card.y}
          anchorTop={card.top}
          anchor={cardAnchor}
          title={cardOwned ? selectionActionTitle(cardOwned) : card.title}
          icon={cardOwned ? pluginIcon(cardOwned.item.icon) ?? undefined : undefined}
          hasSelection
          askFirst={false}
          run={runCard}
          onClose={() => setCard(null)}
          // 自动卡:按在视图里(多半要换一段划选)先不收,松手时没划出东西再收(read 里)—— 收了再开会闪一下
          keepOnDown={card.auto ? (at) => !!watch?.current?.contains(at) : undefined}
          language={card.language ? {
            value: card.language,
            onChange: (id) => { if (card.action && opts.language) rememberSelectionLanguage(card.action, id); setCard({ ...card, key: Date.now(), runKey: 0, language: id }) },
          } : undefined}
          source={cardOwned && opts.source ? card.text : undefined}
          speak={cardSpeak}
          auto={cardOwned && opts.auto ? { on: selectionActionPrefs().auto[card.action!] === true, onChange: (on) => setSelectionAuto(card.action!, on) } : undefined}
        />
      )}
      {ttsCard && (
        <TtsSetupCard x={ttsCard.x} y={ttsCard.y} anchorTop={ttsCard.top} anchor={ttsAnchor} onOpenSettings={() => tts?.openSettings()} onClose={() => setTtsCard(null)} />
      )}
    </>,
    document.body,
  )
}
