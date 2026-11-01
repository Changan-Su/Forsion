/**
 * 音色卡片(设置 → 模型 → 语音):通话、朗读共用这一个组件,各放一份,音色不混排。
 * 圆钮只试听、不改设置;点卡片才采用。没有 onPick = 还不能采用(没登录),只能听。
 */
import type { ReactNode } from 'react'
import { Check, Play, Plus, Trash2 } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { useVoicePreview } from '../services/voiceCatalog'
import './voiceGallery.css'

registerMessages({
  'voicegallery.hint': { zh: '点圆钮试听，点卡片采用', en: 'Play to preview, click a card to use it' },
  'voicegallery.hintListen': { zh: '登录前也能试听', en: 'You can preview before signing in' },
  'voicegallery.mine': { zh: '我的音色', en: 'My voices' },
  'voicegallery.new': { zh: '新建音色', en: 'New voice' },
  'voicegallery.newCall': { zh: '复刻你的声音', en: 'Clone your voice' },
  'voicegallery.newRead': { zh: '复刻或描述', en: 'Clone or describe' },
  'voicegallery.preview': { zh: '试听 {name}', en: 'Preview {name}' },
  'voicegallery.delete': { zh: '删除 {name}', en: 'Delete {name}' },
  'voicegallery.all': { zh: '全部 {n} 个', en: 'All {n}' },
  'voicegallery.fewer': { zh: '收起', en: 'Show fewer' },
})

export interface VoiceItem {
  id: string
  name: string
  desc?: string
  /** 绑在别的模型上:变灰,点了说明原因,不采用。 */
  bound?: boolean
  onPreview?: () => void
  onDelete?: () => void
}

function VoiceTile({ item, selected, onPick, previewKey }: { item: VoiceItem; selected: boolean; onPick?: () => void; previewKey: string }) {
  const { t } = useI18n()
  const playing = useVoicePreview() === previewKey
  return (
    <div className="voice-tile" data-voice={item.id} data-on={selected || undefined} data-bound={item.bound || undefined}>
      {item.onPreview && (
        <button type="button" className="voice-tile-play" aria-pressed={playing} aria-label={t('voicegallery.preview', { name: item.name })} title={t('voicegallery.preview', { name: item.name })} onClick={item.onPreview}>
          {playing ? <span className="voice-tile-bars" aria-hidden="true"><i /><i /><i /></span> : <Play size={10} fill="currentColor" />}
        </button>
      )}
      <button type="button" role="radio" aria-checked={selected} className="voice-tile-pick" disabled={!onPick} onClick={onPick}>
        <b>{item.name}</b>
        {item.desc && <small>{item.desc}</small>}
      </button>
      {selected && <span className="voice-tile-check" aria-hidden="true"><Check size={13} /></span>}
      {item.onDelete && !selected && (
        <button type="button" className="voice-tile-del" aria-label={t('voicegallery.delete', { name: item.name })} title={t('voicegallery.delete', { name: item.name })} onClick={item.onDelete}><Trash2 size={12} /></button>
      )}
    </div>
  )
}

export function VoiceGallery(p: {
  title: string
  hint?: string
  system: VoiceItem[]
  mine?: VoiceItem[]
  value: string
  previewScope: string
  onPick?: (item: VoiceItem) => void
  /** 新建入口;不给 = 这里不能新建。 */
  onNew?: () => void
  newHint?: string
  /** 系统音色多时先露一部分,这里放「全部」的开关。 */
  trailing?: ReactNode
}) {
  const { t } = useI18n()
  const tile = (v: VoiceItem) => <VoiceTile key={v.id} item={v} selected={v.id === p.value} onPick={p.onPick ? () => p.onPick!(v) : undefined} previewKey={`${p.previewScope}:${v.id}`} />
  return (
    <div className="voice-gallery">
      <div className="voice-gallery-head">
        <strong>{p.title}</strong>
        <small>{p.hint ?? t('voicegallery.hint')}</small>
        {p.trailing && <span className="voice-gallery-trailing">{p.trailing}</span>}
      </div>
      {p.system.length > 0 && <div className="voice-gallery-grid" role="radiogroup" aria-label={p.title}>{p.system.map(tile)}</div>}
      {(p.onNew || !!p.mine?.length) && (
        <>
          <div className="voice-gallery-sub">{t('voicegallery.mine')}</div>
          <div className="voice-gallery-grid" role="radiogroup" aria-label={t('voicegallery.mine')}>
            {p.mine?.map(tile)}
            {p.onNew && (
              <div className="voice-tile" data-add="">
                <span className="voice-tile-play" aria-hidden="true"><Plus size={13} /></span>
                <button type="button" className="voice-tile-pick voice-tile-new" onClick={p.onNew}>
                  <b>{t('voicegallery.new')}</b>
                  {p.newHint && <small>{p.newHint}</small>}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
