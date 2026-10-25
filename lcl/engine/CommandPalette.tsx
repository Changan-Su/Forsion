/** 命令面板(Cmd/Ctrl+K):跑 commandRegistry 里的命令。移植自 Amadeus,改读引擎 store。 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useExitGhost } from './menuAnchor'
import { commandHotkeyText, useCommandStore } from './commandRegistry'
import { effectiveHotkey, formatHotkey, isMacPlatform, isPairHotkey } from './shortcutStore'
import { fuzzyRank } from './fuzzy'
import { label } from './types'
import { useEngineI18n } from './i18nSeam'
import { isImeKeyEvent } from './ime'

export function CommandPalette() {
  const { t } = useEngineI18n()
  const open = useCommandStore((s) => s.paletteOpen)
  const setOpen = useCommandStore((s) => s.setPaletteOpen)
  const commands = useCommandStore((s) => s.commands)
  const pickCb = useCommandStore((s) => s.pickCb)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const overlayRef = useRef<HTMLDivElement>(null)
  useExitGhost(overlayRef, open)

  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
    }
  }, [open])

  if (!open) return null

  const results = fuzzyRank(query, commands, (c) => `${label(c.title)} ${c.keywords ?? ''}`).slice(0, 40)
  const close = (): void => setOpen(false)
  // 「左右两个同名修饰键同按」写作 ⌘⌘,悬停说清是同时按、不是连按
  const pairHint = (hk: string): string | undefined => (isPairHotkey(hk) ? t('lcl.palette.pairHint', { key: formatHotkey(hk.split('+')[0], isMacPlatform()) }) : undefined)

  const run = (i: number): void => {
    const c = results[i]
    close() // 选取模式:close 会清 pickCb,故用 render 捕获的引用
    if (!c) return
    if (pickCb) pickCb(c.id)
    else c.run()
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (isImeKeyEvent(e)) return // 组字中的 Enter/↑↓/Esc 归输入法(G4-02)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(active)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }

  return (
    <div ref={overlayRef} className="cmd-overlay" onMouseDown={close}>
      <div className="cmd-panel" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="cmd-input"
          autoFocus
          placeholder={pickCb ? t('lcl.palette.pickCommand') : t('command.placeholder')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
        />
        <div className="cmd-list">
          {results.map((c, i) => (
            <button
              key={c.id}
              className="cmd-item"
              data-command-id={c.id}
              data-active={i === active || undefined}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(i)}
            >
              <span className="cmd-title">
                {/* 没图标的命令留一个空位,文字和有图标的对齐(走查 5.14) */}
                {c.icon ? <c.icon size={14} className="cmd-icon" /> : <span className="cmd-icon cmd-icon-empty" aria-hidden="true" />}
                {label(c.title)}
              </span>
              {/* 生效键(用户改绑 / 解绑都跟)按平台格式化:原样打 c.hotkey 会露出「mod+n」这种存储串 */}
              {commandHotkeyText(c.id) && <kbd className="cmd-hotkey" title={pairHint(effectiveHotkey(c))}>{commandHotkeyText(c.id)}</kbd>}
            </button>
          ))}
          {results.length === 0 && <div className="cmd-empty">{t('command.empty')}</div>}
        </div>
        <div className="cmd-foot">
          <span>
            <kbd>↑↓</kbd> {t('command.select')} <kbd>↵</kbd> {t('command.run')} <kbd>Esc</kbd> {t('common.close')}
          </span>
          <span className="cmd-foot-count">{t('command.count', { count: results.length })}</span>
        </div>
      </div>
    </div>
  )
}
