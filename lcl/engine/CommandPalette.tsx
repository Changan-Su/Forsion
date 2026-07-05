/** 命令面板(Cmd/Ctrl+K):跑 commandRegistry 里的命令。移植自 Amadeus,改读引擎 store。 */
import { useEffect, useState, type KeyboardEvent } from 'react'
import { useCommandStore } from './commandRegistry'
import { fuzzyRank } from './fuzzy'
import { label } from './types'
import { useEngineI18n } from './i18nSeam'

export function CommandPalette() {
  const { t } = useEngineI18n()
  const open = useCommandStore((s) => s.paletteOpen)
  const setOpen = useCommandStore((s) => s.setPaletteOpen)
  const commands = useCommandStore((s) => s.commands)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
    }
  }, [open])

  if (!open) return null

  const results = fuzzyRank(query, commands, (c) => `${label(c.title)} ${c.keywords ?? ''}`).slice(0, 40)
  const close = (): void => setOpen(false)

  const run = (i: number): void => {
    const c = results[i]
    close()
    if (c) c.run()
  }

  const onKeyDown = (e: KeyboardEvent): void => {
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
    <div className="cmd-overlay" onMouseDown={close}>
      <div className="cmd-panel" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="cmd-input"
          autoFocus
          placeholder={t('command.placeholder')}
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
              data-active={i === active || undefined}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(i)}
            >
              <span className="cmd-title">{label(c.title)}</span>
              {c.hotkey && <kbd className="cmd-hotkey">{c.hotkey}</kbd>}
            </button>
          ))}
          {results.length === 0 && <div className="cmd-empty">{t('command.empty')}</div>}
        </div>
        <div className="cmd-foot">
          <span>
            <kbd>↑↓</kbd> {t('command.select')} <kbd>↵</kbd> {t('command.run')} <kbd>esc</kbd> {t('common.close')}
          </span>
          <span className="cmd-foot-count">{t('command.count', { count: results.length })}</span>
        </div>
      </div>
    </div>
  )
}
