import { groupPickerModels, useModelPickerPreferences } from '../modelPickerPreferences'
import { ModelMetadata } from './ModelMetadata'
/**
 * Chat View 模型 / Effort 控制器。
 *
 * 展开层固定为三段：①「高级」折叠区；②主模型选择器；③ ChatGPT 式可拖拽 Effort 条。
 * 高级与模型之间按需多一行「上下文上限」：模型本身窗口超过引擎缺省上限(272k)时才露，选的是本机该模型的窗口覆盖。
 * 高级区复用 config.json 的默认辅助 / 生图 / 识图模型槽；Effort 与模型一样由 store 记住，
 * 在后续会话继续继承。外部 ACP 引擎没有 Tangu 推理档与辅助模型时，保留单独的模型选择行。
 */
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronRight, Bot, Search } from 'lucide-react'
import { nestedPanelPlacement, nestedPanelTop, UI_ZOOM_EVENT, zoomOf, useEdgeNudge, OverlayAt } from '@lcl/engine'
import type { NestedPanelPlacement } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'
import { THINKING_LEVELS } from '../types'
import { thinkingLabel } from './thinkingLabel'
import type { AgentConfig, DefaultModelSlot, ModelInfo, ModelsResponse } from '../types'

registerMessages({
  'pill.rowAdvanced': { zh: '高级', en: 'Advanced' },
  'pill.rowModel': { zh: '模型', en: 'Model' },
  // 字段名统一「思考档位 / Thinking effort」(U-28a:此前有思考强度 / 推理强度 / Effort 多种叫法)。
  'pill.rowEffort': { zh: '思考档位', en: 'Thinking effort' },
  'pill.reasoningStrength': { zh: '思考档位', en: 'Thinking effort' },
  'pill.defaultAuxModel': { zh: '默认辅助模型', en: 'Default auxiliary model' },
  'pill.defaultImageModel': { zh: '生图模型', en: 'Image generation model' },
  'pill.defaultVisionModel': { zh: '识图辅助模型', en: 'Vision auxiliary model' },
  'pill.followCloudDefault': { zh: '跟随云端默认', en: 'Follow cloud default' },
  'pill.noModels': { zh: '暂无可用模型', en: 'No available models' },
  'pill.faster': { zh: '更快', en: 'Faster' },
  'pill.smarter': { zh: '更智能', en: 'Smarter' },
  'pill.rowContext': { zh: '上下文上限', en: 'Context limit' },
  'pill.ctxDefault': { zh: '默认 · {n}', en: 'Default · {n}' },
  'pill.ctxMax': { zh: '最大 · {n}', en: 'Maximum · {n}' },
  'pill.ctxHint': { zh: '对本机这个模型的所有会话生效。超过 {n} 后每轮都要重发更多上下文，额度消耗随之上升。', en: 'Applies to every conversation with this model on this device. Past {n}, each turn resends more context, so usage rises with it.' },
  // Ultra 是对标 Codex 的模式专名(同 Chat / Work),中文界面也写 Ultra(i18nCoverage F 已逐键登记)。
  'pill.ultra': { zh: 'Ultra', en: 'Ultra' },
  'pill.ultraNote': { zh: '思考拉满，主动并行派子代理', en: 'Max thinking + parallel subagents' },
  'pill.ultraTitle': { zh: 'Ultra：思考拉满 + 主动并行派子代理（额度消耗会成倍增加）', en: 'Ultra: max thinking plus proactive parallel subagents (uses several times the quota)' },
})

export interface ModelPillOption extends Pick<ModelInfo, 'id' | 'name' | 'tags' | 'multiplier'> { description?: string; source?: ModelInfo['source'] }
export interface ModelPillGroup { key?: string; label: string; source?: ModelInfo['source']; options: ModelPillOption[] }
type Thinking = NonNullable<AgentConfig['thinkingLevel']>
type Pane = 'model' | 'context' | DefaultModelSlot

const thinkingLabelKey = (lv: Thinking): string => `input.thinking.${lv}`
// 档位显示名走 thinkingLabel 单源(U-28a);原先这里 'max' 写死英文 'Max',中文界面也露英文。
const effortDisplay = (lv: Thinking, t: (key: string) => string): string => thinkingLabel(lv, t)
/** 与输入框进度环同一写法(272k / 1M);环在 Composer2 里,这边反向 import 会成环。 */
const fmtWindow = (n: number): string => n >= 1e6 ? `${Math.floor(n / 1e5) / 10}M` : `${Math.floor(n / 100) / 10}k`

