/**
 * 活动日志实时视图(开发者工具):主区标签页 tail ~/.forsion/activity 当日+昨日文件。
 * 2s 轮询 window.tangu.exportActivity(2)——轮询而非 push,因为日志有两个写入端
 * (桌面 main 埋点 + 引擎 agent.edit 直写文件),读文件才两路全覆盖。
 * 入口:命令面板「打开活动日志」(开发者选项开启后注册,见 activityViewCommand.ts)。
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Pause, Play } from 'lucide-react'
import { useI18n } from '../i18n'

const LINE_RE = /^(\d{12}) (\S+)(.*)$/
const MAX_LINES = 500
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

export const ActivityLogView: React.FC = () => {
  const { t } = useI18n()
  const [lines, setLines] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [paused, setPaused] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true) // 吸底跟随;用户上滚即松开,回到底部恢复

  useEffect(() => {
    if (paused) return
    let alive = true
    const pull = async (): Promise<void> => {
      const text = (await window.tangu?.exportActivity?.(2).catch(() => '')) || ''
      if (!alive) return
      setLines(text.split('\n').filter((l) => LINE_RE.test(l)).slice(-MAX_LINES))
    }
    void pull()
    const id = setInterval(() => void pull(), 2000)
    return () => { alive = false; clearInterval(id) }
  }, [paused])

  useLayoutEffect(() => {
    if (stickRef.current && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [lines, filter])

  const q = filter.trim().toLowerCase()
  const shown = q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', flexShrink: 0 }}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('activityView.filter')}
          spellCheck={false}
          style={{ flex: 1, maxWidth: 320, fontSize: 'var(--ui-font-meta, 12px)' }}
        />
        <button className="btn ghost sm" onClick={() => setPaused((p) => !p)}>
          {paused ? <Play size={12} /> : <Pause size={12} />} {paused ? t('activityView.resume') : t('activityView.pause')}
        </button>
        <span style={{ fontSize: 'var(--ui-font-meta, 12px)', color: 'var(--text-muted)' }}>{t('activityView.count', { n: shown.length })}</span>
      </div>
      <div
        ref={boxRef}
        onScroll={() => {
          const el = boxRef.current
          if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 12px 12px', fontFamily: MONO, fontSize: 'var(--ui-font-meta, 12px)', lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
      >
        {shown.length === 0 && <div className="hint" style={{ fontFamily: 'inherit' }}>{t('activityView.empty')}</div>}
        {shown.map((l, i) => {
          const m = LINE_RE.exec(l)!
          return (
            <div key={i}>
              <span style={{ color: 'var(--text-faint)' }}>{m[1]}</span>{' '}
              <span style={{ color: 'var(--accent-ink)', fontWeight: 600 }}>{m[2]}</span>
              <span>{m[3]}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
