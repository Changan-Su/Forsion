/**
 * 设置 → 快捷键:列出命令面板 + 所有注册命令,显示/录制/重置/解绑自定义热键。
 * 生效与分发由 engine/shortcutStore(覆盖)+ commandRegistry.installHotkeys 负责;此处只读写覆盖。
 *
 * 冲突与反查(方案 docs/ToBeImproved/快捷键录入与冲突方案_2026-10-17,选 A「就地」):
 *  - 录制撞上别的命令 → 行下展开提示行,点「改绑到这里」才解绑对方;撞上系统保留键 → 拦下,只能换一个。
 *  - 编辑器正文里会先吃掉的键 → 能存,存完提示一句。三层的表见 shortcutUsage.ts。
 *  - 搜索框的「按键」开关:按真键筛出用它的命令,另列编辑器 / 系统那两层。
 *  - 静止时就撞键的(插件默认键互撞)→ 工具栏「N 处冲突」+ 行尾标签。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Ban, Info, Keyboard, RotateCcw, Search, TriangleAlert, X } from 'lucide-react'
import { useCommandStore, useShortcuts, eventToHotkey, formatHotkey, pairHotkeyOf } from '@lcl/engine'
import { useI18n } from '../i18n'
import { conflictGroups, editorUseOf, normalizeHotkey, systemReservedOf } from '../shortcutUsage'
import { SettingsPanel } from './SettingsPrimitives'

/** 录制 / 按键查找期间请主进程挂起全局快捷键(Mini ⌘⇧M、急停):macOS 上它们先于窗口拿到按键。网页 / 旧 preload 没有这条 → 跳过。 */
const pauseGlobal = (on: boolean): void => { try { void window.tangu?.shortcuts?.pauseGlobal(on).catch(() => {}) } catch { /* 旧 preload */ } }

const isMac = (): boolean => { try { return document.documentElement.dataset.platform === 'mac' } catch { return false } }

interface Row { id: string; title: string; def: string }
/** 录到了键但还没存:撞上别的命令(等用户点「改绑到这里」)或撞上系统保留(只能换一个)。 */
type Pending = { id: string; hk: string; kind: 'conflict'; others: Row[] } | { id: string; hk: string; kind: 'system'; action: string }

/** 一次按键 → 热键(左右修饰键同按也算);纯修饰键 → null。 */
const hotkeyOfEvent = (e: React.KeyboardEvent): string | null => pairHotkeyOf(e.nativeEvent) ?? eventToHotkey(e.nativeEvent)

