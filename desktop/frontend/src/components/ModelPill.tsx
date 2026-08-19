/**
 * Chat View 模型 / Effort 控制器。
 *
 * 展开层固定为三段：①「高级」折叠区；②主模型选择器；③ ChatGPT 式可拖拽 Effort 条。
 * 高级区复用 config.json 的默认辅助 / 生图 / 识图模型槽；Effort 与模型一样由 store 记住，
 * 在后续会话继续继承。外部 ACP 引擎没有 Tangu 推理档与辅助模型时，保留单独的模型选择行。
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Bot } from 'lucide-react'
import { zoomOf, useEdgeNudge } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'
import { THINKING_LEVELS } from '../types'
import type { AgentConfig, DefaultModelSlot, ModelInfo, ModelsResponse } from '../types'

registerMessages({
  'pill.rowAdvanced': { zh: '高级', en: 'Advanced' },
  'pill.rowModel': { zh: '模型', en: 'Model' },
  'pill.rowEffort': { zh: 'Effort', en: 'Effort' },
  'pill.reasoningStrength': { zh: '推理强度', en: 'Reasoning effort' },
  'pill.defaultAuxModel': { zh: '默认辅助模型', en: 'Default auxiliary model' },
  'pill.defaultImageModel': { zh: '生图模型', en: 'Image generation model' },
  'pill.defaultVisionModel': { zh: '识图辅助模型', en: 'Vision auxiliary model' },
  'pill.followCloudDefault': { zh: '跟随云端默认', en: 'Follow cloud default' },
  'pill.noModels': { zh: '暂无可用模型', en: 'No available models' },
  'pill.faster': { zh: '更快', en: 'Faster' },
  'pill.smarter': { zh: '更智能', en: 'Smarter' },
})

export interface ModelPillOption { id: string; name: string; description?: string }
export interface ModelPillGroup { label: string; options: ModelPillOption[] }
type Thinking = NonNullable<AgentConfig['thinkingLevel']>
type Pane = 'model' | DefaultModelSlot

const thinkingLabelKey = (lv: Thinking): string => `input.thinking.${lv}`
const thinkingShortKey = (lv: Thinking): string => `input.thinkingShort.${lv}`
const effortDisplay = (lv: Thinking, t: (key: string) => string): string => lv === 'max' ? 'Max' : t(thinkingShortKey(lv))

/** 原生 range 的 index ↔ 七档映射集中在这里，避免视图和键盘路径各算一套。 */
export function effortAt(index: number): Thinking {
  return THINKING_LEVELS[Math.max(0, Math.min(THINKING_LEVELS.length - 1, Math.round(index)))]
}

/** 高级区各模型槽的候选过滤规则（与设置页一致）。 */
export function catalogForDefaultSlot(models: ModelInfo[], slot: DefaultModelSlot): ModelInfo[] {
  if (slot === 'imageModelId') return models.filter((m) => m.modelType === 'image_gen')
  const llms = models.filter((m) => (m.modelType || 'llm') === 'llm')
  return slot === 'visionModelId' ? llms.filter((m) => m.supportsVision !== false) : llms
}

/**
 * 子面板要不要翻到菜单左侧。
 * ⚠️ anchorRight / vw 是视口 px，subW 是未缩放局部 px；比较前必须乘端级 zoom。
 */