/** 「上下文上限」行:模型本身窗口 > 缺省上限才有得开;已手动覆盖过的也露(好改回默认)。老引擎不下发 max/cap → null。 */
export function contextLimitOptions(model: ModelInfo | undefined, cap: number | undefined): { current: number; defaultTokens: number; maxTokens?: number; selected: 'default' | 'max' | null } | null {
  const max = model?.maxContextWindow
  if (!model?.contextWindow || !max || !cap) return null
  const overridden = model.contextWindowSource === 'override'
  if (max <= cap && !overridden) return null
  return {
    current: model.contextWindow,
    defaultTokens: Math.min(max, cap),
    ...(max > cap ? { maxTokens: max } : {}),
    // 设置页手填的其它值(如 500000)两档都不打勾,行上照实显示当前值
    selected: !overridden ? 'default' : max > cap && model.contextWindow === max ? 'max' : null,
  }
}

/** 原生 range 的 index ↔ 七档映射集中在这里，避免视图和键盘路径各算一套。 */
export function effortAt(index: number): Thinking {
  return THINKING_LEVELS[Math.max(0, Math.min(THINKING_LEVELS.length - 1, Math.round(index)))]
}

/** 带 Ultra 的滑杆:七档之后多一格。Ultra = { max, ultra:true };其余格 = 该档 + ultra:false(显式关)。
 *  不把 'ultra' 塞进 THINKING_LEVELS —— 那张表还喂 Agent 档案 / 团队 / 项目设置等七八处下拉,它们都没有 Ultra。 */
export function effortStopAt(index: number, allowUltra: boolean): { level: Thinking; ultra?: boolean } {
  const i = Math.round(index)
  if (allowUltra && i >= THINKING_LEVELS.length) return { level: 'max', ultra: true }
  return { level: effortAt(i), ...(allowUltra ? { ultra: false } : {}) }
}

/** 高级区各模型槽的候选过滤规则（与设置页一致）。 */
export function catalogForDefaultSlot(models: ModelInfo[], slot: DefaultModelSlot): ModelInfo[] {
  if (slot === 'imageModelId') return models.filter((m) => m.modelType === 'image_gen')
  const llms = models.filter((m) => (m.modelType || 'llm') === 'llm')
  return slot === 'visionModelId' ? llms.filter((m) => m.supportsVision !== false) : llms
}

/** 仅当文本溢出才在 hover 时跑马灯。 */
const MarqueeLabel: React.FC<{ text: string }> = ({ text }) => {
  const ref = useRef<HTMLSpanElement>(null)
  const [over, setOver] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (el) setOver(el.scrollWidth > el.clientWidth + 2)
  }, [text])
  return (
    <span ref={ref} className={`pill-marquee${over ? ' is-over' : ''}`}>
      <span className="pill-marquee__inner">{text}</span>
    </span>
  )
}

/** Prompt hosts can sit anywhere in a scrolling View; their menus escape its clipping context. */
function ModelMenuSurface({ portal, anchorRef, innerRef, style, children }: {
  portal: boolean
  anchorRef: React.RefObject<HTMLSpanElement | null>
  innerRef(el: HTMLDivElement | null): void
  style: React.CSSProperties
  children: React.ReactNode
}) {
  const [anchor, setAnchor] = useState({ x: 0, y: 0, top: 0 })
  useLayoutEffect(() => {
    if (!portal) return
    const update = () => {
      const el = anchorRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const next = { x: r.left, y: r.bottom + 8, top: r.top - 8 }
      setAnchor(prev => prev.x === next.x && prev.y === next.y && prev.top === next.top ? prev : next)
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener(UI_ZOOM_EVENT, update)
    document.addEventListener('scroll', update, true)
    const ro = new ResizeObserver(update)
    if (anchorRef.current) ro.observe(anchorRef.current)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener(UI_ZOOM_EVENT, update)
      document.removeEventListener('scroll', update, true)
      ro.disconnect()
    }
  }, [portal, anchorRef])
  if (!portal) return <div ref={innerRef} className="composer-menu composer-menu--model" style={style}>{children}</div>
  return createPortal(<div className="ui-popover-backdrop" style={{ pointerEvents: 'none' }} data-cmenu>
    <OverlayAt x={anchor.x} y={anchor.y} anchorTop={anchor.top} prefer="above" innerRef={innerRef}
      className="composer-menu composer-menu--model composer-menu--portal">{children}</OverlayAt>
  </div>, document.body)
}

