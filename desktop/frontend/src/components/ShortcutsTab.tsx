/**
 * 设置 → 快捷键:列出命令面板 + 所有注册命令,显示/录制/重置/解绑自定义热键。
 * 生效与分发由 engine/shortcutStore(覆盖)+ commandRegistry.installHotkeys 负责;此处只读写覆盖。
 */
import React, { useState } from 'react'
import { RotateCcw, X } from 'lucide-react'
import { useCommandStore, useShortcuts, eventToHotkey, formatHotkey } from '@lcl/engine'
import { useI18n } from '../i18n'

const isMac = (): boolean => { try { return document.documentElement.dataset.platform === 'mac' } catch { return false } }

interface Row { id: string; title: string; def: string }

export const ShortcutsTab: React.FC = () => {
  const { t } = useI18n()
  const commands = useCommandStore((s) => s.commands)
  const overrides = useShortcuts((s) => s.overrides)
  const { setOverride, clearOverride, resetAll, setRecording } = useShortcuts.getState()
  const [recId, setRecId] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const mac = isMac()

  // 命令面板是引擎内置(非注册命令),作伪命令排首位;其余跟随注册命令。
  const rows: Row[] = [
    { id: 'command-palette', title: t('settings.shortcuts.commandPalette'), def: 'mod+k' },
    ...commands.map((c) => ({ id: c.id, title: typeof c.title === 'function' ? c.title() : c.title, def: c.hotkey || '' })),
  ]
  const effOf = (r: Row): string =>
    Object.prototype.hasOwnProperty.call(overrides, r.id) ? (overrides[r.id] || '') : r.def
  const isCustomized = (r: Row): boolean =>
    Object.prototype.hasOwnProperty.call(overrides, r.id) && (overrides[r.id] || '') !== r.def

  const stopRecord = (): void => { setRecId(null); setRecording(false) }
  const startRecord = (id: string): void => { setNote(''); setRecId(id); setRecording(true) }

  const onRecKey = (e: React.KeyboardEvent): void => {
    e.preventDefault(); e.stopPropagation()
    if (e.key === 'Escape') { stopRecord(); return }
    const hk = eventToHotkey(e.nativeEvent)
    if (!hk || !recId) return // 纯修饰键 → 继续等
    // 唯一性:同热键已绑到别的命令 → 把那个解绑(显式空串),避免出现永不触发的死键。
    const conflict = rows.find((r) => r.id !== recId && effOf(r) === hk)
    if (conflict) { setOverride(conflict.id, ''); setNote(t('settings.shortcuts.reassigned', { name: conflict.title })) }
    setOverride(recId, hk)
    stopRecord()
  }

  return (
    <div className="field">
      <div className="settings-sec">{t('settings.tab.shortcuts')}</div>
      <div className="hint" style={{ marginBottom: 10 }}>{t('settings.shortcuts.desc')}</div>
      {note && <div className="hint" style={{ marginBottom: 8, color: 'var(--accent)' }}>{note}</div>}
      <div className="shortcut-list">
        {rows.map((r) => {
          const eff = effOf(r)
          return (
            <div className="shortcut-row" key={r.id}>
              <span className="shortcut-name">{r.title}</span>
              <div className="shortcut-controls">
                {recId === r.id ? (
                  <input
                    className="shortcut-capture" autoFocus readOnly
                    value={t('settings.shortcuts.recording')}
                    onKeyDown={onRecKey} onBlur={stopRecord}
                  />
                ) : (
                  <button type="button" className="shortcut-key" onClick={() => startRecord(r.id)} title={t('settings.shortcuts.record')}>
                    {eff ? formatHotkey(eff, mac) : <span className="shortcut-unbound">{t('settings.shortcuts.unbound')}</span>}
                  </button>
                )}
                {isCustomized(r) && recId !== r.id && (
                  <button type="button" className="icon-btn" style={{ width: 26, height: 26 }} title={t('settings.shortcuts.reset')} onClick={() => clearOverride(r.id)}>
                    <RotateCcw size={13} />
                  </button>
                )}
                {eff && recId !== r.id && (
                  <button type="button" className="icon-btn" style={{ width: 26, height: 26 }} title={t('settings.shortcuts.clear')} onClick={() => setOverride(r.id, '')}>
                    <X size={13} />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <div className="field-row" style={{ marginTop: 12 }}>
        <button type="button" className="btn sm" onClick={() => resetAll()}>{t('settings.shortcuts.resetAll')}</button>
      </div>
    </div>
  )
}
