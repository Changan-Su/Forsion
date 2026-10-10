/**
 * 语音通话的 Mini 卡片(10-02 用户定:通话像打电话那样单独一个小窗,显示 Agent 头像,可挂断、选麦克风 / 扬声器 / Effort)。
 * 输入框的电话键只负责把会话与委派参数算好,经 openMini 直达这里;WebSocket、麦克风、放音都跑在 Mini 这个渲染进程里,
 * 关窗 = 渲染进程销毁 = 通话结束,不会留僵尸通话。聊天区在主窗:双方转写与代跑 run 由引擎落库,经 CALL_EVENT_KEY 叫主窗拉一次。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Brain, Mic, MicOff, PhoneOff, Volume2 } from 'lucide-react'
import type { ViewProps } from '@lcl/engine'
import { useApp } from '../stores/appStore'
import { registerMessages, useI18n } from '../i18n'
import { THINKING_LEVELS, type AgentConfig, type ThinkingLevel } from '../types'
import { thinkingLabel } from '../components/thinkingLabel'
import { AgentAvatar } from '../components/AgentAvatar'
import { homeTarget } from '../services/engine/targets'
import { CALL_ENDED_BACKGROUND, CALL_TEXT_FRESH_MS, endCall, getCall, getCallError, getCallPresence, onCallEvent, postCallEvent, sendCallText, setCallMic, setCallPresence, setCallSpeaker, startCall, subscribeCall, toggleMute, updateCallRun, type StartCallOptions } from '../services/realtimeCall'
import './voiceCall.css'

registerMessages({
  'livecall.title': { zh: '语音通话', en: 'Voice call' },
  'livecall.connecting': { zh: '正在接通…', en: 'Connecting…' },
  'livecall.reconnecting': { zh: '信号断了一下，正在重新接通…', en: 'Connection dropped, reconnecting…' },
  'livecall.serviceError': { zh: '语音服务出错，可以重新拨打', en: 'the voice service hit an error. You can call again' },
  'livecall.quotaExhausted': { zh: '额度用完了', en: 'you are out of quota' },
  'livecall.signInExpired': { zh: '登录已失效，请重新登录 Forsion 后再拨', en: 'your Forsion sign-in has expired. Sign in again, then call' },
  'livecall.replaced': { zh: '这个账号又打了一通新的，这一通已挂断', en: 'a newer call started on this account' },
  'livecall.listening': { zh: '正在听', en: 'Listening' },
  'livecall.thinking': { zh: '在想…', en: 'Thinking…' },
  'livecall.speaking': { zh: '正在说', en: 'Speaking' },
  'livecall.working': { zh: 'Tangu 处理中…', en: 'Tangu is working…' },
  'livecall.muted': { zh: '已静音', en: 'Muted' },
  'livecall.mute': { zh: '静音', en: 'Mute' },
  'livecall.unmute': { zh: '取消静音', en: 'Unmute' },
  'livecall.end': { zh: '挂断', en: 'Hang up' },
  'livecall.close': { zh: '关闭', en: 'Close' },
  'livecall.failed': { zh: '通话结束：{e}', en: 'Call ended: {e}' },
  'livecall.mic': { zh: '麦克风', en: 'Microphone' },
  'livecall.speaker': { zh: '扬声器', en: 'Speaker' },
  'livecall.effort': { zh: 'Effort（Tangu 办事时的思考档位）', en: 'Effort (thinking level when Tangu works)' },
  'livecall.systemDefault': { zh: '系统默认', en: 'System default' },
  'livecall.endedBackground': { zh: '离开 Forsion 后通话已挂断', en: 'it hung up when you left Forsion' },
})

/** 通话为什么结束:常见的几种说人话(Forsion 云端中转的拒绝 / 挂断以 `<4xx> …` 回来),其余原样给。 */
export function callEndText(error: string, t: (key: string) => string): string {
  if (error === CALL_ENDED_BACKGROUND) return t('livecall.endedBackground')
  if (/token_quota_exceeded/.test(error)) return t('livecall.quotaExhausted')
  if (/^<401>/.test(error)) return t('livecall.signInExpired')
  if (/^<409>/.test(error)) return t('livecall.replaced')
  if (/^<5\d{4}>|InternalError|ModelServingError/.test(error)) return t('livecall.serviceError')
  return error
}

