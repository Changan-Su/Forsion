/**
 * 多图叠成一摞(10-24,借鉴 Comma 第二轮 §2.5):用户消息带的图超过 3 张时不再平铺,叠成一摞。
 * - 最上面一张完整;没看的在右边、看过的在左边,每边最多露 2 张,只错开露边、不旋转;再往后的藏在第 2 张后面。
 * - 角上药丸「{n} 张」;悬停 / 键盘聚焦出左右翻页(两头不循环,和看图器一样到头就停);手机左右滑(外接键盘 / 读屏照样有翻页钮)。
 * - 翻页 --duration-slow(CSS 过渡);往后翻时,翻过的那张先甩到左边再落进左边那摞(320ms);减少动态效果时两样都不做。
 * - N 张图全在 DOM 里、按附件顺序:看图器按 DOM 顺序收 img[data-viewable],点最上面那张 = 从这张开始「k / N」;
 *   看图器关闭时把焦点还给看到的最后一张,这里借 onFocus 把那张翻到最上面。
 * 方案页:docs/ToBeImproved/借鉴Comma方案_2026-10-21/more.html §2.5(Comma 是 AGPL,只借做法与数值,代码一行没抄)
 */
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { reducedMotion } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'
import { viewableProps } from './ImageViewer'
import type { TileFile } from './AttachmentTile'

registerMessages({
  'chat.imageStack.count': { zh: '{n} 张', en: '{n} images' },
  'chat.imageStack.prev': { zh: '上一张', en: 'Previous image' },
  'chat.imageStack.next': { zh: '下一张', en: 'Next image' },
})

/** 超过这么多张才叠 */
export const STACK_THRESHOLD = 3
export const stackable = (n: number): boolean => n > STACK_THRESHOLD
/** 第 i 张相对最上面那张的位置:0 = 最上面,±1 / ±2 = 右 / 左露边,±3 = 藏在第 2 张后面 */
export const slotOf = (i: number, front: number): number => Math.max(-3, Math.min(3, i - front))
/** 翻一页;两头不循环 */
export const turn = (front: number, step: 1 | -1, n: number): number => Math.max(0, Math.min(n - 1, front + step))

const PEEK = 7 // 每层露出的边,px
const SCALE = [1, 0.92, 0.84, 0.84]
const FLY_MS = 320
const SWIPE_PX = 32
/** 正在飞的那张何时垫下去;同一张连着再飞时先清掉上一回的 */
const flyTimers = new WeakMap<HTMLElement, number>()

/** 停掉这张的甩出动画(CSS 过渡不动) */
function land(el: HTMLElement): void {
  el.getAnimations().forEach((a) => { if (!('transitionProperty' in a)) a.cancel() })
  window.clearTimeout(flyTimers.get(el))
  delete el.dataset.flying
}

/** 缩小后按中心对齐,再往外推:让第 k 层的外沿正好比上一层多露 PEEK */
function slotStyle(k: number): CSSProperties {
  const a = Math.abs(k)
  const s = SCALE[a]
  const style = { '--img-stack-z': 10 - a, opacity: a > 2 ? 0 : 1 } as CSSProperties
  if (a) style.transform = `translateX(calc(${Math.sign(k)} * (var(--img-stack-w) * ${((1 - s) / 2).toFixed(2)} + ${Math.min(a, 2) * PEEK}px))) scale(${s})`
  return style
}

export function ImageStack({ files }: { files: TileFile[] }) {
  const { t } = useI18n()
  const [front, setFront] = useState(0)
  const cards = useRef<(HTMLSpanElement | null)[]>([])
  const fly = useRef<{ el: HTMLSpanElement; from: string } | null>(null)
  const touch = useRef<{ x: number; y: number } | null>(null)
  const swiped = useRef(false)
  const n = files.length

  const go = (step: 1 | -1): void => {
    const next = turn(front, step, n)
    if (next === front) return
    const el = cards.current[front]
    if (step === 1 && el && !reducedMotion()) fly.current = { el, from: getComputedStyle(el).transform }
    setFront(next)
  }

  // 翻过的那张:先压掉它的槽位过渡(要在样式重算之前),读出落点,再用 WAAPI 甩出去落回来;过了 60% 垫到新的最上面那张底下
  useLayoutEffect(() => {
    const p = fly.current
    fly.current = null
    // 别的卡还在上一回的半路(翻过去马上又翻回来 / 看图器关了换最上面那张):停掉,交给槽位过渡,不然飞完会弹回去
    for (const c of cards.current) if (c && c !== p?.el) land(c)
    if (!p || typeof p.el.animate !== 'function') return
    const { el, from } = p
    land(el)
    el.dataset.flying = ''
    const to = getComputedStyle(el).transform
    const apex = `translateX(${-Math.round(el.offsetWidth * 0.7)}px) scale(.96)`
    // 分段缓动:前 40% 甩出去(减速),后 60% 慢慢落回左边那摞
    el.animate([{ transform: from, easing: 'cubic-bezier(.2, .8, .2, 1)' }, { transform: apex, offset: 0.4, easing: 'cubic-bezier(.4, 0, .2, 1)' }, { transform: to }], FLY_MS)
    flyTimers.set(el, window.setTimeout(() => { delete el.dataset.flying }, FLY_MS * 0.6))
  }, [front])

  return (
    <div
      className="img-stack" role="group" aria-label={t('chat.imageStack.count', { n })} data-front={front}
      onPointerDown={(e) => { swiped.current = false; touch.current = e.pointerType === 'mouse' ? null : { x: e.clientX, y: e.clientY } }}
      onPointerUp={(e) => {
        const s = touch.current
        touch.current = null
        if (!s) return
        const dx = e.clientX - s.x, dy = e.clientY - s.y
        if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.2) return
        swiped.current = true // 滑完跟着来的那下 click 不开看图
        go(dx < 0 ? 1 : -1)
      }}
      onClickCapture={(e) => { if (swiped.current) { swiped.current = false; e.preventDefault(); e.stopPropagation() } }}
    >
      {files.map((f, i) => {
        const k = slotOf(i, front)
        return (
          <span key={`${f.name}-${i}`} ref={(el) => { cards.current[i] = el }} className="img-stack-card" style={slotStyle(k)} aria-hidden={k ? true : undefined}>
            <img src={`data:${f.mimeType};base64,${f.data}`} alt={f.name} draggable={false} {...viewableProps({ name: f.name })} tabIndex={k ? -1 : 0} onFocus={() => setFront(i)} />
          </span>
        )
      })}
      <span className="img-stack-count" aria-hidden>{t('chat.imageStack.count', { n })}</span>
      <button type="button" className="img-stack-nav" data-dir="prev" disabled={front === 0} title={t('chat.imageStack.prev')} aria-label={t('chat.imageStack.prev')} onClick={() => go(-1)}><ChevronLeft size={14} /></button>
      <button type="button" className="img-stack-nav" data-dir="next" disabled={front === n - 1} title={t('chat.imageStack.next')} aria-label={t('chat.imageStack.next')} onClick={() => go(1)}><ChevronRight size={14} /></button>
    </div>
  )
}
