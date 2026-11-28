/** 命令面板(Cmd/Ctrl+K):跑 commandRegistry 里的命令。移植自 Amadeus,改读引擎 store。 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, Plus } from 'lucide-react'
import { useExitGhost } from './menuAnchor'
import { noteCommandUse, useCommandStore } from './commandRegistry'
import { ribbonActions, useRibbonStore } from './ribbonRegistry'
import { effectiveHotkey, formatHotkey, isMacPlatform, isPairHotkey } from './shortcutStore'
import { fuzzyRank } from './fuzzy'
import { label } from './types'
import { useEngineI18n } from './i18nSeam'
import { isImeKeyEvent } from './ime'
import { closePhonePage } from './phoneDock'
import { usePhoneForm } from './listFirst'

export function CommandPalette({ hasRibbon = false }: { hasRibbon?: boolean }) {
  const { t } = useEngineI18n()
  const open = useCommandStore((s) => s.paletteOpen)
  const setOpen = useCommandStore((s) => s.setPaletteOpen)
  const commands = useCommandStore((s) => s.commands)
  const pickCb = useCommandStore((s) => s.pickCb)
  const pinnedCommands = useRibbonStore((s) => s.commandItems)
  const addCommandItem = useRibbonStore((s) => s.addCommandItem)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const overlayRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useExitGhost(overlayRef, open)
  // 手机(原生底栏、竖屏的两级导航)上没有键盘可按:行尾的快捷键与底部的按键说明都不画,只留条数(手机走查 2026-11-19)。
  // 桌面、横屏 / 平板的宽屏、网页的抽屉形态照旧。
  const keys = !usePhoneForm()

  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
    }
  }, [open])

  if (!open) return null

  const results = fuzzyRank(query, commands, (c) => `${label(c.title)} ${c.keywords ?? ''}`)
  const selected = Math.max(0, Math.min(active, results.length - 1))
  const canPin = hasRibbon && !pickCb && ribbonActions.editable !== false
  const mac = keys && isMacPlatform()
  const close = (): void => setOpen(false)
  // 「左右两个同名修饰键同按」写作 ⌘⌘,悬停说清是同时按、不是连按
  const pairHint = (hk: string): string | undefined => (isPairHotkey(hk) ? t('lcl.palette.pairHint', { key: formatHotkey(hk.split('+')[0], mac) }) : undefined)

  const run = (i: number): void => {
    const c = results[i]
    close() // 选取模式:close 会清 pickCb,故用 render 捕获的引用
    if (!c) return
    if (pickCb) pickCb(c.id)
    else {
      // 手机上命令面板从「我」页开(phoneDock.ts):跑命令时先收起那一页,命令作用的那一页(页内查找、开面板…)才露得出来
      closePhonePage()
      noteCommandUse(c.id, 'palette'); c.run()
    }
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (isImeKeyEvent(e)) return // 组字中的 Enter/↑↓/Esc 归输入法(G4-02)
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (!(e.target instanceof HTMLInputElement)) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = Math.max(0, Math.min(selected + (e.key === 'ArrowDown' ? 1 : -1), results.length - 1))
      setActive(next)
      listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(selected)
    }
  }

  return (
    <div ref={overlayRef} className="cmd-overlay" onMouseDown={close}>
      <div className="cmd-panel" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <input
          className="cmd-input"
          autoFocus
          placeholder={pickCb ? t('lcl.palette.pickCommand') : t('command.placeholder')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
            listRef.current?.scrollTo(0, 0)
          }}
        />
        <div ref={listRef} className="cmd-list">
          {results.map((c, i) => {
            const title = label(c.title)
            const hotkey = keys ? effectiveHotkey(c) : ''
            const pinned = canPin && pinnedCommands.includes(c.id)
            const pinLabel = canPin ? t(pinned ? 'lcl.palette.addedToRibbon' : 'lcl.palette.addToRibbon', { command: title }) : undefined
            return (
              <div key={c.id} className="cmd-command-row" onMouseMove={() => setActive(i)}>
                <button type="button" className="cmd-item" data-command-id={c.id} data-active={i === selected || undefined} onClick={() => run(i)}>
                  <span className="cmd-title">
                    {/* 没图标的命令留一个空位,文字和有图标的对齐(走查 5.14) */}
                    {c.icon ? <c.icon size={14} className="cmd-icon" /> : <span className="cmd-icon cmd-icon-empty" aria-hidden="true" />}
                    <span className="cmd-title-text">{title}</span>
                  </span>
                  {hotkey && <kbd className="cmd-hotkey" title={pairHint(hotkey)}>{formatHotkey(hotkey, mac)}</kbd>}
                </button>
                {canPin && (
                  <button
                    type="button"
                    className="cmd-pin"
                    aria-label={pinLabel}
                    title={pinLabel}
                    aria-disabled={pinned || undefined}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { if (!pinned) addCommandItem(c.id) }}
                  >
                    {pinned ? <Check size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
                  </button>
                )}
              </div>
            )
          })}
          {results.length === 0 && <div className="cmd-empty">{t('command.empty')}</div>}
        </div>
        <div className="cmd-foot">
          {keys && <span>
            <kbd>↑↓</kbd> {t('command.select')} <kbd>↵</kbd> {t('command.run')} <kbd>Esc</kbd> {t('common.close')}
          </span>}
          <span className="cmd-foot-count">{t('command.count', { count: results.length })}</span>
        </div>
      </div>
    </div>
  )
}