/** 设备选择跟着这台电脑走(不进会话配置):localStorage,拔掉的设备由 getUserMedia 自己退回默认。 */
const DEVICES_KEY = 'forsion_voice_call_devices'
function readDevices(): { mic: string; speaker: string } {
  try { const v = JSON.parse(localStorage.getItem(DEVICES_KEY) || '{}'); return { mic: String(v.mic || ''), speaker: String(v.speaker || '') } } catch { return { mic: '', speaker: '' } }
}
function saveDevices(v: { mic: string; speaker: string }): void {
  try { localStorage.setItem(DEVICES_KEY, JSON.stringify(v)) } catch { /* ignore */ }
}

const fmtDuration = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** 换会话 = 整张卡重来(新的委派参数、档位、计时);同会话再按电话键只是 Mini 更新同一 leaf 的参数,不重挂、不重拨。 */
export function VoiceCallView(props: ViewProps) {
  const sessionId = typeof props.params.sessionId === 'string' ? props.params.sessionId : ''
  return <CallCard key={sessionId} sessionId={sessionId} params={props.params} />
}

/**
 * 手机:没有 Mini 窗,同一张通话卡压成页面顶上的一条(MobileRoot 挂载,参数来自 services/realtimeCall 的 openCallLayer)。
 * 不做成整屏:聊天区要照常可用 —— 看得到双方的话、批得了 Tangu 要做的操作(待批卡出在输入框上方)、打的字照样进电话。
 * 条上没有设备与 Effort 三行:走哪个听筒 / 扬声器归系统管,档位跟输入框里这个会话的设置走。
 */
export function VoiceCallBar({ params, onClose }: { params: ViewProps['params']; onClose: () => void }) {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
  // dial:见 openCallLayer —— 上一通收线之后再按电话键要重拨,光按会话 id 认会停在那条报错上。
  return <CallCard key={`${sessionId}:${params.dial}`} sessionId={sessionId} params={params} onClose={onClose} />
}

