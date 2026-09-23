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
import { takePendingRun, type PendingRun } from './runCommand'

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

export const TerminalView: React.FC<ViewProps> = ({ params, leaf }) => {
  const { t } = useI18n()
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const [exited, setExited] = useState<number | null>(null)
  const [gen, setGen] = useState(0) // 「重新启动」= 重跑整个装配 effect
  // 「运行」来的一次性登记:首挂取走存 ref,「重新启动」= 再跑同一条命令(结果照样回传)。
  // 布局恢复带旧 token → undefined → 普通登录 shell(命令从不进持久化 params,见 runCommand.ts)。
  const run = useRef<PendingRun | null | undefined>(undefined) // undefined=未取;null=取过、不是运行 tab
  if (run.current === undefined) run.current = takePendingRun(params.runToken) ?? null
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
    const cmd = run.current?.cmd
    // 带命令启动:tab 标题 = 命令首行;终端顶上灰字回显命令(专用进程没有提示符,不回显用户看不到跑的是啥)。
    let echoLines = 0
    if (cmd) {
      leaf.setTitle(cmd.split('\n')[0].slice(0, 40))
      for (const line of cmd.split('\n')) { tm.writeln(`\x1b[2m$ ${line}\x1b[0m`); echoLines++ }
    }
    if (!api) {
      tm.writeln(`\x1b[31m${t('terminal.unavailable')}\x1b[0m`)
      setExited(-1)
    } else {
      void api.spawn({ cols: tm.cols, rows: tm.rows, cwd, cmd }).then((r) => {
        if (disposed) { if (r?.id) api.kill(r.id); return }
        if (!r?.id) {
          tm.writeln(`\x1b[31m${r?.error || t('terminal.unavailable')}\x1b[0m`)
          setExited(-1)
          return
        }
        const id = r.id
        ptyId = id
        offs.push(api.onData(id, (d) => tm.write(d)))
        offs.push(api.onExit(id, (code) => {
          ptyId = null
          setExited(code)
          const cur = run.current
          if (!cmd || !cur?.onExit) return
          // 结果从 xterm 缓冲区取(已去 ANSI):软换行并回逻辑行,跳过顶上的命令回显行,去掉尾部空行。
          // ponytail: 输出超过 scrollback(5000 行)时回显已滚出缓冲、偏移会错一两行;真撞上再改成按标记行定位。
          const b = tm.buffer.active
          const lines: string[] = []
          for (let i = 0; i < b.length; i++) {
            const row = b.getLine(i)
            if (!row) continue
            const text = row.translateToString(true)
            if (row.isWrapped && lines.length) lines[lines.length - 1] += text
            else lines.push(text)
          }
          lines.splice(0, echoLines)
          while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
          try { cur.onExit({ cmd, cwd, code, output: lines.join('\n') }) } catch { /* 回传失败不影响终端 */ }
        }))
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', fontSize: 'var(--ui-font-meta, 12px)', borderTop: 'var(--border-width, 1px) solid var(--border)' }}>
          <span style={{ color: 'var(--text-muted, var(--text-faint))' }}>{t('terminal.exited', { code: String(exited) })}</span>
          <button className="btn ghost sm" onClick={() => { setExited(null); setGen((g) => g + 1) }}>{t('terminal.restart')}</button>
        </div>
      )}
    </div>
  )
}
