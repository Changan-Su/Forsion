/**
 * 模型选择器 pill:圆角 pill(机器人图标 + 模型名 + 下拉箭头,长名跑马灯;窄屏收成纯图标)+ 两级菜单
 * (Codex 形:左面板「模型 / 思考」两行各显示当前值,点开某行 → 右侧贴出选项子面板,带 ✓)+
 * 三态(只读「用引擎默认」/ 交互)。
 *
 * 数据源由调用方决定:Tangu 模式传 groups=按 provider 分组 + thinking;外部引擎模式传 groups=引擎模型单组、
 * 无 thinking、emptyLabel=「用引擎默认」。组件本身与数据来源无关。
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Bot } from 'lucide-react'
import { zoomOf, useEdgeNudge } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'
import { THINKING_LEVELS } from '../types'
import type { AgentConfig } from '../types'

registerMessages({
  'pill.rowModel': { zh: '模型', en: 'Model' },
  'pill.rowEffort': { zh: '思考', en: 'Effort' },
})

export interface ModelPillOption { id: string; name: string; description?: string }
export interface ModelPillGroup { label: string; options: ModelPillOption[] }
type Thinking = NonNullable<AgentConfig['thinkingLevel']>

const thinkingLabelKey = (lv: Thinking): string => `input.thinking.${lv}`
const thinkingShortKey = (lv: Thinking): string => `input.thinkingShort.${lv}`

/**
 * 子面板要不要翻到菜单左侧。
 * ⚠️ anchorRight / vw 是**视口** px(rect、innerWidth),subW 是**未缩放**局部 px(offsetWidth):
 * 跨坐标系比较必须先把 subW 乘上端级 zoom,否则 body zoom≠1 时判定必错(见 lcl/engine/menuAnchor 的同款坑)。
 */
export function subFlips(anchorRight: number, subW: number, zoom: number, vw: number, gap = 6, margin = 8): boolean {
  return anchorRight + (gap + subW) * zoom > vw - margin
}