export const ShortcutsTab: React.FC = () => {
  const { t } = useI18n()
  const commands = useCommandStore((s) => s.commands)
  const overrides = useShortcuts((s) => s.overrides)
  const { setOverride, clearOverride, resetAll, setRecording } = useShortcuts.getState()
  const [recId, setRecId] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [note, setNote] = useState('')
  const [query, setQuery] = useState('')
  const [keyMode, setKeyMode] = useState(false)
  const [keyQuery, setKeyQuery] = useState('')
  const [onlyConflicts, setOnlyConflicts] = useState(false)
  const mac = isMac()
  const keyQueryRef = useRef<HTMLSpanElement>(null)
  useEffect(() => { if (keyMode) keyQueryRef.current?.focus() }, [keyMode])
  // 录制 / 按键查找中途被卸载(设置浮窗换页、重挂)时不会有 blur:这里兜底恢复全局热键分发
  useEffect(() => () => { useShortcuts.getState().setRecording(false); pauseGlobal(false) }, [])

  // 命令面板是引擎内置(非注册命令),作伪命令排首位;其余跟随注册命令。
  const rows: Row[] = [
    { id: 'command-palette', title: t('settings.shortcuts.commandPalette'), def: 'mod+k' },
    ...commands.map((c) => ({ id: c.id, title: typeof c.title === 'function' ? c.title() : c.title, def: c.hotkey || '' })),
  ]
  const effOf = (r: Row): string =>
    Object.prototype.hasOwnProperty.call(overrides, r.id) ? (overrides[r.id] || '') : r.def
  const isCustomized = (r: Row): boolean =>
    Object.prototype.hasOwnProperty.call(overrides, r.id) && (overrides[r.id] || '') !== r.def
  const groups = conflictGroups(rows, effOf)
  const othersOf = (r: Row): Row[] => { const eff = effOf(r); return eff ? (groups.get(normalizeHotkey(eff)) ?? []).filter((o) => o.id !== r.id) : [] }
  const quoteList = (list: Row[]): string => list.map((r) => t('settings.shortcuts.quoted', { name: r.title })).join(t('settings.shortcuts.listSep'))
  const fmt = (hk: string): string => formatHotkey(hk, mac)
  const caps = (hk: string): React.ReactNode => hk.split('+').map((p, i) => <kbd key={i} className="shortcut-cap">{fmt(p)}</kbd>)

  const visibleRows = rows.filter((r) => {
    if (keyMode) return !!keyQuery && !!effOf(r) && normalizeHotkey(effOf(r)) === keyQuery
    if (onlyConflicts && othersOf(r).length === 0) return false
    const q = query.trim().toLowerCase()
    return !q || r.title.toLowerCase().includes(q) || r.id.toLowerCase().includes(q) || effOf(r).toLowerCase().includes(q)
  })

  const capture = (on: boolean): void => { setRecording(on); pauseGlobal(on) }
  const stopRecord = (): void => { setRecId(null); capture(false) }
  const startRecord = (id: string): void => { setNote(''); setPending(null); setRecId(id); capture(true) }
  const save = (id: string, hk: string): void => {
    setOverride(id, hk)
    const action = editorUseOf(hk)
    setNote(action ? t('settings.shortcuts.editorShadowSaved', { key: fmt(hk), action: t(action) }) : '')
  }

  const onRecKey = (e: React.KeyboardEvent): void => {
    e.preventDefault(); e.stopPropagation()
    if (!recId) return
    pauseGlobal(true) // 续上主进程的兜底计时
    if (e.key === 'Escape') { stopRecord(); return }
    // 单按 ⌫ / Delete = 解绑(不当成一个可录的键)
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) { setOverride(recId, ''); stopRecord(); return }
    const hk = hotkeyOfEvent(e)
    if (!hk) return // 纯修饰键 → 继续等
    const id = recId
    stopRecord()
    const action = systemReservedOf(hk, mac)
    if (action) { setPending({ id, hk, kind: 'system', action }); return }
    const others = rows.filter((r) => r.id !== id && effOf(r) && normalizeHotkey(effOf(r)) === normalizeHotkey(hk))
    if (others.length) { setPending({ id, hk, kind: 'conflict', others }); return }
    save(id, hk)
  }

  const reassign = (): void => {
    if (pending?.kind !== 'conflict') return
    // 按确认这一刻的覆盖重算:提示挂着期间别的窗口可能已把对方改成别的键,那条不能再被清掉
    const k = normalizeHotkey(pending.hk)
    for (const o of rows) if (o.id !== pending.id && effOf(o) && normalizeHotkey(effOf(o)) === k) setOverride(o.id, '')
    save(pending.id, pending.hk)
    setPending(null)
  }

  const exitKeyMode = (): void => { setKeyMode(false); setKeyQuery(''); capture(false) }
  const onKeyModeKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Tab') return // 留给焦点移动
    e.preventDefault(); e.stopPropagation()
    pauseGlobal(true)
    if (e.key === 'Escape') { exitKeyMode(); return }
    const hk = hotkeyOfEvent(e)
    if (hk) setKeyQuery(normalizeHotkey(hk))
  }

  const keyEditor = keyQuery ? editorUseOf(keyQuery) : null
  const keySystem = keyQuery ? systemReservedOf(keyQuery, mac) : null
  const keyCount = visibleRows.length + (keyEditor ? 1 : 0) + (keySystem ? 1 : 0)

  const pendingRow = (p: Pending): React.ReactNode => (
    <div
      className={`shortcut-pending shortcut-pending--${p.kind}`}
      role="alert"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setPending(null) } }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPending(null) }}
    >
      {p.kind === 'system' ? <Ban size={14} /> : <TriangleAlert size={14} />}
      <span>
        {p.kind === 'system'
          ? t('settings.shortcuts.pendingSystem', { key: fmt(p.hk), action: t(p.action) })
          : t('settings.shortcuts.pendingConflict', { key: fmt(p.hk), names: quoteList(p.others) })}
      </span>
      <span className="shortcut-pending-actions">
        <button type="button" className="btn ghost sm" autoFocus onClick={() => startRecord(p.id)}>{t('settings.shortcuts.tryAnother')}</button>
        {p.kind === 'conflict' && <button type="button" className="btn primary sm" onClick={reassign}>{t('settings.shortcuts.reassignHere')}</button>}
      </span>
    </div>
  )

  const renderRow = (r: Row): React.ReactNode => {
    const eff = effOf(r)
    const others = othersOf(r)
    const held = pending?.id === r.id ? pending : null
    return (
      <React.Fragment key={r.id}>
        <div className="shortcut-row">
          <span className="shortcut-name">{r.title}</span>
          <div className="shortcut-controls">
            {others.length > 0 && !held && recId !== r.id && (
              <span className="shortcut-conflict-badge">
                <TriangleAlert size={12} />
                {others.length === 1 ? t('settings.shortcuts.conflictWith', { name: others[0].title }) : t('settings.shortcuts.conflictWithMany', { count: others.length })}
              </span>
            )}
            {/* 「恢复默认」排在键帽左边、× 那一格没有也留着(走查续 W-41):键帽右缘一整列对齐,不随有没有绑定 / 改没改过错位 */}
            {isCustomized(r) && recId !== r.id && !held && (
              <button type="button" className="icon-btn" style={{ width: 26, height: 26 }} title={t('settings.shortcuts.reset')} onClick={() => clearOverride(r.id)}>
                <RotateCcw size={13} />
              </button>
            )}
            {recId === r.id ? (
              <input
                className="shortcut-capture" autoFocus readOnly
                value={t('settings.shortcuts.recording')}
                onKeyDown={onRecKey} onBlur={stopRecord}
              />
            ) : held ? (
              <span className={`shortcut-capture shortcut-capture--${held.kind}`}>{caps(held.hk)}</span>
            ) : (
              <button type="button" className="shortcut-key" onClick={() => startRecord(r.id)} title={t('settings.shortcuts.record')}>
                {eff ? fmt(eff) : <span className="shortcut-unbound">{t('settings.shortcuts.unbound')}</span>}
              </button>
            )}
            {eff && recId !== r.id && !held ? (
              <button type="button" className="icon-btn" style={{ width: 26, height: 26 }} title={t('settings.shortcuts.clear')} onClick={() => setOverride(r.id, '')}>
                <X size={13} />
              </button>
            ) : <span className="shortcut-slot" aria-hidden="true" />}
          </div>
        </div>
        {held && pendingRow(held)}
      </React.Fragment>
    )
  }

  return (
    <SettingsPanel
      className="settings-shortcuts-panel"
      icon={<Keyboard size={16} />}
      title={t('settings.shortcuts.commands', { count: rows.length })}
      description={t('settings.shortcuts.desc')}
      actions={<button type="button" className="btn ghost sm" onClick={() => { resetAll(); setPending(null) }}><RotateCcw size={12} />{t('settings.shortcuts.resetAll')}</button>}
    >
      <div className="settings-panel-toolbar">
        <label className="settings-filter-input">
          {keyMode ? (
            <>
              <Keyboard size={13} />
              <span
                ref={keyQueryRef} className="shortcut-keyquery" tabIndex={0} role="textbox" aria-label={t('settings.shortcuts.keyModeTitle')}
                onKeyDown={onKeyModeKey} onFocus={() => capture(true)} onBlur={() => capture(false)}
              >
                {keyQuery ? caps(keyQuery) : <span className="shortcut-keyquery-ph">{t('settings.shortcuts.recording')}</span>}
              </span>
            </>
          ) : (
            <>
              <Search size={13} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('settings.shortcuts.searchPlaceholder')} />
            </>
          )}
          <button
            type="button" className={`shortcut-keymode${keyMode ? ' is-on' : ''}`} aria-pressed={keyMode} title={t('settings.shortcuts.keyModeTitle')}
            onClick={(e) => { e.preventDefault(); if (keyMode) exitKeyMode(); else { setKeyMode(true); setOnlyConflicts(false); setNote(''); setPending(null) } }}
          >
            <Keyboard size={12} />{t('settings.shortcuts.keyMode')}
          </button>
          {(keyMode ? keyQuery : query) && (
            <button type="button" onClick={(e) => { e.preventDefault(); if (keyMode) { setKeyQuery(''); keyQueryRef.current?.focus() } else setQuery('') }} aria-label={t('common.cancel')}><X size={12} /></button>
          )}
        </label>
        {(groups.size > 0 || onlyConflicts) && !keyMode && (
          <button type="button" className={`shortcut-conflict-chip${onlyConflicts ? ' is-on' : ''}`} aria-pressed={onlyConflicts} onClick={() => setOnlyConflicts((v) => !v)}>
            <TriangleAlert size={12} />{t('settings.shortcuts.conflictCount', { count: groups.size })}
          </button>
        )}
        <span>
          {keyMode
            ? (keyQuery ? t('settings.shortcuts.keyResult', { key: fmt(keyQuery), count: keyCount }) : '')
            : t('settings.shortcuts.resultCount', { count: visibleRows.length })}
        </span>
      </div>
      {note && <div className="settings-inline-notice">{note}</div>}
      <div className="shortcut-list">
        {keyMode ? (
          keyQuery ? (
            <>
              <div className="shortcut-group">{t('settings.shortcuts.groupCommands')}</div>
              {visibleRows.length ? visibleRows.map(renderRow) : (
                <div className="settings-empty-row">{t('settings.shortcuts.noCommandUses', { key: fmt(keyQuery) })}</div>
              )}
              {(keyEditor || keySystem) && <div className="shortcut-group">{t('settings.shortcuts.groupElsewhere')}</div>}
              {keyEditor && (
                <>
                  <div className="shortcut-row">
                    <span className="shortcut-name">{t(keyEditor)}<span className="shortcut-layer">{t('settings.shortcuts.layerEditor')}</span></span>
                    <div className="shortcut-controls"><span className="shortcut-key is-static">{fmt(keyQuery)}</span><span className="shortcut-slot" aria-hidden="true" /></div>
                  </div>
                  <div className="shortcut-pending shortcut-pending--info"><Info size={14} /><span>{t('settings.shortcuts.editorHint', { key: fmt(keyQuery), action: t(keyEditor) })}</span></div>
                </>
              )}
              {keySystem && (
                <div className="shortcut-row">
                  <span className="shortcut-name">{t(keySystem)}<span className="shortcut-layer">{t('settings.shortcuts.layerSystem')}</span></span>
                  <div className="shortcut-controls"><span className="shortcut-key is-static">{fmt(keyQuery)}</span><span className="shortcut-slot" aria-hidden="true" /></div>
                </div>
              )}
            </>
          ) : <div className="settings-empty-row">{t('settings.shortcuts.keyModeTitle')}</div>
        ) : (
          <>
            {visibleRows.map(renderRow)}
            {visibleRows.length === 0 && <div className="settings-empty-row">{t('settings.shortcuts.noResults')}</div>}
          </>
        )}
      </div>
    </SettingsPanel>
  )
}
