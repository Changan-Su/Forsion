import { useEffect } from 'react'
import { useSpaceStore } from '@lcl/engine/spaceRegistry'
import { useVisualTheme } from '../stores/themeStore'
import { paletteFromRgba, type AmbientPalette, type AmbientRect } from '../../../shared/ambientPalette'
import './spaceAmbient.css'

// Paper only: sampling chrome would feed the previous palette back into itself.
function visiblePaper(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('.dv-groupview:not(:has(.wb-tab--icon)) .dv-content-container > .dv-react-part, .mb-main')]
    .filter((el) => el.checkVisibility() && el.getBoundingClientRect().width > 20)
    .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]
}

/** Web/mobile fallback: visible DOM surfaces and readable images. Desktop uses
 * composited pixels, which also include canvas and cross-origin media. */
function domPalette(paper: HTMLElement, rect: AmbientRect): AmbientPalette | null {
  const canvas = document.createElement('canvas')
  canvas.width = 6; canvas.height = 9
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.fillStyle = getComputedStyle(paper).backgroundColor
  ctx.fillRect(0, 0, 6, 9)
  const imageCanvas = document.createElement('canvas')
  imageCanvas.width = 1; imageCanvas.height = 1
  const imageCtx = imageCanvas.getContext('2d', { willReadFrequently: true })
  for (let y = 0; y < 9; y++) for (let x = 0; x < 6; x++) {
    const px = rect.x + (x + .5) * rect.width / 6
    const py = rect.y + (y + .5) * rect.height / 9
    const elements = document.elementsFromPoint(px, py).filter((el) => el === paper || paper.contains(el)).reverse()
    for (const el of elements) {
      ctx.fillStyle = getComputedStyle(el).backgroundColor
      ctx.fillRect(x, y, 1, 1)
      if (el instanceof HTMLImageElement && el.complete && el.naturalWidth && imageCtx) {
        try {
          imageCtx.drawImage(el, 0, 0, 1, 1)
          const pixel = imageCtx.getImageData(0, 0, 1, 1).data
          ctx.fillStyle = `rgba(${pixel[0]},${pixel[1]},${pixel[2]},${pixel[3] / 255})`
          ctx.fillRect(x, y, 1, 1)
        } catch { imageCanvas.width = 1 /* discard tainted canvas */ }
      }
    }
  }
  return paletteFromRgba(ctx.getImageData(0, 0, 6, 9).data, 6, 9)
}

function clearPalette(): void {
  for (const band of ['top', 'middle', 'bottom']) document.documentElement.style.removeProperty(`--space-ambient-${band}`)
}

export function useSpaceAmbient(): void {
  const lang = useVisualTheme((s) => s.lang)
  const glass = useVisualTheme((s) => s.glass)
  const mode = useVisualTheme((s) => s.mode)
  const space = useSpaceStore((s) => s.activeSpaceId)
  useEffect(() => () => clearPalette(), [])
  useEffect(() => {
    if (lang !== 'lovable' || !glass) { clearPalette(); return }
    const root = document.documentElement
    let disposed = false
    let running = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // Retain the last palette until the new Space's first capture arrives.
    // Clearing it here would flash neutral chrome on every Space switch.
    const sample = async (): Promise<void> => {
      if (disposed || running || document.hidden) return
      const paper = visiblePaper()
      if (!paper) return
      const box = paper.getBoundingClientRect()
      const rect = { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.min(innerWidth, box.right) - Math.max(0, box.x), height: Math.min(innerHeight, box.bottom) - Math.max(0, box.y) }
      if (rect.width < 16 || rect.height < 16) return
      running = true
      try {
        const palette = window.tangu?.sampleAmbientPalette ? await window.tangu.sampleAmbientPalette(rect) : domPalette(paper, rect)
        if (disposed || document.hidden || !paper.isConnected || !palette) return
        palette.forEach((color, i) => root.style.setProperty(`--space-ambient-${['top', 'middle', 'bottom'][i]}`, color))
      } catch { /* host unavailable; keep last palette */ } finally { running = false }
    }
    // Four updates/second while scrolling; once/second at rest catches canvas/video.
    // Hidden windows do not sample. In-flight results are dropped after Space changes.
    const schedule = (): void => {
      if (disposed || document.hidden || timer) return
      timer = setTimeout(() => { timer = undefined; void sample() }, 260)
    }
    let poll: ReturnType<typeof setInterval> | undefined
    // 隐藏 / 最小化:定时器和每秒轮询都停,回到可见再起(挂载时就是隐藏的窗口也不起)。
    const onVisibility = (): void => {
      if (document.hidden) {
        if (timer) { clearTimeout(timer); timer = undefined }
        if (poll) { clearInterval(poll); poll = undefined }
        return
      }
      poll ??= setInterval(schedule, 1000)
      schedule()
    }
    document.addEventListener('scroll', schedule, true)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('resize', schedule)
    onVisibility()
    return () => {
      disposed = true
      if (poll) clearInterval(poll)
      if (timer) clearTimeout(timer)
      document.removeEventListener('scroll', schedule, true)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', schedule)
    }
  }, [lang, glass, mode, space])
}
