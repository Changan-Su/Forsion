/**
 * 朗读服务:markdown 清洗 → POST /agent/tts 合成(backendService.synthesizeTts,目标由调用方给:home 类)→ 单例 <audio> 播放。
 * 同一时刻全应用只播一段(speak 新的自动停旧的);状态经 subscribe 通知,按钮订阅刷新三态。
 * 状态按任意 key 记(2026-11-21 起;聊天消息照旧用消息 id,划线朗读 `sel:…`,插件 `plugin:<id>:…` —— 各自加前缀,
 * 「被删的消息正在念」那类按 key 比的检查不会认错)。`msgId` 是旧名,等于 key,留给还在读它的地方。
 * 仅在 stored.ttsModelId 非空时可用(设置「语音朗读」配置;cloudWeb 无 window.tangu 配置 → 天然不可用)。
 */
import type { StoredDesktopConfig } from '../types'
import { synthesizeTts } from './backendService'
import type { EngineTarget } from './engine/targets'

export type TtsState = { key: string; /** @deprecated 同 key */ msgId: string; phase: 'loading' | 'playing' } | null

let audioEl: HTMLAudioElement | null = null
let currentUrl: string | null = null
let state: TtsState = null
let seq = 0 // speak/stop 竞态令牌:慢合成返回时若已被新动作取代则丢弃
let inflight: AbortController | null = null // stop/新 speak 时中止在飞合成(链路直达 provider,别让被弃请求继续计费)
let settle: (() => void) | null = null // 当前这一段的「念完了」:放完 / 被停 / 被新的顶掉时兑现(speakKey 的返回值等它)
const endCurrent = (): void => { const f = settle; settle = null; f?.() }
const listeners = new Set<(s: TtsState) => void>()

function emit(s: TtsState): void {
  state = s
  listeners.forEach((l) => l(s))
}

export function subscribeTts(fn: (s: TtsState) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function ttsState(): TtsState {
  return state
}

/** markdown → 可朗读纯文本:代码块整块跳过,链接/图片留文字,剥常见记号;上限 4000 字。 */
export function speakableText(md: string): string {
  return md
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__|~~)/g, '')
    .replace(/\|/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000)
}

function releaseAudio(): void {
  if (audioEl) {
    audioEl.pause()
    audioEl.removeAttribute('src')
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl)
    currentUrl = null
  }
}

/** 停。给了 key 就只在正念着的是它时才停(插件只停自己的,别把聊天朗读也掐了)。 */
export function stopSpeaking(key?: string): void {
  if (key != null && state?.key !== key) return
  seq++
  inflight?.abort()
  inflight = null
  releaseAudio()
  emit(null)
  endCurrent()
}

/** 设置页「试听」:用给定配置合成一句短文本并播放;独立于消息朗读状态机,失败抛错给调用方展示。 */
export async function previewTts(t: EngineTarget, opts: { model: string; voice?: string; speed?: number }, text: string): Promise<void> {
  const blob = await synthesizeTts(t, {
    text, model: opts.model,
    ...(opts.voice ? { voice: opts.voice } : {}),
    ...(opts.speed && opts.speed !== 1 ? { speed: opts.speed } : {}),
  })
  const url = URL.createObjectURL(blob)
  const a = new Audio(url)
  a.onended = () => URL.revokeObjectURL(url)
  a.onerror = () => URL.revokeObjectURL(url)
  await a.play()
}

/** 朗读实际用的配置:用户从没动过朗读模型、已登录、后台给了项目默认 → 跟随后台(只算出来,不落盘,后台改了会跟着变)。 */
export function effectiveTtsConfig<T extends StoredDesktopConfig>(stored: T | null | undefined, catalog: { ttsModelId?: string | null; ttsVoice?: string | null } | null | undefined, signedIn: boolean): T | null {
  if (!stored) return null
  if (!stored.ttsModelUnset || !signedIn || !catalog?.ttsModelId) return stored
  return { ...stored, ttsModelId: catalog.ttsModelId, ttsVoice: stored.ttsVoice || catalog.ttsVoice || '' }
}

/**
 * 语音条:把一段消息合成为 blob URL(调用方塞进自己的 <audio>,负责 revoke)。
 * 与朗读同一 /agent/tts 契约,但不接管全局播放状态机 —— 每个语音条独立控制播放/进度。
 * 无 ttsModelId 抛 NO_MODEL;空文本抛 EMPTY(调用方据此回退)。
 */