/** onClose 给了 = 页面里的那一条(手机);没给 = Mini 窗里的整张卡,关闭即关窗。 */
function CallCard({ sessionId, params, onClose }: { sessionId: string; params: ViewProps['params']; onClose?: () => void }) {
  const bar = !!onClose
  const close = onClose ?? ((): void => window.tangu?.closeSelf?.())
  const { t } = useI18n()
  const call = useSyncExternalStore(subscribeCall, getCall)
  const error = useSyncExternalStore(subscribeCall, getCallError)
  const runRef = useRef(params.run as StartCallOptions['run'] | undefined)
  const [devices, setDevices] = useState(readDevices)
  const [level, setLevel] = useState<ThinkingLevel | ''>(() => ((runRef.current?.agent_config as AgentConfig | undefined)?.thinkingLevel || ''))
  const agentSlug = typeof params.agentSlug === 'string' ? params.agentSlug : ''
  const agent = useApp((s) => s.agentDefs.find((a) => a.slug === agentSlug))
  const avatar = useApp((s) => (agentSlug ? s.agentAvatars[agentSlug] : undefined))
  const name = agent?.name || 'Tangu'
  const effLevel = level || agent?.thinkingLevel || 'medium'

  useEffect(() => {
    const run = runRef.current
    if (sessionId && run && typeof params.model === 'string') {
      void startCall({
        target: homeTarget(), sessionId, model: params.model, voice: typeof params.voice === 'string' ? params.voice : undefined,
        title: typeof params.title === 'string' ? params.title : '', run, micId: devices.mic, speakerId: devices.speaker,
        onActivity: () => postCallEvent({ kind: 'activity', sessionId }),
        onTranscriptFix: (messageId, text) => postCallEvent({ kind: 'transcript', sessionId, messageId, text }),
      })
    }
    return () => endCall()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- 一张卡一通电话;设备 / 档位走各自的通话中接口

  // 对方正常收线(没报错)就收起卡片;报错的留着,让人看清原因再关。
  const hadCall = useRef(false)
  useEffect(() => {
    if (call) hadCall.current = true
    else if (hadCall.current && !error) close()
  }, [call, error]) // eslint-disable-line react-hooks/exhaustive-deps -- close 每次渲染都是新函数,指的是同一件事

  // 条上没有 Effort 那一行:输入框里改了这个会话的设置(档位、审批档、模型…),之后委派的 run 跟着走。
  // 模型不在会话配置里 —— 药丸上换模型改的是会话行的 model_id,得另订一份(Codex 10-10:只订配置时,通话中换了模型,委派出去的还是旧的)。
  const sessionCfg = useApp((s) => (bar ? s.configBySession[sessionId] : undefined))
  const sessionModel = useApp((s) => (bar ? s.sessions.find((x) => x.id === sessionId)?.model_id : undefined))
  useEffect(() => {
    if (!bar) return
    const p = useApp.getState().voiceRunParams(sessionId)
    runRef.current = { model_id: p.modelId, agent_config: p.agentConfig }
    updateCallRun(runRef.current)
  }, [bar, sessionCfg, sessionModel, sessionId])

  // 接通后登记「这个会话在通话」,主窗输入框据此把打的字送进来;收线 / 关窗撤销(崩了没撤,主窗等不到确认会自己清)。
  // 重连中收不下打的字:撤掉登记让主窗直接发 Tangu(不用等 2s 超时),接回来再登记 —— 超时那条路会把登记清掉且再也不补(Codex 10-02)。
  const live0 = !!call?.connectedAt && call.phase !== 'reconnecting'
  useEffect(() => {
    if (!live0) return
    setCallPresence(sessionId)
    const clear = (): void => { if (getCallPresence() === sessionId) setCallPresence(null) }
    window.addEventListener('pagehide', clear)
    const off = onCallEvent((e) => {
      if (e.kind === 'text' && e.sessionId === sessionId && Date.now() - e.at < CALL_TEXT_FRESH_MS && sendCallText(e.text)) postCallEvent({ kind: 'text-ack', id: e.id })
    })
    return () => { off(); window.removeEventListener('pagehide', clear); clear() }
  }, [live0, sessionId])

  // 头像光环跟着真实声音动:说话时读模型输出,其余读麦克风。直接写 CSS 变量,不走 React 渲染。
  const ringRef = useRef<HTMLDivElement>(null)
  const analyser = call?.analyser
  useEffect(() => {
    const el = ringRef.current
    if (!el || !analyser) { el?.style.setProperty('--vc-level', '0'); return }
    const buf = new Uint8Array(analyser.fftSize)
    let raf = 0
    const tick = (): void => {
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v }
      el.style.setProperty('--vc-level', Math.min(1, Math.sqrt(sum / buf.length) * 4).toFixed(3))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [analyser])

  // 通话计时
  const [now, setNow] = useState(Date.now())
  const connectedAt = call?.connectedAt
  useEffect(() => {
    if (!connectedAt) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [connectedAt])

  // 设备清单:接通(拿到麦克风授权)后才有名字;插拔耳机实时刷新。
  const [list, setList] = useState<MediaDeviceInfo[]>([])
  useEffect(() => {
    const md = navigator.mediaDevices
    if (!md?.enumerateDevices) return
    const load = (): void => { void md.enumerateDevices().then(setList).catch(() => {}) }
    load()
    md.addEventListener('devicechange', load)
    return () => md.removeEventListener('devicechange', load)
  }, [connectedAt])
  // Chromium 额外列出的 default / communications 伪设备与「系统默认」重复,去掉。
  const options = (kind: MediaDeviceKind) => list.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')

  const pickMic = (id: string): void => {
    const next = { ...devices, mic: id }
    setDevices(next); saveDevices(next)
    void setCallMic(id).catch((e) => console.warn('[voice-call] switch mic failed:', e))
  }
  const pickSpeaker = (id: string): void => {
    const next = { ...devices, speaker: id }
    setDevices(next); saveDevices(next)
    void setCallSpeaker(id)
  }
  // Effort = 这个会话的思考档位(与输入框同一个设置):落会话配置、通知主窗同步缓存、之后的委派 run 按新档跑。
  const pickEffort = (lv: ThinkingLevel): void => {
    setLevel(lv)
    useApp.getState().setSessionThinking(lv, sessionId)
    postCallEvent({ kind: 'effort', sessionId, level: lv })
    const run = runRef.current
    if (run) {
      runRef.current = { ...run, agent_config: { ...run.agent_config, thinkingLevel: lv, ...(lv !== 'max' ? { ultra: undefined } : {}) } }
      updateCallRun(runRef.current)
    }
  }

  const hangUp = (): void => {
    endCall()
    close()
  }

  // 百炼服务端错误(<50002> InternalError…)原文太长也看不懂:说人话,原文放悬停里。
  const status = error ? t('livecall.failed', { e: callEndText(error, t) })
    : !call ? ''
    : call.phase === 'connecting' ? t('livecall.connecting')
    : call.phase === 'reconnecting' ? t('livecall.reconnecting')
    : call.phase === 'speaking' ? t('livecall.speaking')
    : call.working ? t('livecall.working')
    : call.muted ? t('livecall.muted')
    : call.phase === 'thinking' ? t('livecall.thinking') : t('livecall.listening')
  const live = !!call && !error
  const activity = !call ? 'idle' : call.muted ? 'muted' : call.working && call.phase !== 'speaking' ? 'working' : call.phase

  const portrait = (
    <div className="vc-portrait" ref={ringRef}>
      <span className="vc-halo" aria-hidden="true" />
      <AgentAvatar name={name} url={avatar} fill className="vc-avatar" />
    </div>
  )
  const statusLine = (
    <div className={`vc-status${error ? ' is-error' : ''}`} title={error || call?.working || undefined} role="status">
      <span className="vc-status-text">{status}</span>
      {live && connectedAt ? <span className="vc-timer">{fmtDuration(now - connectedAt)}</span> : null}
    </div>
  )
  const muteButton = (
    <button className="vc-btn vc-mute" aria-pressed={!!call?.muted} disabled={!live}
      title={call?.muted ? t('livecall.unmute') : t('livecall.mute')} aria-label={call?.muted ? t('livecall.unmute') : t('livecall.mute')}
      onClick={toggleMute}>
      {call?.muted ? <MicOff size={18} /> : <Mic size={18} />}
    </button>
  )
  const hangUpButton = (
    <button className="vc-btn vc-hangup" title={live ? t('livecall.end') : t('livecall.close')} aria-label={live ? t('livecall.end') : t('livecall.close')} onClick={hangUp}>
      <PhoneOff size={18} />
    </button>
  )

  if (bar) {
    return (
      <div className="voice-call vc-bar" data-phase={activity} role="group" aria-label={t('livecall.title')}>
        {portrait}
        <div className="vc-bar-text">
          <div className="vc-name">{name}</div>
          {statusLine}
        </div>
        {muteButton}
        {hangUpButton}
      </div>
    )
  }

  return (
    <div className="mini-native voice-call" data-phase={activity}>
      <div className="vc-stage">
        {portrait}
        <div className="vc-name">{name}</div>
        {statusLine}
      </div>
      <div className="vc-settings">
        <label className="mini-native-bar vc-row" title={t('livecall.mic')}>
          <Mic size={14} aria-hidden="true" />
          <select aria-label={t('livecall.mic')} value={devices.mic} onChange={(e) => pickMic(e.target.value)}>
            <option value="">{t('livecall.systemDefault')}</option>
            {options('audioinput').map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 8)}</option>)}
          </select>
        </label>
        <label className="mini-native-bar vc-row" title={t('livecall.speaker')}>
          <Volume2 size={14} aria-hidden="true" />
          <select aria-label={t('livecall.speaker')} value={devices.speaker} onChange={(e) => pickSpeaker(e.target.value)}>
            <option value="">{t('livecall.systemDefault')}</option>
            {options('audiooutput').map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 8)}</option>)}
          </select>
        </label>
        <label className="mini-native-bar vc-row" title={t('livecall.effort')}>
          <Brain size={14} aria-hidden="true" />
          <select aria-label={t('livecall.effort')} value={effLevel} onChange={(e) => pickEffort(e.target.value as ThinkingLevel)}>
            {THINKING_LEVELS.map((lv) => <option key={lv} value={lv}>{thinkingLabel(lv, t)}</option>)}
          </select>
        </label>
      </div>
      <div className="vc-controls">
        {muteButton}
        {hangUpButton}
      </div>
    </div>
  )
}
