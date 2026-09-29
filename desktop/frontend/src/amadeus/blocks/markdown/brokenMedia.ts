// 坏图 / 坏媒体的失败态(评审 R-21)。此前 <img> 与播放器都没有 onerror:缺失的本地图只剩浏览器的破图标、alt 被裁掉,
// 没有 alt 的远程图是 0×0(看不见也选不中),缺失的视频是一个空播放器 —— 用户分不清「没加载完」和「文件没了」。
// 现在:加载失败 → 包裹元素挂 data-broken,图 / 播放器让位给一行占位说明(图标 + 「无法加载:文件名」),
// 包裹元素本身不动,所以悬停 `</>` 看 / 改源码、点一下选中整块照常可用;路径改对重新加载成功即撤回占位。
// 外观沿用嵌入丢失壳(.embed-missing)的口径:次要文字色、无描边的浅底圆角块(DESIGN §5 内容卡不描边)。
import { registerMessages, translate } from '../../../i18n'

registerMessages({
  'brokenmedia.image': { zh: '图片无法加载：{name}', en: 'Image could not be loaded: {name}' },
  'brokenmedia.media': { zh: '媒体无法加载：{name}', en: 'Media could not be loaded: {name}' },
})

/** lucide image-off(24 格描边),与编辑器里其它线性图标同族。 */
const ICON = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="2" x2="22" y1="2" y2="22"/><path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"/><line x1="13.5" x2="6" y1="13.5" y2="21"/><line x1="18" x2="21" y1="12" y2="15"/><path d="M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59"/><path d="M21 15V5a2 2 0 0 0-2-2H9"/></svg>'

/** 路径 / URL 的最后一段(解码),当占位里的文件名。 */
export function mediaNameOf(src: string): string {
  const tail = src.split(/[?#]/)[0].split('/').pop() ?? src
  try {
    return decodeURIComponent(tail) || src
  } catch {
    return tail || src
  }
}

/** 盯住一张图:失败 → wrap[data-broken] + 占位说明;之后换了 src 加载成功 → 撤回。name 现取(src 可能被改过)。 */
export function watchBrokenImage(wrap: HTMLElement, img: HTMLImageElement, name: () => string): void {
  let note: HTMLSpanElement | null = null
  img.addEventListener('error', () => {
    if (!img.getAttribute('src')) return // 还没给地址(NodeView 构造期)不算失败
    wrap.dataset.broken = ''
    if (!note) {
      note = document.createElement('span')
      note.className = 'amx-broken-media'
      note.contentEditable = 'false'
    }
    note.innerHTML = ICON
    note.append(` ${translate('brokenmedia.image', { name: name() })}`)
    if (!note.isConnected) img.after(note)
  })
  img.addEventListener('load', () => {
    delete wrap.dataset.broken
    note?.remove()
  })
}

export const BROKEN_MEDIA_ICON = ICON