export async function synthesizeToBlobUrl(t: EngineTarget, stored: StoredDesktopConfig | null, markdown: string, signal?: AbortSignal): Promise<string> {
  const model = stored?.ttsModelId?.trim()
  if (!model) throw new Error('NO_MODEL')
  const text = speakableText(markdown)
  if (!text) throw new Error('EMPTY')
  const blob = await synthesizeTts(t, {
    text, model,
    ...(stored?.ttsVoice ? { voice: stored.ttsVoice } : {}),
    ...(stored?.ttsSpeed && stored.ttsSpeed !== 1 ? { speed: stored.ttsSpeed } : {}),
  }, signal)
  return URL.createObjectURL(blob)
}

/** 合成并播放一条消息(聊天):没配朗读模型静默不做(入口本来就不出)。失败抛错,主动取消静默。 */
export async function speakMessage(t: EngineTarget, stored: StoredDesktopConfig | null, msgId: string, markdown: string): Promise<void> {
  if (!stored?.ttsModelId?.trim()) return
  return speakKey(t, stored, msgId, markdown)
}

/**
 * 合成并念一段(任意 key):**念完 / 被停 / 被新的顶掉时才兑现**(插件 ctx.tts.speak 要的就是这个)。
 * 没配朗读模型 reject `Error('tts_no_model')`;空文本 reject `Error('EMPTY')`;合成失败 reject 原错误;主动取消(stop / 新 speak /
 * signal)静默兑现。
 * stored 可以是一个现读配置的函数(划线 / 插件朗读要认用户刚在设置浮窗里选的模型):这时**先在播放器上登记这一段**(按下即
 * 「合成中」、stop 看得见它),再等配置 —— 等的这会儿别处又点了朗读,这一段就作废,不会回头把后来那段掐掉。
 */
export async function speakKey(
  t: EngineTarget,
  stored: StoredDesktopConfig | null | (() => Promise<StoredDesktopConfig | null>),
  key: string,
  markdown: string,
  o: { signal?: AbortSignal } = {},
): Promise<void> {
  const lazy = typeof stored === 'function'
  if (!lazy && !stored?.ttsModelId?.trim()) throw new Error('tts_no_model')
  const text = speakableText(markdown)
  if (!text) throw new Error('EMPTY')
  if (o.signal?.aborted) return
  const my = ++seq
  inflight?.abort()
  endCurrent()
  const ac = (inflight = new AbortController())
  releaseAudio()
  emit({ key, msgId: key, phase: 'loading' })
  const onAbort = (): void => { if (my === seq) stopSpeaking() }
  o.signal?.addEventListener('abort', onAbort)
  let noModel = false
  try {
    const cfg = lazy ? await stored() : stored
    if (my !== seq) return // 等配置时已被新 speak/stop 取代
    const model = cfg?.ttsModelId?.trim()
    if (!model) { noModel = true; throw new Error('tts_no_model') }
    const blob = await synthesizeTts(t, {
      text, model,
      ...(cfg?.ttsVoice ? { voice: cfg.ttsVoice } : {}),
      ...(cfg?.ttsSpeed && cfg.ttsSpeed !== 1 ? { speed: cfg.ttsSpeed } : {}),
    }, ac.signal)
    if (my !== seq) return // 已被新 speak/stop 取代
    const ended = new Promise<void>((res) => { settle = res })
    currentUrl = URL.createObjectURL(blob)
    audioEl = audioEl || new Audio()
    audioEl.src = currentUrl
    const done = (): void => { if (my === seq) { releaseAudio(); emit(null); endCurrent() } }
    audioEl.onended = done
    audioEl.onerror = done
    await audioEl.play()
    if (my !== seq) return
    emit({ key, msgId: key, phase: 'playing' })
    await ended
  } catch (e: any) {
    const aborted = e?.name === 'AbortError' || my !== seq
    if (my === seq) {
      releaseAudio()
      emit(null)
      endCurrent()
    }
    if (!aborted) {
      if (!noModel) console.warn('[tts] speak failed:', e)
      throw e
    }
  } finally {
    o.signal?.removeEventListener('abort', onAbort)
    if (inflight === ac) inflight = null
  }
}
