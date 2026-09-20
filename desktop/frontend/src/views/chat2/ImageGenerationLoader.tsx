import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { registerMessages, useI18n } from '../../i18n'
import {
  IMAGE_GENERATION_GRID,
  createSnakeGame,
  queueSnakeDirection,
  stepSnake,
  type SnakeDirection,
  type SnakeGameState,
} from './imageGenerationGame'

registerMessages({
  'imageGeneration.loading': { zh: '正在生成图片…', en: 'Generating image…' },
  'imageGeneration.play': { zh: '点击点阵开启贪吃蛇彩蛋', en: 'Click the dot grid to play Snake' },
  'imageGeneration.controls': { zh: '贪吃蛇：方向键、WASD 或滑动控制方向', en: 'Snake: use arrow keys, WASD, or swipe to steer' },
  'imageGeneration.snake': { zh: '贪吃蛇 · {score}', en: 'Snake · {score}' },
  'imageGeneration.retry': { zh: '撞到了，马上再来一局…', en: 'Game over — restarting…' },
})

const SIZE = 276
const PAD = 12
const CELL = (SIZE - PAD * 2) / (IMAGE_GENERATION_GRID - 1)

function cssToken(canvas: HTMLCanvasElement, name: string, fallback: string): string {
  return getComputedStyle(canvas).getPropertyValue(name).trim() || fallback
}

function prepareCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const width = Math.round(SIZE * dpr)
  if (canvas.width !== width || canvas.height !== width) {
    canvas.width = width
    canvas.height = width
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, SIZE, SIZE)
  return ctx
}

function dotAt(n: number): number { return PAD + n * CELL }

function drawAmbient(canvas: HTMLCanvasElement, time: number): void {
  const ctx = prepareCanvas(canvas)
  if (!ctx) return
  const accent = cssToken(canvas, '--accent-ink', '#4d7ff0')
  const faint = cssToken(canvas, '--text-faint', '#777')
  const phase = time * 0.00042
  const cx = 0.5 + Math.cos(phase * 1.13) * 0.2
  const cy = 0.5 + Math.sin(phase * 0.91) * 0.2

  for (let y = 0; y < IMAGE_GENERATION_GRID; y++) {
    for (let x = 0; x < IMAGE_GENERATION_GRID; x++) {
      const nx = x / (IMAGE_GENERATION_GRID - 1)
      const ny = y / (IMAGE_GENERATION_GRID - 1)
      const dx = nx - cx
      const dy = ny - cy
      const cloud = Math.exp(-(dx * dx / 0.055 + dy * dy / 0.08))
      const ribbonY = 0.5 + Math.sin(nx * 5.7 + phase * 2.2) * 0.17
      const ribbon = Math.exp(-Math.pow(ny - ribbonY, 2) / 0.024) * (0.35 + 0.3 * Math.sin(phase + nx * 3.4))
      const strength = Math.max(0, Math.min(1, cloud * 0.92 + ribbon * 0.42))
      ctx.beginPath()
      ctx.arc(dotAt(x), dotAt(y), 1 + strength * 2.05, 0, Math.PI * 2)
      ctx.fillStyle = strength > 0.16 ? accent : faint
      ctx.globalAlpha = 0.16 + strength * 0.78
      ctx.fill()
    }
  }
  ctx.globalAlpha = 1
}

function drawSnake(canvas: HTMLCanvasElement, game: SnakeGameState): void {
  const ctx = prepareCanvas(canvas)
  if (!ctx) return
  const accent = cssToken(canvas, '--accent-ink', '#4d7ff0')
  const faint = cssToken(canvas, '--text-faint', '#777')
  const bg = cssToken(canvas, '--bg', '#fff')
  const danger = cssToken(canvas, '--danger', '#b85848')

  for (let y = 0; y < IMAGE_GENERATION_GRID; y++) {
    for (let x = 0; x < IMAGE_GENERATION_GRID; x++) {
      ctx.beginPath()
      ctx.arc(dotAt(x), dotAt(y), 1, 0, Math.PI * 2)
      ctx.fillStyle = faint
      ctx.globalAlpha = 0.2
      ctx.fill()
    }
  }
  ctx.globalAlpha = 1

  ctx.beginPath()
  ctx.arc(dotAt(game.food.x), dotAt(game.food.y), CELL * 0.42, 0, Math.PI * 2)
  ctx.fillStyle = danger
  ctx.fill()

  game.body.forEach((part, i) => {
    ctx.beginPath()
    ctx.arc(dotAt(part.x), dotAt(part.y), CELL * (i === 0 ? 0.47 : 0.4), 0, Math.PI * 2)
    ctx.fillStyle = game.alive ? accent : danger
    ctx.globalAlpha = i === 0 ? 1 : Math.max(0.48, 0.94 - i * 0.035)
    ctx.fill()
  })
  ctx.globalAlpha = 1

  const head = game.body[0]
  if (!head) return
  const delta: Record<SnakeDirection, [number, number]> = {
    up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0],
  }
  const [dx, dy] = delta[game.direction]
  const sideX = -dy * CELL * 0.14
  const sideY = dx * CELL * 0.14
  const frontX = dx * CELL * 0.15
  const frontY = dy * CELL * 0.15
  for (const side of [-1, 1]) {
    ctx.beginPath()
    ctx.arc(dotAt(head.x) + frontX + sideX * side, dotAt(head.y) + frontY + sideY * side, 0.85, 0, Math.PI * 2)
    ctx.fillStyle = bg
    ctx.fill()
  }
}

