/**
 * 画布 chrome(缩放胶囊 + 吸附 / 缩略图开关),两边共用同一份标记与同一套偏好。
 * 复用既有的 `.amx-stage-hud` 样式(scope = `.am-app`,仪表盘根上也有这个类)。
 */
import { Magnet, Map as MapIcon, Maximize2, Minus, Plus } from 'lucide-react'

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
  return (
    <div className="amx-stage-hud">
      <button type="button" onClick={() => onZoomBy(1 / 1.2)} title="缩小"><Minus size={12} /></button>
      <span>{Math.round(zoom * 100)}%</span>
      <button type="button" onClick={() => onZoomBy(1.2)} title="放大"><Plus size={12} /></button>
      <button type="button" onClick={onFit} title="适应内容"><Maximize2 size={12} /></button>
      {extra}
      <button
        type="button"
        className={`amx-snap-toggle${snap ? ' is-on' : ''}`}
        aria-pressed={snap}
        aria-label="点阵吸附"
        title={snap ? '关闭点阵吸附' : '开启点阵吸附'}
        onClick={() => onSnap(!snap)}
      >
        <Magnet size={12} />
      </button>
      <button
        type="button"
        className={mini ? 'is-on' : ''}
        aria-pressed={mini}
        title={mini ? '隐藏缩略图' : '显示缩略图'}
        onClick={() => onMini(!mini)}
      >
        <MapIcon size={12} />
      </button>
    </div>
  )
}