export const ModelPill: React.FC<{
  className?: string
  /** Escape a prompt host's scrolling/clipping context and flip vertically when needed. */
  menuPortal?: boolean
  /** Composer2 传入时由三颗胶囊共用一个排他开关；harness / 独立用法仍可不受控。 */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
  modelId?: string
  groups: ModelPillGroup[]
  onSelect: (id: string) => void
  thinkingLevel?: Thinking
  /** 第二参只在 allowUltra 时给:true = 停在 Ultra 格,false = 其余格(显式关 Ultra)。 */
  onThinkingChange?: (lv: Thinking, ultra?: boolean) => void
  /** 滑杆在 max 之后多一格 Ultra(本机 work 会话才给:delegate 只在本机引擎有)。 */
  allowUltra?: boolean
  /** 会话的 Ultra 开关;allowUltra 时它压过 thinkingLevel 决定显示(引擎那边 ultra 也压过存值的档)。 */
  ultra?: boolean
  /** 当前模型支持的思考档；不支持的档仍可选，由引擎自动降档。 */
  supportedThinking?: string[]
  /** 本 run 实际生效档；与请求档不同则在推理强度摘要中显示降档。 */
  effectiveThinking?: string
  /** 高级区需要全量目录（主模型列表可能已按云端会话过滤，不能拿它代替）。 */
  modelsResponse?: ModelsResponse | null
  defaultModelIds?: Partial<Record<DefaultModelSlot, string>>
  onDefaultModelChange?: (slot: DefaultModelSlot, modelId: string) => void
  /** 写本机该模型的窗口覆盖(null = 交还默认)。不传、或引擎报 modelOverridesWritable 不为 true,就不露「上下文上限」行。 */
  onContextWindowChange?: (modelId: string, tokens: number | null) => void
  /** 无可选模型时的只读标签（外部引擎：用引擎默认）。 */
  emptyLabel?: string
  footnote?: string
  title?: string
}> = ({
  className, menuPortal = false, open: controlledOpen, onOpenChange,
  disabled, modelId, groups, onSelect, thinkingLevel, onThinkingChange, allowUltra = false, ultra, supportedThinking, effectiveThinking,
  modelsResponse, defaultModelIds, onDefaultModelChange, onContextWindowChange, emptyLabel, footnote, title,
}) => {
  const { t } = useI18n()
  const pickerPrefs = useModelPickerPreferences()
  const [query, setQuery] = useState('')
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const setPillOpen = (next: boolean): void => {
    if (!next && menuRef.current?.contains(document.activeElement)) wrapRef.current?.querySelector('button')?.focus({ preventScroll: true })
    if (controlledOpen === undefined) setInternalOpen(next)
    onOpenChange?.(next)
  }
  const [advanced, setAdvanced] = useState(false)
  const [pane, setPane] = useState<Pane | null>(null)
  const [placement, setPlacement] = useState<NestedPanelPlacement>('right')
  const [subTop, setSubTop] = useState(0)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const menuFix = useEdgeNudge(open && !menuPortal, { boundary: '.t2-chat-view' })
  const subFix = useEdgeNudge(pane ? `${pane}:${placement}` : '', { boundary: '.t2-chat-view' })

  useEffect(() => {
    if (!open) { setPane(null); setAdvanced(false); setQuery(''); return }
    // data-keep-menus:从本菜单弹出的确认框(开 Ultra)—— 点它、在它里面按 Esc 都不算离开菜单
    const keep = (t: EventTarget | null): boolean => !!(t as HTMLElement | null)?.closest?.('[data-keep-menus]')
    const onDown = (e: MouseEvent) => { if (!keep(e.target) && !wrapRef.current?.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node)) setPillOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !keep(e.target)) setPillOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const menu = menuRef.current
    const sub = subRef.current
    if (!pane || !menu || !sub) return
    const update = (): void => {
      const menuRect = menu.getBoundingClientRect()
      const boundaryRect = (menu.closest('.t2c-card') || menu.closest('.t2-chat-view'))?.getBoundingClientRect()
      const viewRect = menu.closest('.t2-chat-view')?.getBoundingClientRect()
      const triggerRect = menu.querySelector<HTMLElement>(`[data-pane-trigger="${pane}"]`)?.getBoundingClientRect()
      const zoom = zoomOf(sub)
      const next = nestedPanelPlacement(menuRect.left, menuRect.right, sub.offsetWidth, boundaryRect?.left ?? 0, boundaryRect?.right ?? window.innerWidth, zoom)
      setPlacement((prev) => prev === next ? prev : next)
      if (triggerRect) {
        const nextTop = nestedPanelTop(
          triggerRect.top,
          sub.offsetHeight,
          menuRect.top,
          menuRect.bottom,
          viewRect?.top ?? 0,
          viewRect?.bottom ?? window.innerHeight,
          zoom,
        )
        setSubTop((prev) => Math.abs(prev - nextTop) < 0.5 ? prev : nextTop)
      }
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener(UI_ZOOM_EVENT, update)
    const ro = new ResizeObserver(update)
    ro.observe(menu)
    ro.observe(sub)
    const boundary = menu.closest('.t2c-card') || menu.closest('.t2-chat-view')
    if (boundary) ro.observe(boundary)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener(UI_ZOOM_EVENT, update)
      ro.disconnect()
    }
  }, [pane])

  const all = groups.flatMap((g) => g.options)
  const hasModels = all.length > 0
  const current = all.find((m) => m.id === modelId) || modelsResponse?.models.find((m) => m.id === modelId)
  const readonly = !onThinkingChange && !hasModels && !!emptyLabel
  const label = current?.name || emptyLabel || t('input.selectModel')
  const isUltra = allowUltra && !!ultra
  // Ultra 开着时请求档恒 max(引擎同口径),存值是什么都不看。
  const effLevel: Thinking = isUltra ? 'max' : thinkingLevel || 'medium'
  const effortText = isUltra ? t('pill.ultra') : effortDisplay(effLevel, t)
  const effort = effLevel !== 'off' ? ` · ${effortText}` : ''
  const lastStop = THINKING_LEVELS.length - (allowUltra ? 0 : 1)
  const effortIndex = isUltra ? lastStop : Math.max(0, THINKING_LEVELS.indexOf(effLevel))
  const effortPct = `${(effortIndex / lastStop) * 100}%`
  const effortThumbLeft = `calc(${effortPct} + ${(0.5 - effortIndex / lastStop) * 25}px)`
  const effectiveText = effectiveThinking && effectiveThinking !== effLevel
    ? ` → ${effortDisplay(effectiveThinking as Thinking, t)}`
    : ''
  const isMax = effLevel === 'max'
  const effortCls = `${isMax ? ' is-max' : ''}${isUltra ? ' is-ultra' : ''}`
  // 冲击波只在菜单开着时「刚切进 Ultra」放一次(动画结束即卸载);重开菜单、启动时本来就是 Ultra 都不放。
  const [burst, setBurst] = useState(0)
  const prevUltra = useRef(isUltra)
  useEffect(() => {
    if (isUltra && !prevUltra.current && open) setBurst((n) => n + 1)
    prevUltra.current = isUltra
  }, [isUltra, open])
  // 动画没放完就关了菜单:元素卸载、onAnimationEnd 不会来,不清的话重开菜单会重播(creview 09-27)
  useEffect(() => { if (!open) setBurst(0) }, [open])
  const ultraNoteId = useId()
  // 能不能写由引擎说了算(桌面连外部 / 云端 worker 那边 PUT 404):别按宿主猜
  const ctx = onContextWindowChange && modelId && modelsResponse?.modelOverridesWritable
    ? contextLimitOptions(modelsResponse.models.find((m) => m.id === modelId), modelsResponse.contextWindowCap)
    : null
  const pickContext = (tokens: number | null): void => {
    setPane(null)
    if (modelId) onContextWindowChange?.(modelId, tokens)
  }

  const groupCatalog = (models: ModelInfo[]): ModelPillGroup[] => groupPickerModels(models, pickerPrefs).map((g) => ({
    key: g.key, source: g.source, label: g.provider, options: g.models.map((m) => ({ ...m, description: `${m.provider} · ${m.id}` })),
  }))

  const slotModels = (slot: DefaultModelSlot): ModelInfo[] => catalogForDefaultSlot(modelsResponse?.models || [], slot)
  const cloudDefaultFor = (slot: DefaultModelSlot): string | null | undefined => modelsResponse?.[slot]
  const modelName = (id?: string | null): string => {
    if (!id) return ''
    return modelsResponse?.models.find((m) => m.id === id)?.name || id
  }
  const slotLabel = (slot: DefaultModelSlot): string => {
    const selected = defaultModelIds?.[slot]
    if (selected) return modelName(selected)
    const cloud = cloudDefaultFor(slot)
    return cloud ? `${t('pill.followCloudDefault')} · ${modelName(cloud)}` : t('pill.followCloudDefault')
  }
  const slotRows: Array<{ slot: DefaultModelSlot; label: string }> = [
    { slot: 'backgroundModelId', label: t('pill.defaultAuxModel') },
    { slot: 'imageModelId', label: t('pill.defaultImageModel') },
    { slot: 'visionModelId', label: t('pill.defaultVisionModel') },
  ]

  const slot: DefaultModelSlot | null = pane && pane !== 'model' && pane !== 'context' ? pane : null
  const rawPaneGroups = pane === 'model' ? groups : slot ? groupCatalog(slotModels(slot)) : []
  const q = query.trim().toLowerCase()
  const paneGroups = rawPaneGroups.map((g) => ({ ...g, options: g.options.filter((m) => `${g.label} ${m.name} ${m.id} ${m.tags?.map((tag) => tag.text).join(' ') || ''}`.toLowerCase().includes(q)) })).filter((g) => g.options.length)
  const paneValue = pane === 'model' ? modelId : slot ? (defaultModelIds?.[slot] || '') : ''
  const selectDefault = (slot: DefaultModelSlot, id: string): void => {
    onDefaultModelChange?.(slot, id)
    setPane(null)
  }
  const showPane = (p: Pane) => (): void => { if (pane !== p) setQuery(''); setPane(p) }

  if (readonly) {
    return (
      <span className={`composer-chip composer-chip--readonly${className ? ` ${className}` : ''}`} title={title}>
        <Bot size={13} />
        <MarqueeLabel text={label} />
      </span>
    )
  }

  return (
    <span ref={wrapRef} className={`model-pill-wrap${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`} data-cmenu>
      <button type="button"
        className={`composer-chip model-pill-btn${open ? ' is-open' : ''}${effortCls}`}
        title={title || t('input.modelChipTitle')}
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setPillOpen(!open)}
      >
        <Bot size={13} />
        <MarqueeLabel text={label + effort} />
        <ChevronDown size={10} />
      </button>
      {open && (
        <ModelMenuSurface
          portal={menuPortal}
          anchorRef={wrapRef}
          innerRef={(el) => { menuRef.current = el; menuFix.ref.current = el }}
          style={menuFix.style}
        >
          {onThinkingChange && (
            <>
              {/* 高级内容放在触发行上方；菜单底边固定，所以展开时卡片向上生长、后三行不位移。 */}
              <div className={`cm-advanced-reveal${advanced ? ' is-open' : ''}`} aria-hidden={!advanced}>
                <div className="cm-advanced-reveal-inner">
                  <div className="cm-advanced-list">
                    <div className="cm-row cm-row--static">
                      <span className="cm-row-k">{t('pill.reasoningStrength')}</span>
                      <span className={`cm-row-v${effortCls}`}>{effortText}{effectiveText}</span>
                    </div>
                    {onDefaultModelChange && slotRows.map(({ slot, label: rowLabel }) => (
                      <button type="button"
                        key={slot}
                        className={`cm-row${pane === slot ? ' is-open' : ''}`}
                        data-pane-trigger={slot}
                        tabIndex={advanced ? 0 : -1}
                        onFocus={showPane(slot)}
                        onClick={showPane(slot)}
                      >
                        <span className="cm-row-k">{rowLabel}</span>
                        <span className="cm-row-v">{slotLabel(slot)}</span>
                        <ChevronRight size={13} />
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              {/* 第一行：高级；它本身仍留在模型和 Effort 上方。 */}
              <button type="button"
                className={`cm-row cm-advanced-toggle${advanced ? ' is-open' : ''}`}
                aria-expanded={advanced}
                onClick={() => { setAdvanced((v) => !v); setPane(null) }}
              >
                <span className="cm-row-k">{t('pill.rowAdvanced')}</span>
                <span className="cm-row-v" />
                <ChevronRight size={13} />
              </button>
            </>
          )}

          {/* 高级与模型之间：上下文上限(只对窗口超过缺省上限的模型露出)。 */}
          {ctx && (
            <button type="button"
              className={`cm-row${pane === 'context' ? ' is-open' : ''}`}
              data-pane-trigger="context"
              onMouseEnter={showPane('context')}
              onFocus={showPane('context')}
              onClick={showPane('context')}
            >
              <span className="cm-row-k">{t('pill.rowContext')}</span>
              <span className="cm-row-v">{fmtWindow(ctx.current)}</span>
              <ChevronRight size={13} />
            </button>
          )}

          {/* 第二行：保留原有按 provider 分组的模型选择器。 */}
          <button type="button"
            className={`cm-row cm-model-row${pane === 'model' ? ' is-open' : ''}`}
            data-pane-trigger="model"
            onMouseEnter={showPane('model')}
            onFocus={showPane('model')}
            onClick={showPane('model')}
          >
            <span className="cm-row-k">{t('pill.rowModel')}</span>
            <span className="cm-row-v">{label}</span>
            <ChevronRight size={13} />
          </button>

          {/* 第三行：ChatGPT 式离散拖动条。Max 单独切换蓝紫渐变 + 星点层；Ultra 把星点换成并行光流(几路子代理同时在跑)。 */}
          {onThinkingChange && (
            <div className={`cm-effort${effortCls}`} data-effort={isUltra ? 'ultra' : effLevel}>
              <div className="cm-effort-head">
                <span>{t('pill.rowEffort')}</span>
                <span key={isUltra ? 'ultra' : effLevel} className="cm-effort-value">{effortText}{effectiveText}</span>
              </div>
              <div className="cm-effort-ends"><span>{t('pill.faster')}</span><span>{t('pill.smarter')}</span></div>
              <div className="cm-effort-slider-wrap">
                <span className="cm-effort-track" aria-hidden="true">
                  <span className="cm-effort-range" style={{ width: effortPct }} />
                  {isMax && !isUltra && (
                    <span className="cm-effort-sparkles">
                      {Array.from({ length: 10 }, (_, i) => <i key={i} />)}
                    </span>
                  )}
                  {isUltra && (
                    <span className="cm-effort-streaks">
                      {Array.from({ length: 4 }, (_, i) => <i key={i} />)}
                    </span>
                  )}
                  <span className="cm-effort-ticks">
                    {THINKING_LEVELS.map((lv, i) => (
                      <i
                        key={lv}
                        className={`${i <= effortIndex ? ' is-on' : ''}${supportedThinking && !supportedThinking.includes(lv) ? ' is-unsupported' : ''}`}
                        style={{ left: `${(i / lastStop) * 100}%` }}
                      />
                    ))}
                    {/* Ultra 格不按模型档位表标「不支持」:它上线就是 max,由引擎照常降档。 */}
                    {allowUltra && <i key="ultra" className={`is-ultra-stop${isUltra ? ' is-on' : ''}`} style={{ left: '100%' }} />}
                  </span>
                </span>
                <span className="cm-effort-thumb" style={{ left: effortThumbLeft }} aria-hidden="true">
                  {burst > 0 && isUltra && <i key={burst} className="cm-effort-burst" onAnimationEnd={() => setBurst(0)} />}
                </span>
                <input
                  className="cm-effort-input"
                  type="range"
                  min={0}
                  max={lastStop}
                  step={1}
                  value={effortIndex}
                  aria-label={t('pill.reasoningStrength')}
                  // Ultra 格念完整说明(含额度提示):title 读屏不可靠,可见说明行另经 aria-describedby 关联
                  aria-valuetext={isUltra ? t('pill.ultraTitle') : `${effortText}${supportedThinking && !supportedThinking.includes(effLevel) ? ` ${t('pill.thinkUnsupported')}` : ''}`}
                  aria-describedby={isUltra ? ultraNoteId : undefined}
                  title={isUltra ? t('pill.ultraTitle') : t(thinkingLabelKey(effLevel))}
                  onChange={(e) => {
                    const stop = effortStopAt(Number(e.currentTarget.value), allowUltra)
                    if (allowUltra) onThinkingChange(stop.level, stop.ultra)
                    else onThinkingChange(stop.level)
                  }}
                />
              </div>
              {isUltra && <div id={ultraNoteId} className="cm-effort-note">{t('pill.ultraNote')}</div>}
            </div>
          )}

          {footnote && <div className="menu-section cm-foot">{footnote}</div>}
          {pane && (pane !== 'context' || ctx) && (
            <div
              ref={(el) => { subRef.current = el; subFix.ref.current = el }}
              className={`cm-sub ${placement}`}
              data-pane={pane}
              style={{ ...subFix.style, '--cm-sub-top': `${subTop}px` } as React.CSSProperties}
            >
              {pane === 'context' && ctx ? (
                <>
                  <button type="button" className={`menu-item${ctx.selected === 'default' ? ' active' : ''}`} onClick={() => pickContext(null)}>
                    <span className="grow">{t('pill.ctxDefault', { n: fmtWindow(ctx.defaultTokens) })}</span>
                    <span className="mi-check">{ctx.selected === 'default' ? '✓' : ''}</span>
                  </button>
                  {ctx.maxTokens && (
                    <button type="button" className={`menu-item${ctx.selected === 'max' ? ' active' : ''}`} onClick={() => pickContext(ctx.maxTokens!)}>
                      <span className="grow">{t('pill.ctxMax', { n: fmtWindow(ctx.maxTokens) })}</span>
                      <span className="mi-check">{ctx.selected === 'max' ? '✓' : ''}</span>
                    </button>
                  )}
                  <div className="menu-section cm-foot">{t('pill.ctxHint', { n: fmtWindow(ctx.defaultTokens) })}</div>
                </>
              ) : (
                <>
                  {rawPaneGroups.reduce((n, g) => n + g.options.length, 0) >= 8 && <label className="model-picker-search"><Search size={12} /><input aria-label={t('model.searchPlaceholder')} placeholder={t('model.searchPlaceholder')} value={query} onChange={(e) => setQuery(e.target.value)} /></label>}
                  {slot && (
                    <button type="button"
                      className={`menu-item${paneValue ? '' : ' active'}`}
                      onClick={() => selectDefault(slot, '')}
                    >
                      <span className="grow">{slotLabel(slot)}</span>
                      <span className="mi-check">{paneValue ? '' : '✓'}</span>
                    </button>
                  )}
                  {paneGroups.map((g, index) => (
                    <React.Fragment key={g.key || g.label}>
                      {g.source && paneGroups[index - 1]?.source !== g.source && <div className="menu-source">{t(g.source === 'forsion' ? 'model.group.forsion' : 'model.group.direct')}</div>}
                      {g.label && <div className="menu-section">{g.label}</div>}
                      {g.options.map((m) => (
                        <button type="button"
                          key={m.id}
                          className={`menu-item${m.id === paneValue ? ' active' : ''}`}
                          title={m.description}
                          onClick={() => {
                            if (pane === 'model') { onSelect(m.id); setPillOpen(false) }
                            else if (slot) selectDefault(slot, m.id)
                          }}
                        >
                          <span className="grow">{m.name}</span>
                          {m.source && <ModelMetadata model={{ source: m.source, tags: m.tags, multiplier: m.multiplier }} />}
                          <span className="mi-check">{m.id === paneValue ? '✓' : ''}</span>
                        </button>
                      ))}
                    </React.Fragment>
                  ))}
                  {!paneGroups.length && <div className="menu-section">{t('pill.noModels')}</div>}
                </>
              )}
            </div>
          )}
        </ModelMenuSurface>
      )}
    </span>
  )
}