/** 仅当文本溢出才在 hover 时跑马灯(测 scrollWidth>clientWidth → 加 class,纯 CSS 平移)。 */
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
  disabled?: boolean
  modelId?: string
  groups: ModelPillGroup[]
  onSelect: (id: string) => void
  thinkingLevel?: Thinking
  onThinkingChange?: (lv: Thinking) => void
  /** 当前模型支持的思考档(引擎能力表);缺省=未知,全可选。不支持的档标灰但仍可选(引擎会自动降档)。 */
  supportedThinking?: string[]
  /** 本 run 实际生效档(引擎 context_info):与请求档不同=被降档,行值标注出来(H6)。 */
  effectiveThinking?: string
  /** 无可选模型时的只读标签(外部引擎:「用引擎默认」)。 */
  emptyLabel?: string
  /** 菜单底部说明(云端会话解释「为什么直连模型不在列表里」,免得用户以为丢了)。 */
  footnote?: string
  title?: string
}> = ({ disabled, modelId, groups, onSelect, thinkingLevel, onThinkingChange, supportedThinking, effectiveThinking, emptyLabel, footnote, title }) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<'model' | 'effort' | null>(null)
  const [flip, setFlip] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  // 视口兜底:菜单 `right:0` + 固定 224px 宽,pill 只要离左边不足 232px,菜单左缘就是负数;
  // 子面板再 flip 到左边一叠加,整块跑出屏幕(手机上实报)。subFlips 只决定翻不翻,不管掉不掉出去。
  const menuFix = useEdgeNudge(open)
  const subFix = useEdgeNudge(pane ? `${pane}:${flip}` : '') // flip 进依赖:翻面后要按新一侧重夹

  useEffect(() => {
    if (!open) { setPane(null); return }
    const onDown = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  // 子面板默认贴菜单右侧,右边放不下就翻到左侧。菜单 right:0 贴在 wrap 右缘,故菜单右缘 == wrap 右缘。
  useLayoutEffect(() => {
    const el = subRef.current
    const wrap = wrapRef.current
    if (!pane || !el || !wrap) return
    setFlip(subFlips(wrap.getBoundingClientRect().right, el.offsetWidth, zoomOf(el), window.innerWidth))
  }, [pane])

  const all = groups.flatMap((g) => g.options)
  const hasModels = all.length > 0
  const current = all.find((m) => m.id === modelId)
  // 三态:无 thinking(=外部引擎模式)且无可选模型 + 有 emptyLabel → 只读 pill。
  const readonly = !onThinkingChange && !hasModels && !!emptyLabel
  const label = current?.name || emptyLabel || t('input.selectModel')
  // 未显式设置 = 引擎默认思考·中(agentLoop 同款回退)——显示必须与实际执行一致。
  const effLevel: Thinking = thinkingLevel || 'medium'
  const effort = effLevel !== 'off' ? ` · ${t(thinkingShortKey(effLevel))}` : ''

  if (readonly) {
    return (
      <span className="composer-chip composer-chip--readonly" title={title}>
        <Bot size={13} />
        <MarqueeLabel text={label} />
      </span>
    )
  }

  // 一级菜单点击才开(不抢焦点),二级子面板悬停即显示。
  // 悬停只「切换到这一格」、从不在 mouseleave 关闭 —— 关了的话斜着往子面板走的路径会先掠过另一行/空白,
  // 面板闪没,里面的选项就永远点不到(同 .t2c-ctxring-pop 那条透明桥治的是一个病)。
  const showPane = (p: 'model' | 'effort') => (): void => setPane(p)

  return (
    <span ref={wrapRef} className={`model-pill-wrap${open ? ' is-open' : ''}`} data-cmenu>
      <button
        className={`composer-chip model-pill-btn${open ? ' is-open' : ''}`}
        title={title || t('input.modelChipTitle')}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <Bot size={13} />
        <MarqueeLabel text={label + effort} />
        <ChevronDown size={10} />
      </button>
      {open && (
        <div ref={menuFix.ref} className="composer-menu composer-menu--model" style={menuFix.style}>
          <button className={`cm-row${pane === 'model' ? ' is-open' : ''}`} onMouseEnter={showPane('model')} onFocus={showPane('model')} onClick={showPane('model')}>
            <span className="cm-row-k">{t('pill.rowModel')}</span>
            <span className="cm-row-v">{label}</span>
            <ChevronRight size={13} />
          </button>
          {onThinkingChange && (
            <button className={`cm-row${pane === 'effort' ? ' is-open' : ''}`} onMouseEnter={showPane('effort')} onFocus={showPane('effort')} onClick={showPane('effort')}>
              <span className="cm-row-k">{t('pill.rowEffort')}</span>
              <span className="cm-row-v">
                {t(thinkingShortKey(effLevel))}
                {/* 实际生效档与请求档不同=被能力表降档,如实标出(H6) */}
                {effectiveThinking && effectiveThinking !== effLevel && ` → ${t(thinkingShortKey(effectiveThinking as Thinking))}`}
              </span>
              <ChevronRight size={13} />
            </button>
          )}
          {footnote && <div className="menu-section cm-foot">{footnote}</div>}
          {pane && (
            <div
              ref={(el) => { subRef.current = el; subFix.ref.current = el }}
              className={`cm-sub${flip ? ' flip' : ''}`}
              data-pane={pane}
              style={subFix.style}
            >
              {pane === 'effort'
                ? THINKING_LEVELS.map((lv) => {
                    // 不支持的档标灰但可选:引擎会自动降档,选了也不出错——灰+后缀让降档不再静默
                    const unsupported = !!supportedThinking && !supportedThinking.includes(lv)
                    return (
                      <button
                        key={lv}
                        className={`menu-item${effLevel === lv ? ' active' : ''}${unsupported ? ' mi-dim' : ''}`}
                        onClick={() => { onThinkingChange?.(lv); setOpen(false) }}
                      >
                        <span className="grow">{t(thinkingLabelKey(lv))}{unsupported ? ` ${t('pill.thinkUnsupported')}` : ''}</span>
                        <span className="mi-check">{effLevel === lv ? '✓' : ''}</span>
                      </button>
                    )
                  })
                : groups.map((g) => (
                    <React.Fragment key={g.label}>
                      <div className="menu-section">{g.label}</div>
                      {g.options.map((m) => (
                        <button
                          key={m.id}
                          className={`menu-item${m.id === modelId ? ' active' : ''}`}
                          title={m.description}
                          onClick={() => { onSelect(m.id); setOpen(false) }}
                        >
                          <span className="grow">{m.name}</span>
                          <span className="mi-check">{m.id === modelId ? '✓' : ''}</span>
                        </button>
                      ))}
                    </React.Fragment>
                  ))}
              {pane === 'model' && !hasModels && <div className="menu-section">{t('common.loading')}</div>}
            </div>
          )}
        </div>
      )}
    </span>
  )
}
