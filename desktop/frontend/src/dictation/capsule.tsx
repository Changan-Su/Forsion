/**
 * 语音输入胶囊(dictation.html 的入口)。桌面作用域 · 下居中 · 不抢焦点(窗口在 electron/dictation/capsuleWindow.ts)。
 * 只做三件事:按主进程的状态开 / 停录音(复用 useVoiceInput:流式转写 + 不支持流式时整段转写),把这一次听写的文字交回主进程,
 * 写不进去时给「复制」。往哪写、怎么写都不归它 —— 它拿不到那个接口(preload 是只给听写的 dictationPreload)。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { registerMessages, translate, translateFor } from '../i18n'
import { useVoiceInput } from '../hooks/useVoiceInput'
import type { DictationCapsuleAction, DictationFailure, DictationState } from '../../../shared/dictation'
import '../styles/base.css'
import './capsule.css'

interface CapsuleBridge {
  onState(cb: (s: DictationState) => void): () => void
  result(sessionId: string, text: string): void
  error(sessionId: string, message: string): void
  action(sessionId: string, action: DictationCapsuleAction): void
}
const bridge = (window as unknown as { forsionDictation?: CapsuleBridge }).forsionDictation

registerMessages({
  'dictation.capsule.label': { zh: '语音输入', en: 'Voice input' },
  'dictation.capsule.listening': { zh: '正在听… · Esc 取消', en: 'Listening… · Esc to cancel' },
  'dictation.capsule.finishing': { zh: '正在转写…', en: 'Transcribing…' },
  'dictation.capsule.inserting': { zh: '正在写入…', en: 'Inserting…' },
  'dictation.capsule.done': { zh: '已写入', en: 'Inserted' },
  'dictation.capsule.copied': { zh: '已复制，可以粘贴了', en: 'Copied — paste it where you need it' },
  'dictation.capsule.stop': { zh: '完成', en: 'Done' },
  'dictation.capsule.cancel': { zh: '取消', en: 'Cancel' },
  'dictation.capsule.close': { zh: '关闭', en: 'Close' },
  'dictation.capsule.copy': { zh: '复制', en: 'Copy' },
  'dictation.capsule.allow': { zh: '去允许', en: 'Allow…' },
  'dictation.fail.target-changed': { zh: '前台换了应用，没有写入', en: 'The app in front changed, so nothing was typed' },
  'dictation.fail.secure-field': { zh: '不往密码框里写', en: "Won't type into a password field" },
  'dictation.fail.still-typing': { zh: '键盘一直没停，没有写入', en: 'You kept typing, so nothing was inserted' },
  'dictation.fail.no-permission': { zh: '要写进别的应用，请在辅助功能里允许 Forsion', en: 'Allow Forsion in Accessibility to type into other apps' },
  'dictation.fail.no-field': { zh: '没认出能写的输入框', en: "Couldn't find a text field to type into" },
  'dictation.fail.paste-failed': { zh: '没能写入', en: "Couldn't insert the text" },
  'dictation.fail.empty': { zh: '没听清', en: "Didn't catch that" },
  'dictation.fail.capture': { zh: '录音没成功', en: 'Recording failed' },
  'dictation.fail.unsupported': { zh: '这里没法往别的应用里写', en: "Can't type into other apps here" },
})

function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  )
}
const ICON = {
  x: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  copy: 'M8 8h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM4 16V5a1 1 0 0 1 1-1h11',
}

/** 电平条:五根,跟着 AnalyserNode 走;减少动态效果时静止。 */
function Level({ analyser, active }: { analyser: AnalyserNode | null; active: boolean }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !analyser || !active || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const bins = new Uint8Array(analyser.frequencyBinCount)
    const bars = [...el.children] as HTMLElement[]
    let raf = 0
    const tick = (): void => {
      analyser.getByteFrequencyData(bins)
      bars.forEach((b, i) => {
        const v = bins[2 + i * 3] / 255
        b.style.transform = `scaleY(${(0.25 + v * 0.75).toFixed(3)})`
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); bars.forEach((b) => { b.style.transform = '' }) }
  }, [analyser, active])
  return <span className="dcap-level" ref={ref} aria-hidden><i /><i /><i /><i /><i /></span>
}

