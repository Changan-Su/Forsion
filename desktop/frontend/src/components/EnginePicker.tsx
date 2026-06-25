/**
 * 新会话「运行引擎」选择条(参考 AionUI 的横向 agent pill bar)。
 * 未选 = icon-only(hover 展开名);选中 = 展开名 + pop 动画;外部引擎预热(探测能力,npx 冷启)时
 * 显示 spinner + 提示。**一个 Session 只用一种引擎**:故仅在新会话(无消息)出现,选定即用,
 * 有消息后不再显示、引擎不可改。Tangu 内置 = id ''。
 */
import React from 'react'
import { Loader2 } from 'lucide-react'
import { useI18n } from '../i18n'
import { EngineIcon } from './EngineIcon'

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
      <div className="engine-picker-bar" role="radiogroup" aria-label={t('engine.pickTitle')}>
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
      </div>
      <div className="engine-picker-hint">{warmingId ? t('engine.warming', { name: warmingName }) : t('engine.pickTitle')}</div>
    </div>
  )
}
