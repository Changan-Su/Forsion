/**
 * 内置终端视图(builtin:terminal):xterm.js ↔ 主进程 node-pty(见 electron/pty.ts)。
 *
 * 真 PTY(登录 shell),所以 vim / top / ssh / Ctrl-C / 颜色 / resize 都是对的。
 * 原生模块未就绪时不白屏:spawn 返回 { error },直接把提示打进终端画面。
 *
 * ponytail: 不做会话持久化、不做分屏、不做多 shell 选择器 —— 多开一个终端就是多开一个 tab。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { ViewProps } from '@lcl/engine'
import { useTheme } from '../stores/themeStore'
import { useI18n } from '../i18n'

/** 从当前主题的 CSS 变量取终端配色(主题切换后重取);取不到就交给 xterm 默认值。 */
function themeFromCss(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string): string => cs.getPropertyValue(name).trim()
  const out: Record<string, string> = {}
  const bg = v('--bg-card') || v('--bg')
  const fg = v('--text-normal') || v('--text')
  const accent = v('--accent')
  if (bg) out.background = bg
  if (fg) out.foreground = fg
  if (accent) out.cursor = accent
  return out
}

export const TerminalView: React.FC<ViewProps> = ({ params }) => {
  const { t } = useI18n()
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const [exited, setExited] = useState<number | null>(null)
  const [gen, setGen] = useState(0) // 「重新启动」= 重跑整个装配 effect
  // 主题切换要重上色:订阅这几个字段(值本身不用,变了即触发下方 effect)。
  const skin = useTheme((s) => s.skin)
  const lang = useTheme((s) => s.lang)
  const mode = useTheme((s) => s.mode)
  const seed = useTheme((s) => s.seed)

  useEffect(() => {
    const el = host.current
    if (!el) return
    let disposed = false
    let ptyId: string | null = null
    const offs: Array<() => void> = []

    const tm = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: themeFromCss(),
    })
    const fit = new FitAddon()
    tm.loadAddon(fit)
    tm.open(el)
    term.current = tm
    const safeFit = (): void => { try { if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit() } catch { /* 0 尺寸/已卸载 */ } }
    safeFit()

    // ⚠️不要写成 `window.tangu?.pty?.spawn(…).then(…)`:pty 缺席时可选链只短路到 spawn(…),
    //   整条链求值成 undefined,再 .then 就是 TypeError(web/移动端跑同一套渲染层时必炸)。
    const api = window.tangu?.pty
    const cwd = typeof params.cwd === 'string' ? params.cwd : undefined
    if (!api) {
      tm.writeln(`\x1b[31m${t('terminal.unavailable')}\x1b[0m`)
      setExited(-1)
    } else {
      void api.spawn({ cols: tm.cols, rows: tm.rows, cwd }).then((r) => {
        if (disposed) { if (r?.id) api.kill(r.id); return }
        if (!r?.id) {
          tm.writeln(`\x1b[31m${r?.error || t('terminal.unavailable')}\x1b[0m`)
          setExited(-1)
          return
        }
        const id = r.id
        ptyId = id
        offs.push(api.onData(id, (d) => tm.write(d)))
        offs.push(api.onExit(id, (code) => { ptyId = null; setExited(code) }))
        offs.push(tm.onData((d) => api.write(id, d)).dispose)
        safeFit()
        api.resize(id, tm.cols, tm.rows)
      }).catch((e) => {
        tm.writeln(`\x1b[31m${String(e?.message || e)}\x1b[0m`)
        setExited(-1)
      })
    }

    const ro = new ResizeObserver(() => {
      safeFit()
      if (ptyId) window.tangu?.pty?.resize(ptyId, tm.cols, tm.rows)
    })
    ro.observe(el)

    return () => {
      disposed = true
      ro.disconnect()
      for (const off of offs) { try { off() } catch { /* 已解绑 */ } }
      if (ptyId) window.tangu?.pty?.kill(ptyId)
      term.current = null
      tm.dispose()
    }
  }, [gen]) // eslint-disable-line react-hooks/exhaustive-deps

  // 主题切换 → 重上色(不重建终端,滚动缓冲保留)。
  useEffect(() => { if (term.current) term.current.options.theme = themeFromCss() }, [skin, lang, mode, seed])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--bg-card, var(--bg))' }}>
      <div ref={host} style={{ flex: 1, minHeight: 0, padding: 6 }} />
      {exited !== null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', fontSize: 12, borderTop: 'var(--border-width, 1px) solid var(--border)' }}>
          <span style={{ color: 'var(--text-muted, var(--text-faint))' }}>{t('terminal.exited', { code: String(exited) })}</span>
          <button className="btn ghost sm" onClick={() => { setExited(null); setGen((g) => g + 1) }}>{t('terminal.restart')}</button>
        </div>
      )}
    </div>
  )
}