function Capsule() {
  const [state, setState] = useState<DictationState | null>(null)
  const sid = state?.sessionId ?? ''
  const phase = state?.phase ?? 'idle'
  const lang = state?.locale ?? 'zh'
  const t = (k: string): string => translateFor(lang, k)
  // 这一次录音属于哪个会话。useVoiceInput 在开始录音时定格回调,所以回调按会话号绑死:上一次的转写晚到(下一次已经开录)
  // 时 recordingFor 已换成新会话,对不上就丢 —— 绝不当成新会话的结果交上去(主进程会把它写进新会话的目标)。
  const recordingFor = useRef('')
  const delivered = useRef('')
  const onResult = useCallback((text: string) => {
    const id = sid
    if (!id || recordingFor.current !== id || delivered.current === id) return
    delivered.current = id
    bridge?.result(id, text)
  }, [sid])
  const voice = useVoiceInput(onResult, sid || 'idle')

  useEffect(() => bridge?.onState((s) => {
    try {
      // 主窗里改了明暗 / 扁平:每次出现时跟上(同源 localStorage)
      const root = document.documentElement
      const forced = localStorage.getItem('forsion_theme_forced_scheme')
      const pref = forced === 'light' || forced === 'dark' || forced === 'system' ? forced : localStorage.getItem('forsion_theme_pref')
      const mode = pref === 'dark' || pref === 'light' ? pref : pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : root.dataset.mode || 'light'
      root.dataset.mode = mode
      root.classList.toggle('dark', mode === 'dark')
      root.lang = s.locale === 'zh' ? 'zh-CN' : 'en'
    } catch { /* 保持首屏那份 */ }
    setState(s)
  }), [])

  // 按主进程的状态开 / 停
  const started = useRef('')
  useEffect(() => {
    if (!sid) return
    if (phase === 'listening' && started.current !== sid && !voice.recording && !voice.busy) {
      started.current = sid
      recordingFor.current = sid
      delivered.current = ''
      voice.toggle()
    } else if (phase === 'finishing' && voice.recording) {
      voice.toggle()
    }
  }, [sid, phase, voice])
  // 这一次真正开始录音的时刻:刚开就停(连按两下快捷键)那点音频转不出字,按「没听清」算,不把解码器的原话甩给用户
  const recordedAt = useRef(0)
  useEffect(() => { if (voice.recording) recordedAt.current = Date.now() }, [voice.recording])
  // 开不起来(麦克风被拒 / 没设备)或停下以后没有交出文字:告诉主进程,别让它干等
  const prevBusy = useRef(false)
  useEffect(() => {
    const id = recordingFor.current
    const wasBusy = prevBusy.current
    prevBusy.current = voice.busy || voice.recording
    if (!id || id !== sid || delivered.current === id || voice.recording || voice.busy) return
    if (phase !== 'listening' && phase !== 'finishing') return
    if (!voice.error && !wasBusy) return
    delivered.current = id
    const tooShort = wasBusy && recordedAt.current > 0 && Date.now() - recordedAt.current < 1500
    if (!voice.error || voice.error === translate('voiceinput.unclear') || tooShort) bridge?.result(id, '')
    else bridge?.error(id, voice.error)
  }, [voice.error, voice.busy, voice.recording, sid, phase])

  // 字短的时候从左边起;超出一行才贴右、左端淡出(看得见最新说的那几个字)
  const textRef = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    const el = textRef.current
    const line = el?.firstElementChild as HTMLElement | null
    setOverflow(!!el && !!line && line.scrollWidth > el.clientWidth + 1)
  }, [voice.preview, phase])

  if (!state || phase === 'idle') return null
  const act = (a: DictationCapsuleAction) => () => bridge?.action(sid, a)
  const failure: DictationFailure | undefined = state.failure
  const preview = voice.preview
  const live = preview && (preview.text || preview.pending)

  let body: ReactElement
  if (phase === 'listening' || phase === 'finishing') {
    body = (
      <>
        <Level analyser={voice.analyser} active={phase === 'listening'} />
        <span className="dcap-text" ref={textRef} data-overflow={live && overflow ? '' : undefined}>
          {live
            ? <span className="dcap-line">{preview!.text}<span className="dcap-pending">{preview!.pending}</span></span>
            : <span className="dcap-hint">{phase === 'listening' ? t('dictation.capsule.listening') : t('dictation.capsule.finishing')}</span>}
        </span>
        {phase === 'listening' && (
          <button type="button" className="dcap-btn dcap-primary" onClick={act('stop')}>{t('dictation.capsule.stop')}</button>
        )}
        <button type="button" className="dcap-icon" aria-label={t('dictation.capsule.cancel')} title={t('dictation.capsule.cancel')} onClick={act('cancel')}><Icon d={ICON.x} /></button>
      </>
    )
  } else if (phase === 'inserting') {
    body = <span className="dcap-text"><span className="dcap-hint">{t('dictation.capsule.inserting')}</span></span>
  } else if (phase === 'done') {
    body = (
      <>
        <span className="dcap-mark" data-ok=""><Icon d={ICON.check} /></span>
        <span className="dcap-text"><span className="dcap-hint">{state.copied ? t('dictation.capsule.copied') : t('dictation.capsule.done')}</span></span>
      </>
    )
  } else {
    const msg = failure === 'capture' && state.message ? state.message : t(`dictation.fail.${failure ?? 'paste-failed'}`)
    body = (
      <>
        <span className="dcap-mark"><Icon d={ICON.alert} /></span>
        <span className="dcap-text" title={msg}><span className="dcap-hint dcap-msg">{msg}</span></span>
        {failure === 'no-permission' && (
          <button type="button" className="dcap-btn" onClick={act('allow')}>{t('dictation.capsule.allow')}</button>
        )}
        {state.text && (
          <button type="button" className="dcap-btn dcap-primary" onClick={act('copy')}><Icon d={ICON.copy} size={14} />{t('dictation.capsule.copy')}</button>
        )}
        <button type="button" className="dcap-icon" aria-label={t('dictation.capsule.close')} title={t('dictation.capsule.close')} onClick={act('dismiss')}><Icon d={ICON.x} /></button>
      </>
    )
  }
  return (
    <div className="dcap" role="status" aria-live="polite" aria-label={t('dictation.capsule.label')} data-phase={phase} data-failure={failure}>
      {body}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Capsule />)
