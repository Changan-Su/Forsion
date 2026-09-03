/**
 * 画布 chrome(缩放胶囊 + 吸附 / 缩略图开关),两边共用同一份标记与同一套偏好。
 * 复用既有的 `.amx-stage-hud` 样式(scope = `.am-app`,仪表盘根上也有这个类)。
 */
import { Magnet, Map as MapIcon, Maximize2, Minus, Plus } from 'lucide-react'
import { registerMessages, useI18n } from '../../../i18n'

registerMessages({
  'ckchrome.zoomOut': { zh: '缩小', en: 'Zoom out' },
  'ckchrome.zoomIn': { zh: '放大', en: 'Zoom in' },
  'ckchrome.fit': { zh: '适应内容', en: 'Fit to content' },
  'ckchrome.snap': { zh: '点阵吸附', en: 'Snap to grid' },
  'ckchrome.snapOff': { zh: '关闭点阵吸附', en: 'Turn off snap to grid' },
  'ckchrome.snapOn': { zh: '开启点阵吸附', en: 'Turn on snap to grid' },
  'ckchrome.miniHide': { zh: '隐藏缩略图', en: 'Hide minimap' },
  'ckchrome.miniShow': { zh: '显示缩略图', en: 'Show minimap' },
})

export function CanvasChrome({ zoom, onZoomBy, onFit, snap, onSnap, mini, onMini, extra }: {
  zoom: number
  onZoomBy: (factor: number) => void
  onFit: () => void
  snap: boolean
  onSnap: (on: boolean) => void
  mini: boolean
  onMini: (on: boolean) => void
  /** 各家自己的按钮(画布的「低倍率简略」之类)。 */
  extra?: React.ReactNode
}) {
  const { t } = useI18n()
  return (
    <div className="amx-stage-hud">
      <button type="button" onClick={() => onZoomBy(1 / 1.2)} title={t('ckchrome.zoomOut')}><Minus size={12} /></button>
      <span>{Math.round(zoom * 100)}%</span>
      <button type="button" onClick={() => onZoomBy(1.2)} title={t('ckchrome.zoomIn')}><Plus size={12} /></button>
      <button type="button" onClick={onFit} title={t('ckchrome.fit')}><Maximize2 size={12} /></button>
      {extra}
      <button
        type="button"
        className={`amx-snap-toggle${snap ? ' is-on' : ''}`}
        aria-pressed={snap}
        aria-label={t('ckchrome.snap')}
        title={snap ? t('ckchrome.snapOff') : t('ckchrome.snapOn')}
        onClick={() => onSnap(!snap)}
      >
        <Magnet size={12} />
      </button>
      <button
        type="button"
        className={mini ? 'is-on' : ''}
        aria-pressed={mini}
        title={mini ? t('ckchrome.miniHide') : t('ckchrome.miniShow')}
        onClick={() => onMini(!mini)}
      >
        <MapIcon size={12} />
      </button>
    </div>
  )
}
