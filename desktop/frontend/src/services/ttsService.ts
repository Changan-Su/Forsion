/**
 * 朗读服务:markdown 清洗 → POST /agent/tts 合成 → 单例 <audio> 播放。
 * 同一时刻只播一条(speak 新消息自动停旧);状态经 subscribe 通知,ChatView 订阅刷新按钮态。
 * 仅在 stored.ttsModelId 非空时可用(设置「语音朗读」配置;cloudWeb 无 window.tangu 配置 → 天然不可用)。
 */
import type { StoredDesktopConfig, TanguDesktopConfig } from '../types'
import { authFetch } from './http'

export type TtsState = { msgId: string; phase: 'loading' | 'playing' } | null

let audioEl: HTMLAudioElement | null = null
let currentUrl: string | null = null
let state: TtsState = null
let seq = 0 // speak/stop 竞态令牌:慢合成返回时若已被新动作取代则丢弃
let inflight: AbortController | null = null // stop/新 speak 时中止在飞合成(链路直达 provider,别让被弃请求继续计费)
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

export function stopSpeaking(): void {
  seq++
  inflight?.abort()
  inflight = null
  releaseAudio()
  emit(null)
}

/** 设置页「试听」:用给定配置合成一句短文本并播放;独立于消息朗读状态机,失败抛错给调用方展示。 */
export async function previewTts(cfg: TanguDesktopConfig, opts: { model: string; voice?: string; speed?: number }, text: string): Promise<void> {
  const r = await authFetch(`${cfg.backendUrl}/agent/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify({
      text, model: opts.model,
      ...(opts.voice ? { voice: opts.voice } : {}),
      ...(opts.speed && opts.speed !== 1 ? { speed: opts.speed } : {}),
    }),
  })
  if (!r.ok) {
    let detail = `HTTP ${r.status}`
    try { detail = (await r.json())?.detail || detail } catch { /* keep */ }
    throw new Error(detail)
  }
  const url = URL.createObjectURL(await r.blob())
  const a = new Audio(url)
  a.onended = () => URL.revokeObjectURL(url)
  a.onerror = () => URL.revokeObjectURL(url)
  await a.play()
}

/**
 * 语音条:把一段消息合成为 blob URL(调用方塞进自己的 <audio>,负责 revoke)。
 * 与朗读同一 /agent/tts 契约,但不接管全局播放状态机 —— 每个语音条独立控制播放/进度。
 * 无 ttsModelId 抛 NO_MODEL;空文本抛 EMPTY(调用方据此回退)。
 */
export async function synthesizeToBlobUrl(cfg: TanguDesktopConfig, stored: StoredDesktopConfig | null, markdown: string, signal?: AbortSignal): Promise<string> {
  const model = stored?.ttsModelId?.trim()
  if (!model) throw new Error('NO_MODEL')
  const text = speakableText(markdown)
  if (!text) throw new Error('EMPTY')
  const r = await authFetch(`${cfg.backendUrl}/agent/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
    signal,
    body: JSON.stringify({
      text, model,
      ...(stored?.ttsVoice ? { voice: stored.ttsVoice } : {}),
      ...(stored?.ttsSpeed && stored.ttsSpeed !== 1 ? { speed: stored.ttsSpeed } : {}),
    }),
  })
  if (!r.ok) {
    let detail = `HTTP ${r.status}`
    try { detail = (await r.json())?.detail || detail } catch { /* keep */ }
    throw new Error(detail)
  }
  return URL.createObjectURL(await r.blob())
}

/** 合成并播放一条消息;失败恢复 idle 并抛错(调用方 toast),主动取消(stop/新 speak)静默。 */
export async function speakMessage(cfg: TanguDesktopConfig, stored: StoredDesktopConfig | null, msgId: string, markdown: string): Promise<void> {
  const model = stored?.ttsModelId?.trim()
  if (!model) return
  const text = speakableText(markdown)
  if (!text) throw new Error('EMPTY')
  const my = ++seq
  inflight?.abort()
  const ac = (inflight = new AbortController())
  releaseAudio()
  emit({ msgId, phase: 'loading' })
  try {
    const r = await authFetch(`${cfg.backendUrl}/agent/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
      signal: ac.signal,
      body: JSON.stringify({
        text, model,
        ...(stored?.ttsVoice ? { voice: stored.ttsVoice } : {}),
        ...(stored?.ttsSpeed && stored.ttsSpeed !== 1 ? { speed: stored.ttsSpeed } : {}),
      }),
    })
    if (!r.ok) {
      let detail = `HTTP ${r.status}`
      try { detail = (await r.json())?.detail || detail } catch { /* keep */ }
      throw new Error(detail)
    }
    const blob = await r.blob()
    if (my !== seq) return // 已被新 speak/stop 取代
    currentUrl = URL.createObjectURL(blob)
    audioEl = audioEl || new Audio()
    audioEl.src = currentUrl
    audioEl.onended = () => { if (my === seq) { releaseAudio(); emit(null) } }
    audioEl.onerror = () => { if (my === seq) { releaseAudio(); emit(null) } }
    await audioEl.play()
    if (my !== seq) return
    emit({ msgId, phase: 'playing' })
  } catch (e: any) {
    const aborted = e?.name === 'AbortError' || my !== seq
    if (my === seq) {
      releaseAudio()
      emit(null)
    }
    if (!aborted) {
      console.warn('[tts] speak failed:', e)
      throw e
    }
  } finally {
    if (inflight === ac) inflight = null
  }
}
