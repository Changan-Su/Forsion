/**
 * 新会话「运行引擎」选择条(参考 AionUI 的横向 agent pill bar)。
 * 未选 = icon-only(hover 展开名);选中 = 展开名 + pop 动画;外部引擎预热(探测能力,npx 冷启)时
 * 显示 spinner + 提示。**一个 Session 只用一种引擎**:故仅在新会话(无消息)出现,选定即用,
 * 有消息后不再显示、引擎不可改。Tangu 内置 = id ''。
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Loader2, MoreHorizontal } from 'lucide-react'
import { useI18n } from '../i18n'
import { EngineIcon } from './EngineIcon'
import { isOverflowing, nextPageLeft } from './pillBar'
import { CompactChatPicker } from './CompactChatPicker'

/**
 * pill 选择条外壳:宽度放不下时右端钉一个「⋯」,点击平滑翻到下一页(落点对齐 pill 边界),
 * 末页再点循环回第一页(用户拍板)。AgentPicker 复用。
 * ⋯ 在滚动容器外独占一列,不覆盖末尾选项;滚动宽度即完整可点击的宽度。
 */
export const PillBar: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)

  // 溢出与否要盯两头:容器变窄(拖侧栏/缩窗)和内容变宽(pill 数量变化、选中态展开名字)。
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const sync = (): void => {
      const bar = el.parentElement
      const style = bar && getComputedStyle(bar)
      // 按整条 bar 的可用宽度判断,不扣已显示的「⋯」:否则它自己占掉的 36px 会让按钮收不回去。
      const available = bar && style ? bar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) : el.clientWidth
      setMore(isOverflowing(el.scrollWidth, available))
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    for (const c of Array.from(el.children)) ro.observe(c)
    return () => ro.disconnect()
  }, [children])

  // 选中项落在后面几页时,开局先把它露出来(否则新会话看不到自己当前选的 agent)。
  // 直接改 scrollLeft 而非 scrollIntoView —— 后者会连带滚动祖先(聊天区)。
  useEffect(() => {
    const el = ref.current
    const sel = el?.querySelector<HTMLElement>('[aria-checked="true"]')
    if (!el || !sel) return
    const bar = el.getBoundingClientRect()
    const p = sel.getBoundingClientRect()
    if (p.right > bar.right) el.scrollLeft += p.right - bar.right + 6
    else if (p.left < bar.left) el.scrollLeft -= bar.left - p.left + 6
    // 只在挂载时纠一次:之后是用户在翻页,别跟他抢滚动位置。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const page = useCallback((): void => {
    const el = ref.current
    if (!el) return
    const bar = el.getBoundingClientRect()
    const pills = Array.from(el.children).map((c) => {
      const r = c.getBoundingClientRect()
      return { start: r.left - bar.left + el.scrollLeft, end: r.right - bar.left + el.scrollLeft }
    })
    el.scrollTo({ left: nextPageLeft({ left: el.scrollLeft, width: el.clientWidth, content: el.scrollWidth }, pills), behavior: 'smooth' })
  }, [])

  return (
    <div className="engine-picker-bar" data-more={more || undefined}>
      <div className="engine-picker-scroll" ref={ref} role="radiogroup" aria-label={label}>{children}</div>
      {more && (
        <button type="button" className="engine-picker-more" onClick={page} title={t('pill.more')} aria-label={t('pill.more')}>
          <MoreHorizontal size={16} />
        </button>
      )}
    </div>
  )
}

export const EnginePicker: React.FC<{
  engines: Array<{ id: string; name: string }>
  selectedId: string // '' = Tangu 内置
  warmingId?: string | null // 正在预热的外部引擎 id
  onSelect: (id: string) => void
}> = ({ engines, selectedId, warmingId, onSelect }) => {
  const { t } = useI18n()
  const options = [{ id: '', name: t('input.engineDefault') }, ...engines]
  const warmingName = warmingId ? options.find((o) => o.id === warmingId)?.name || '' : ''
  return (
    <div className="engine-picker">
      <CompactChatPicker
        label={t('chatPicker.engine')}
        value={selectedId}
        icon={warmingId ? <Loader2 size={16} className="spin" /> : <EngineIcon engineId={selectedId} size={16} />}
        options={options.map((option) => ({ value: option.id, name: option.name, disabled: !!warmingId && option.id !== warmingId }))}
        onChange={(id) => { if (!warmingId) onSelect(id) }}
        busy={!!warmingId}
      />
      <PillBar label={t('engine.pickTitle')}>
        {options.map((o) => {
          const selected = o.id === selectedId
          const warming = !!warmingId && o.id === warmingId
          return (
            <button
              key={o.id || 'tangu'}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`engine-pill${selected ? ' selected' : ''}`}
              title={o.name}
              disabled={!!warmingId && !warming}
              onClick={() => { if (!warming) onSelect(o.id) }}
            >
              <span className="engine-pill-icon">
                {warming ? <Loader2 size={16} className="spin" /> : <EngineIcon engineId={o.id} size={16} />}
              </span>
              <span className="engine-pill-label">{o.name}</span>
            </button>
          )
        })}
      </PillBar>
      <div className="engine-picker-hint">{warmingId ? t('engine.warming', { name: warmingName }) : t('engine.pickTitle')}</div>
    </div>
  )
}
