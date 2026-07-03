/**
 * 语音条:语音模式下 agent 回复的主呈现。点播放才惰性合成(省额度,像真实语音消息 tap 才响),
 * 合成后显示时长 + 进度;「转文字」按需展开原文。TTS 用桌面「语音朗读」设置(ttsModelId/voice/speed)。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Play, Pause, Loader2, FileText } from 'lucide-react'
import type { StoredDesktopConfig, TanguDesktopConfig } from '../types'
import { synthesizeToBlobUrl } from '../services/ttsService'
import { Markdown } from './Markdown'
import { useI18n } from '../i18n'

export const VoiceBubble: React.FC<{
  text: string
  cfg: TanguDesktopConfig
  stored: StoredDesktopConfig | null
  anchorPrefix?: string
}> = ({ text, cfg, stored, anchorPrefix }) => {
  const { t } = useI18n()
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [dur, setDur] = useState(0)
  const [cur, setCur] = useState(0)
  const [showText, setShowText] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => () => {
    audioRef.current?.pause()
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
  }, [])

  const ensureAudio = async (): Promise<HTMLAudioElement | null> => {
    if (audioRef.current) return audioRef.current
    setLoading(true); setErr(null)
    try {
      const url = await synthesizeToBlobUrl(cfg, stored, text)
      urlRef.current = url
      const a = new Audio(url)
      a.onloadedmetadata = () => setDur(a.duration || 0)
      a.ontimeupdate = () => setCur(a.currentTime || 0)
      a.onended = () => { setPlaying(false); setCur(0) }
      a.onpause = () => setPlaying(false)
      a.onplay = () => setPlaying(true)
      audioRef.current = a
      return a
    } catch (e: any) {
      setErr(e?.message === 'EMPTY' ? t('tts.noText') : e?.message === 'NO_MODEL' ? t('tts.noText') : t('tts.failed', { e: e?.message || e }))
      return null
    } finally {
      setLoading(false)
    }
  }

  const toggle = async (): Promise<void> => {
    const a = await ensureAudio()
    if (!a) return
    if (a.paused) void a.play(); else a.pause()
  }

  const secs = dur ? Math.max(1, Math.round(dur)) : 0
  const pct = dur ? Math.min(100, (cur / dur) * 100) : 0
  return (
    <div className="t2-voice">
      <div className="t2-voice-bar">
        <button className="t2-voice-play" onClick={toggle} title={t(playing ? 'voice.pause' : 'voice.play')}>
          {loading ? <Loader2 size={15} className="spin" /> : playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <div className="t2-voice-track"><span style={{ width: `${pct}%` }} /></div>
        <span className="t2-voice-dur">{secs ? `${secs}″` : t('voice.label')}</span>
        <button className="t2-voice-txt" onClick={() => setShowText((v) => !v)} title={t('voice.toText')}>
          <FileText size={13} />
        </button>
      </div>
      {err && <div className="t2-dim" style={{ marginTop: 4 }}>{err}</div>}
      {showText && <div className="t2-content" style={{ marginTop: 6 }}><Markdown content={text} anchorPrefix={anchorPrefix} /></div>}
    </div>
  )
}
