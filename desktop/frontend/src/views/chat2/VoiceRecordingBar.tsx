/**
 * 录音内联条:录音时「就地替换」输入框底排(+ 号保留、其余控件让位),不再浮在上方。
 * 波形随时间从右往左连续滚动(最新采样在最右,x = 右缘 − (now − t)×速度,逐帧连续 = 丝滑);
 * 静音处只剩虚线基线。■ = 停止并转写入框、↑ = 停止转写并立即发送(均由父组件接线)。
 */
import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Loader2, Square } from 'lucide-react'

interface Props {
  analyser: AnalyserNode | null
  recording: boolean
  busy: boolean
  onStop: () => void
  /** 缺省 = 不出 ↑(实时对话:说完自动发)。 */
  onSend?: () => void
  /** 给了就替换计时(实时对话的「聆听中 / 转写中」);■ 的 title 同步用 stopTitle。 */
  status?: string
  stopTitle?: string
  t: (k: string, p?: Record<string, unknown>) => string
}

const STEP_MS = 40      // 每 40ms 落一根柱
const PX_PER_MS = 0.1   // 滚动速度 ≈100px/s → 柱距 4px
const GAIN = 3.2        // 语音时域 RMS 偏小,放大到可见

export function VoiceRecordingBar({ analyser, recording, busy, onStop, onSend, status, stopTitle, t }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [sec, setSec] = useState(0)

  // 计时:录音开始(上升沿)清零、每 0.25s 刷新;停止后保留末值。
  const startedRef = useRef(0)
  useEffect(() => {
    if (!recording) return
    startedRef.current = Date.now()
    setSec(0)
    const id = window.setInterval(() => setSec(Math.floor((Date.now() - startedRef.current) / 1000)), 250)
    return () => window.clearInterval(id)
  }, [recording])

  // 滚动波形:rAF 每帧读当前音量落柱 + 按 (now − t) 连续左移重绘。
  useEffect(() => {
    const canvas = canvasRef.current
    if (!analyser || !recording || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, canvas.clientWidth) * dpr
    canvas.height = Math.max(1, canvas.clientHeight) * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0) // 之后一律按 CSS px 作画
    const css = getComputedStyle(document.documentElement)
    const accent = (css.getPropertyValue('--accent-ink') || css.getPropertyValue('--accent') || '#7c3aed').trim()
    const lineColor = (css.getPropertyValue('--border') || 'rgba(127,127,127,0.4)').trim()
    const buf = new Uint8Array(analyser.fftSize)
    const bars: { t: number; level: number }[] = []
    let lastPush = Date.now()
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const now = Date.now()
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) { const d = (buf[i] - 128) / 128; sum += d * d }
      const level = Math.min(1, Math.sqrt(sum / buf.length) * GAIN)
      while (now - lastPush >= STEP_MS) { bars.push({ t: lastPush, level }); lastPush += STEP_MS }
      const W = canvas.clientWidth, H = canvas.clientHeight, cy = H / 2
      ctx.clearRect(0, 0, W, H)
      // 虚线基线(整条时间轴)
      ctx.strokeStyle = lineColor; ctx.lineWidth = 1; ctx.setLineDash([2, 3])
      ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke()
      ctx.setLineDash([])
      // 柱:最右 = 最新;剪掉滚出左缘的
      while (bars.length && W - (now - bars[0].t) * PX_PER_MS < -4) bars.shift()
      ctx.fillStyle = accent
      for (const b of bars) {
        const x = W - (now - b.t) * PX_PER_MS
        if (x < -4 || x > W) continue
        const h = Math.max(2, b.level * (H - 4))
        ctx.globalAlpha = x < W * 0.15 ? Math.max(0, x / (W * 0.15)) : 1 // 近左缘淡出融进虚线
        ctx.beginPath()
        ctx.roundRect(x - 1.1, cy - h / 2, 2.2, h, 1.1)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [analyser, recording])

  const time = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`

  if (busy) {
    return (
      <div className="t2c-voicebar">
        <Loader2 size={14} className="spin" />
        <span className="t2c-voicelabel">{t('input.micBusy')}</span>
        <span className="t2c-grow" />
      </div>
    )
  }
  return (
    <div className="t2c-voicebar">
      <canvas ref={canvasRef} className="t2c-voicewave" />
      <span className="t2c-voicetime">{status ?? time}</span>
      <button className="t2c-voicestop" title={stopTitle ?? t('input.micStop')} onClick={onStop}><Square size={12} /></button>
      {onSend && <button className="t2c-send" title={t('input.send')} onClick={onSend}><ArrowUp size={16} /></button>}
    </div>
  )
}