export function subFlips(anchorRight: number, subW: number, zoom: number, vw: number, gap = 6, margin = 8): boolean {
  return anchorRight + (gap + subW) * zoom > vw - margin
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

export const ModelPill: React.FC<{
  className?: string
  /** Composer2 传入时由三颗胶囊共用一个排他开关；harness / 独立用法仍可不受控。 */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
  modelId?: string
  groups: ModelPillGroup[]
  onSelect: (id: string) => void
  thinkingLevel?: Thinking
  onThinkingChange?: (lv: Thinking) => void
  /** 当前模型支持的思考档；不支持的档仍可选，由引擎自动降档。 */
  supportedThinking?: string[]
  /** 本 run 实际生效档；与请求档不同则在推理强度摘要中显示降档。 */
  effectiveThinking?: string
  /** 高级区需要全量目录（主模型列表可能已按云端会话过滤，不能拿它代替）。 */
  modelsResponse?: ModelsResponse | null
  defaultModelIds?: Partial<Record<DefaultModelSlot, string>>
  onDefaultModelChange?: (slot: DefaultModelSlot, modelId: string) => void
  /** 无可选模型时的只读标签（外部引擎：用引擎默认）。 */
  emptyLabel?: string
  footnote?: string
  title?: string
}> = ({
  className, open: controlledOpen, onOpenChange,
  disabled, modelId, groups, onSelect, thinkingLevel, onThinkingChange, supportedThinking, effectiveThinking,
  modelsResponse, defaultModelIds, onDefaultModelChange, emptyLabel, footnote, title,
}) => {
  const { t } = useI18n()
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const setPillOpen = (next: boolean): void => {
    if (controlledOpen === undefined) setInternalOpen(next)
    onOpenChange?.(next)
  }
  const [advanced, setAdvanced] = useState(false)
  const [pane, setPane] = useState<Pane | null>(null)
  const [flip, setFlip] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const menuFix = useEdgeNudge(open)
  const subFix = useEdgeNudge(pane ? `${pane}:${flip}` : '')

  useEffect(() => {
    if (!open) { setPane(null); setAdvanced(false); return }
    const onDown = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setPillOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPillOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = subRef.current
    const wrap = wrapRef.current
    if (!pane || !el || !wrap) return
    setFlip(subFlips(wrap.getBoundingClientRect().right, el.offsetWidth, zoomOf(el), window.innerWidth))
  }, [pane])

  const all = groups.flatMap((g) => g.options)
  const hasModels = all.length > 0
  const current = all.find((m) => m.id === modelId)
  const readonly = !onThinkingChange && !hasModels && !!emptyLabel
  const label = current?.name || emptyLabel || t('input.selectModel')
  const effLevel: Thinking = thinkingLevel || 'medium'
  const effortText = effortDisplay(effLevel, t)
  const effort = effLevel !== 'off' ? ` · ${effortText}` : ''
  const effortIndex = Math.max(0, THINKING_LEVELS.indexOf(effLevel))
  const effortPct = `${(effortIndex / (THINKING_LEVELS.length - 1)) * 100}%`
  const effortThumbLeft = `calc(${effortPct} + ${(0.5 - effortIndex / (THINKING_LEVELS.length - 1)) * 25}px)`
  const effectiveText = effectiveThinking && effectiveThinking !== effLevel
    ? ` → ${effortDisplay(effectiveThinking as Thinking, t)}`
    : ''
  const isMax = effLevel === 'max'

  const groupCatalog = (models: ModelInfo[]): ModelPillGroup[] => {
    const map = new Map<string, ModelPillGroup>()
    for (const m of models) {
      const key = `${m.source}:${m.provider}`
      const source = m.source === 'direct' ? t('model.group.direct') : t('model.group.forsion')
      let g = map.get(key)
      if (!g) { g = { label: `${m.provider} · ${source}`, options: [] }; map.set(key, g) }
      g.options.push({ id: m.id, name: m.name, description: `${m.provider} · ${m.id}` })
    }
    return [...map.values()]
  }

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

  const paneGroups = pane === 'model' ? groups : pane ? groupCatalog(slotModels(pane)) : []
  const paneValue = pane === 'model' ? modelId : pane ? (defaultModelIds?.[pane] || '') : ''
  const selectDefault = (slot: DefaultModelSlot, id: string): void => {
    onDefaultModelChange?.(slot, id)
    setPane(null)
  }
  const showPane = (p: Pane) => (): void => setPane(p)

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
      <button
        className={`composer-chip model-pill-btn${open ? ' is-open' : ''}${isMax ? ' is-max' : ''}`}
        title={title || t('input.modelChipTitle')}
        disabled={disabled}
        onClick={() => setPillOpen(!open)}
      >
        <Bot size={13} />
        <MarqueeLabel text={label + effort} />
        <ChevronDown size={10} />
      </button>
      {open && (
        <div ref={menuFix.ref} className="composer-menu composer-menu--model" style={menuFix.style}>
          {onThinkingChange && (
            <>
              {/* 高级内容放在触发行上方；菜单底边固定，所以展开时卡片向上生长、后三行不位移。 */}
              <div className={`cm-advanced-reveal${advanced ? ' is-open' : ''}`} aria-hidden={!advanced}>
                <div className="cm-advanced-reveal-inner">
                  <div className="cm-advanced-list">
                    <div className="cm-row cm-row--static">
                      <span className="cm-row-k">{t('pill.reasoningStrength')}</span>
                      <span className={`cm-row-v${isMax ? ' is-max' : ''}`}>{effortText}{effectiveText}</span>
                    </div>
                    {onDefaultModelChange && slotRows.map(({ slot, label: rowLabel }) => (
                      <button
                        key={slot}
                        className={`cm-row${pane === slot ? ' is-open' : ''}`}
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
              <button
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

          {/* 第二行：保留原有按 provider 分组的模型选择器。 */}
          <button
            className={`cm-row cm-model-row${pane === 'model' ? ' is-open' : ''}`}
            onMouseEnter={showPane('model')}
            onFocus={showPane('model')}
            onClick={showPane('model')}
          >
            <span className="cm-row-k">{t('pill.rowModel')}</span>
            <span className="cm-row-v">{label}</span>
            <ChevronRight size={13} />
          </button>

          {/* 第三行：ChatGPT 式离散拖动条。Max 单独切换蓝紫渐变 + 星点层。 */}
          {onThinkingChange && (
            <div className={`cm-effort${isMax ? ' is-max' : ''}`} data-effort={effLevel}>
              <div className="cm-effort-head">
                <span>{t('pill.rowEffort')}</span>
                <span key={effLevel} className="cm-effort-value">{effortText}{effectiveText}</span>
              </div>
              <div className="cm-effort-ends"><span>{t('pill.faster')}</span><span>{t('pill.smarter')}</span></div>
              <div className="cm-effort-slider-wrap">
                <span className="cm-effort-track" aria-hidden="true">
                  <span className="cm-effort-range" style={{ width: effortPct }} />
                  {isMax && (
                    <span className="cm-effort-sparkles">
                      {Array.from({ length: 10 }, (_, i) => <i key={i} />)}
                    </span>
                  )}
                  <span className="cm-effort-ticks">
                    {THINKING_LEVELS.map((lv, i) => (
                      <i
                        key={lv}
                        className={`${i <= effortIndex ? ' is-on' : ''}${supportedThinking && !supportedThinking.includes(lv) ? ' is-unsupported' : ''}`}
                        style={{ left: `${(i / (THINKING_LEVELS.length - 1)) * 100}%` }}
                      />
                    ))}
                  </span>
                </span>
                <span className="cm-effort-thumb" style={{ left: effortThumbLeft }} aria-hidden="true" />
                <input
                  className="cm-effort-input"
                  type="range"
                  min={0}
                  max={THINKING_LEVELS.length - 1}
                  step={1}
                  value={effortIndex}
                  aria-label={t('pill.reasoningStrength')}
                  aria-valuetext={`${effortText}${supportedThinking && !supportedThinking.includes(effLevel) ? ` ${t('pill.thinkUnsupported')}` : ''}`}
                  title={t(thinkingLabelKey(effLevel))}
                  onChange={(e) => onThinkingChange(effortAt(Number(e.currentTarget.value)))}
                />
              </div>
            </div>
          )}

          {footnote && <div className="menu-section cm-foot">{footnote}</div>}
          {pane && (
            <div
              ref={(el) => { subRef.current = el; subFix.ref.current = el }}
              className={`cm-sub${flip ? ' flip' : ''}`}
              data-pane={pane}
              style={subFix.style}
            >
              {pane !== 'model' && (
                <button
                  className={`menu-item${paneValue ? '' : ' active'}`}
                  onClick={() => selectDefault(pane, '')}
                >
                  <span className="grow">{slotLabel(pane)}</span>
                  <span className="mi-check">{paneValue ? '' : '✓'}</span>
                </button>
              )}
              {paneGroups.map((g) => (
                <React.Fragment key={g.label}>
                  <div className="menu-section">{g.label}</div>
                  {g.options.map((m) => (
                    <button
                      key={m.id}
                      className={`menu-item${m.id === paneValue ? ' active' : ''}`}
                      title={m.description}
                      onClick={() => {
                        if (pane === 'model') { onSelect(m.id); setPillOpen(false) }
                        else selectDefault(pane, m.id)
                      }}
                    >
                      <span className="grow">{m.name}</span>
                      <span className="mi-check">{m.id === paneValue ? '✓' : ''}</span>
                    </button>
                  ))}
                </React.Fragment>
              ))}
              {!paneGroups.length && <div className="menu-section">{t('pill.noModels')}</div>}
            </div>
          )}
        </div>
      )}
    </span>
  )
}