const keyDirection = (key: string): SnakeDirection | null => ({
  ArrowUp: 'up', w: 'up', W: 'up',
  ArrowRight: 'right', d: 'right', D: 'right',
  ArrowDown: 'down', s: 'down', S: 'down',
  ArrowLeft: 'left', a: 'left', A: 'left',
} as Record<string, SnakeDirection>)[key] || null

export function ImageGenerationLoader() {
  const { t } = useI18n()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gameRef = useRef(createSnakeGame())
  const deadRef = useRef(false)
  const pointerRef = useRef<{ x: number; y: number } | null>(null)
  const [playing, setPlaying] = useState(false)
  const [score, setScore] = useState(0)
  const [dead, setDead] = useState(false)

  useEffect(() => {
    if (playing) return
    const canvas = canvasRef.current
    if (!canvas) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    let raf = 0
    let last = -Infinity
    const frame = (time: number): void => {
      if (time - last >= 32) { drawAmbient(canvas, reduced.matches ? 0 : time); last = time }
      if (!reduced.matches) raf = requestAnimationFrame(frame)
    }
    frame(0)
    const redraw = (): void => {
      cancelAnimationFrame(raf)
      last = -Infinity
      frame(performance.now())
    }
    reduced.addEventListener?.('change', redraw)
    const theme = new MutationObserver(redraw)
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-mode', 'data-skin', 'data-bg', 'data-theme'] })
    return () => {
      cancelAnimationFrame(raf)
      reduced.removeEventListener?.('change', redraw)
      theme.disconnect()
    }
  }, [playing])

  useEffect(() => {
    if (!playing) return
    const canvas = canvasRef.current
    if (!canvas) return
    drawSnake(canvas, gameRef.current)
    let restart = 0
    const tick = window.setInterval(() => {
      if (deadRef.current) return
      const next = stepSnake(gameRef.current)
      gameRef.current = next
      setScore(next.score)
      drawSnake(canvas, next)
      if (!next.alive) {
        deadRef.current = true
        setDead(true)
        restart = window.setTimeout(() => {
          const fresh = createSnakeGame()
          gameRef.current = fresh
          deadRef.current = false
          setDead(false)
          setScore(0)
          drawSnake(canvas, fresh)
        }, 900)
      }
    }, 118)
    return () => { window.clearInterval(tick); window.clearTimeout(restart) }
  }, [playing])

  const start = useCallback(() => {
    if (playing) return
    const fresh = createSnakeGame()
    gameRef.current = fresh
    deadRef.current = false
    setScore(0)
    setDead(false)
    setPlaying(true)
  }, [playing])

  const steer = useCallback((direction: SnakeDirection) => {
    gameRef.current = queueSnakeDirection(gameRef.current, direction)
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const direction = keyDirection(event.key)
    if (!direction) return
    event.preventDefault()
    if (!playing) start()
    steer(direction)
  }

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
    pointerRef.current = { x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const onPointerUp = (event: PointerEvent<HTMLButtonElement>): void => {
    const from = pointerRef.current
    pointerRef.current = null
    if (!from || !playing) return
    const dx = event.clientX - from.x
    const dy = event.clientY - from.y
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 18) return
    steer(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'))
  }

  const label = dead ? t('imageGeneration.retry') : playing ? t('imageGeneration.snake', { score }) : t('imageGeneration.loading')
  return (
    <div className={`image-generation-loader${playing ? ' playing' : ''}`} data-image-generation={playing ? 'snake' : 'ambient'}>
      <div className="image-generation-status" role="status" aria-live="polite">{label}</div>
      <button
        type="button"
        className="image-generation-stage"
        aria-label={t(playing ? 'imageGeneration.controls' : 'imageGeneration.play')}
        title={t(playing ? 'imageGeneration.controls' : 'imageGeneration.play')}
        onClick={start}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      >
        <canvas ref={canvasRef} className="image-generation-canvas" aria-hidden="true" />
      </button>
    </div>
  )
}
