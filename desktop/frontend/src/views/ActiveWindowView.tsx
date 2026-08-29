/**
 * 前台窗口采样调试面板(开发者工具):看接缝到底能拿到什么。
 *
 * 为什么要它:这个接缝的产出**因平台而异**(darwin 没有窗口标题、Wayland 直接拿不到),
 * 而且消费方必须自己做两件事——把连续同 app 的采样折成焦点段、按 idle 丢挂机时段。
 * 面板就照这两件事画:上面是当前采样原样,下面是折好的段(挂机段单独标出来),
 * 于是「接缝能不能替掉 ActivityWatch」用眼睛就能判,不用先把插件改完再试。
 *
 * 入口:命令面板「前台窗口采样」——只在 设置 → 开发者选项 打开采样开关后注册(见 activeWindowCommand.ts)。
 * 视图本体恒注册(同 activity-log 纪律:布局里存着这个 type 的用户,关掉开关也不该被丢一个视图)。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Pause, Play, Trash2 } from 'lucide-react'
import { useI18n } from '../i18n'
import type { ActiveWindowSample } from '../../../shared/activeWindow'

/** 采样间隔:主进程侧缓存下限是 2s,比它更密只是白跑一趟 IPC。 */
const POLL_MS = 2000
/** 超过这个空闲秒数就算挂机——消费方该丢掉的那部分,面板同口径标出来。 */
const IDLE_CUTOFF_S = 120
const MAX_SEGS = 200
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/** 折好的焦点段:连续同 app 的采样合成一条。 */
interface Seg {
  app: string
  title: string
  bundleId?: string
  startMs: number
  endMs: number
  /** 段内是否**整段**都在挂机(采样时 idle 已过线)——消费方应当丢掉的那种。 */
  idle: boolean
}

const hhmmss = (ms: number): string => new Date(ms).toTimeString().slice(0, 8)
const dur = (ms: number): string => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

export const ActiveWindowView: React.FC = () => {
  const { t } = useI18n()
  const [sample, setSample] = useState<ActiveWindowSample | null>(null)
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [segs, setSegs] = useState<Seg[]>([])
  const [paused, setPaused] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  // 开关态直接读主进程配置:面板空着的时候要能分清「没开」和「开了但探不到」(Wayland/缺 xprop)。
  useEffect(() => {
    let alive = true
    const read = (): void => { void window.tangu?.getConfig?.().then((c) => { if (alive) setEnabled(c.activeWindowEnabled === true) }).catch(() => {}) }
    read()
    const id = setInterval(read, 4000) // 用户可能在设置里当场打开,别让面板停在旧结论上
    return () => { alive = false; clearInterval(id) }
  }, [])

  useEffect(() => {
    if (paused) return
    let alive = true
    const pull = async (): Promise<void> => {
      const s = (await window.tangu?.activeWindow?.().catch(() => null)) ?? null
      if (!alive) return
      setSample(s)
      if (!s) return
      const now = Date.now()
      const idle = s.idleSeconds >= IDLE_CUTOFF_S
      setSegs((prev) => {
        const last = prev[prev.length - 1]
        // 同 app 且挂机状态没翻转 → 延长上一段;否则起新段(挂机翻转要断开,不然一段里半真半假)。
        if (last && last.app === s.app && last.idle === idle) {
          const merged = { ...last, endMs: now, title: s.title || last.title }
          return [...prev.slice(0, -1), merged]
        }
        return [...prev, { app: s.app, title: s.title, bundleId: s.bundleId, startMs: now, endMs: now, idle }].slice(-MAX_SEGS)
      })
    }
    void pull()
    const id = setInterval(() => void pull(), POLL_MS)
    return () => { alive = false; clearInterval(id) }
  }, [paused])

  useEffect(() => {
    if (stickRef.current && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [segs])

  const off = enabled === false
  const idleNow = !!sample && sample.idleSeconds >= IDLE_CUTOFF_S

  return (
    <div data-view="active-window" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', flexShrink: 0, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: off ? 'var(--text-muted)' : 'var(--accent-ink)', fontWeight: 600 }}>
          {off ? t('activeWindowView.off') : t('activeWindowView.on')}
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{window.tangu?.platform}</span>
        <div style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => setPaused((p) => !p)}>
          {paused ? <Play size={12} /> : <Pause size={12} />} {paused ? t('activityView.resume') : t('activityView.pause')}
        </button>
        <button className="btn ghost sm" onClick={() => setSegs([])}><Trash2 size={12} /> {t('activeWindowView.clear')}</button>
      </div>

      {off && <div className="hint" style={{ padding: '4px 12px 12px' }}>{t('activeWindowView.offHint')}</div>}

      {!off && (
        <div style={{ padding: '0 12px 8px', fontFamily: MONO, fontSize: 12.5, lineHeight: 1.8, flexShrink: 0 }}>
          {!sample && <div className="hint" style={{ fontFamily: 'inherit' }}>{t('activeWindowView.noSample')}</div>}
          {sample && (
            <>
              <div><span style={{ color: 'var(--text-faint)' }}>app</span> <b>{sample.app}</b>{sample.pid ? <span style={{ color: 'var(--text-faint)' }}> #{sample.pid}</span> : null}</div>
              {sample.bundleId && <div><span style={{ color: 'var(--text-faint)' }}>bundle</span> {sample.bundleId}</div>}
              <div>
                <span style={{ color: 'var(--text-faint)' }}>title</span>{' '}
                {sample.title || <span className="hint" style={{ fontFamily: 'inherit' }}>{t('activeWindowView.noTitle')}</span>}
              </div>
              <div style={{ color: idleNow ? 'var(--warning, #b26a00)' : undefined }}>
                <span style={{ color: 'var(--text-faint)' }}>idle</span> {sample.idleSeconds}s{idleNow ? ` — ${t('activeWindowView.idleMark')}` : ''}
              </div>
            </>
          )}
        </div>
      )}

      <div
        ref={boxRef}
        onScroll={() => {
          const el = boxRef.current
          if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 12px 12px', fontFamily: MONO, fontSize: 12, lineHeight: 1.7, borderTop: '1px solid var(--border)' }}
      >
        {segs.length === 0 && !off && <div className="hint" style={{ fontFamily: 'inherit' }}>{t('activeWindowView.segEmpty')}</div>}
        {segs.map((s, i) => (
          <div key={i} style={{ opacity: s.idle ? 0.45 : 1 }}>
            <span style={{ color: 'var(--text-faint)' }}>{hhmmss(s.startMs)}</span>{' '}
            <span style={{ color: 'var(--text-faint)' }}>{dur(s.endMs - s.startMs).padStart(6)}</span>{' '}
            <span style={{ color: 'var(--accent-ink)', fontWeight: 600 }}>{s.app}</span>
            {s.idle && <span style={{ color: 'var(--text-muted)' }}> [{t('activeWindowView.idleMark')}]</span>}
            {s.title && <span style={{ color: 'var(--text-muted)' }}> {s.title}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
