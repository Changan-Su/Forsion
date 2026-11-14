/**
 * 本机多 Unit 的三个对话框:添加 Unit(新建 / 打开已有的文件夹)、改名字和图标、从列表移除的确认。
 * 都从头像面板里点出来 —— 面板先收起,对话框还得活着,所以它们不挂在面板里:请求放进 useLocalUnitDialog,
 * 由 AccountCard 旁边的 LocalUnitDialogHost 画(和 UninstallDialog 同一个壳:portal → .am-app.tangu-lovable → DialogOverlay > .dialog)。
 * 接口一律经 localUnitCall(抛错折成 io);错误码按 localUnitErrorText 说人话,能落到哪个输入框就写在那个输入框下面。
 */
import React, { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { FolderOpen, Plus } from 'lucide-react'
import { DialogOverlay } from '@amadeus/components/DialogOverlay'
import { ConfirmDialog } from '@amadeus/components/Dialogs'
import { IconPicker } from '@amadeus/chrome/pageChrome'
import { askString } from '@amadeus/components/askString'
import { isValidLocalUnitName, localUnitFolderName, type LocalUnitRow } from '../../../shared/localUnits'
import { registerMessages, translate, useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import { LocalUnitIcon, localUnitCall, localUnitErrorText, useLocalUnits } from './localUnits'
import { normalizeUnitAddress, runUnitRoute } from './UnitSwitcher'

registerMessages({
  'unit.local.addTitle': { zh: '添加 Unit', en: 'Add a Unit' },
  'unit.local.modeNew': { zh: '在这台电脑上新建', en: 'Create on this computer' },
  'unit.local.modeNewSub': { zh: '一份全新的 Forsion', en: 'A brand-new Forsion' },
  'unit.local.modeExisting': { zh: '打开已有的 Unit 文件夹', en: 'Open an existing Unit folder' },
  'unit.local.modeExistingSub': { zh: '之前建过、或从别处搬来的', en: 'Made before, or moved here' },
  'unit.local.nameIcon': { zh: '名字和图标', en: 'Name and icon' },
  'unit.local.namePlaceholder': { zh: '比如：实验用', en: 'e.g. Experiments' },
  'unit.local.chooseIcon': { zh: '选图标', en: 'Choose icon' },
  'unit.local.location': { zh: '位置', en: 'Location' },
  'unit.local.change': { zh: '更改…', en: 'Change…' },
  'unit.local.hint': { zh: '这个文件夹会装下这台 Unit 的登录、设置、Agent、插件、对话和笔记。', en: "This folder holds this Unit's sign-in, settings, agents, plugins, chats and notes." },
  'unit.local.createOpen': { zh: '创建并打开', en: 'Create and open' },
  'unit.local.existingHint': { zh: '选一个装着 forsion-unit.json 的文件夹。它会出现在「这台电脑」里，文件夹留在原处。', en: 'Pick a folder with a forsion-unit.json file in it. It shows up under This computer and stays where it is.' },
  'unit.local.chooseFolder': { zh: '选择文件夹…', en: 'Choose folder…' },
  'unit.local.otherDevice': { zh: '要连另一台设备？', en: 'Connecting to another device?' },
  'unit.local.added': { zh: '已添加「{name}」', en: 'Added "{name}"' },
  'unit.local.createdOpenFailed': { zh: '已创建「{name}」，但没能打开：{error}', en: 'Created "{name}" but couldn\'t open it: {error}' },
  'unit.local.editTitle': { zh: '改名字和图标', en: 'Edit name and icon' },
  'unit.local.save': { zh: '保存', en: 'Save' },
  'unit.local.removeTitle': { zh: '从列表移除「{name}」？', en: 'Remove "{name}" from the list?' },
  'unit.local.removeMsg': { zh: '只是从列表里拿掉，文件夹和里面的数据都还在。', en: 'This only takes it off the list. The folder and everything in it stay where they are.' },
  'unit.local.removeConfirm': { zh: '移除', en: 'Remove' },
  'unit.local.removed': { zh: '已从列表移除「{name}」', en: 'Removed "{name}" from the list' },
})

export type LocalUnitDialogReq =
  | { kind: 'add' }
  | { kind: 'edit'; unit: LocalUnitRow }
  | { kind: 'remove'; unit: LocalUnitRow }

export const useLocalUnitDialog = create<{ req: LocalUnitDialogReq | null; open: (r: LocalUnitDialogReq) => void; close: () => void }>((set) => ({
  req: null,
  open: (req) => set({ req }),
  close: () => set({ req: null }),
}))

type Toast = (text: string, error?: boolean) => void

/** 父目录的显示串 + 文件夹名(照显示串自己的分隔符拼:Windows 的显示路径是反斜杠)。 */
export function joinDisplay(parent: string, leaf: string): string {
  if (!parent) return leaf // 快照还没读到(或读不出):不知道缺省父目录,只写文件夹名,不编一个
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/'
  return `${parent.replace(/[\\/]+$/, '')}${sep}${leaf}`
}

/** 对话框里的错误:落在哪个输入框下面。 */
type FieldErr = { at: 'name' | 'location' | 'general'; text: string } | null

function errAt(code: string): 'name' | 'location' | 'general' {
  if (code === 'name_invalid') return 'name'
  if (code === 'path_exists' || code === 'parent_invalid') return 'location'
  return 'general'
}

/** 名字输入框 + 右边那枚图标钮(新建与改名共用);图标钮点开 = 笔记 / 会话那套 emoji 选择(IconPicker),盖在对话框之上。 */
function NameIconRow({ name, icon, onName, onIcon, onEnter, err }: {
  name: string; icon: string; onName: (v: string) => void; onIcon: (v: string) => void; onEnter: () => void; err: string | null
}): React.ReactElement {
  const { t } = useI18n()
  const [pick, setPick] = useState<{ x: number; y: number } | null>(null)
  const errId = useId()
  return (
    <div className="lu-field">
      <span className="lu-label">{t('unit.local.nameIcon')}</span>
      <div className="lu-row">
        <input
          className="dialog-input"
          data-lu="name"
          autoFocus
          value={name}
          maxLength={80}
          placeholder={t('unit.local.namePlaceholder')}
          aria-label={t('unit.local.nameIcon')}
          aria-invalid={err ? true : undefined}
          aria-describedby={err ? errId : undefined}
          onChange={(e) => onName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); onEnter() } }}
        />
        <button
          type="button"
          className="dialog-btn lu-iconbtn"
          data-lu="icon"
          title={t('unit.local.chooseIcon')}
          aria-label={t('unit.local.chooseIcon')}
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPick({ x: r.left, y: r.bottom + 4 }) }}
        >
          <LocalUnitIcon icon={icon} size={16} />
        </button>
      </div>
      {err && <div className="lu-err" id={errId} role="alert">{err}</div>}
      {pick && createPortal(
        // 盖在对话框(.dialog-overlay)之上:从弹窗里开出来的盖在它上面(DESIGN §3 浮层与层级)
        <div className="lu-iconlayer" data-lu-iconpick="">
          <IconPicker x={pick.x} y={pick.y} current={icon || null} onPick={(em) => { onIcon(em ?? ''); setPick(null) }} onClose={() => setPick(null)} />
        </div>,
        document.body,
      )}
    </div>
  )
}

/** Esc 关对话框;图标选择开着时 Esc 只收它(它自己的输入框里按的 Esc 由它自己收)。 */
function useDialogEscape(onClose: () => void): void {
  const latest = useRef(onClose)
  latest.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // 选择器自己的输入框里按的:它已经在 React 里把自己收了(DOM 可能已经摘掉),target 的祖先链还认得出来
      const from = e.target instanceof Element ? e.target : null
      if (from?.closest('[data-lu-iconpick], .amx-iconpick') || document.querySelector('[data-lu-iconpick]')) return
      latest.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

function AddUnitDialog({ onClose, toast }: { onClose: () => void; toast: Toast }): React.ReactElement {
  const { t } = useI18n()
  const titleId = useId()
  const snap = useLocalUnits((s) => s.snapshot)
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [name, setName] = useState('')
  const [icon, setIcon] = useState('')
  const [parent, setParent] = useState<{ path: string; display: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<FieldErr>(null)
  useDialogEscape(onClose)

  const folder = localUnitFolderName(name)
  const parentDisplay = parent?.display ?? snap?.defaultParentDisplay ?? ''
  const location = joinDisplay(parentDisplay, folder ?? '…')
  const canCreate = isValidLocalUnitName(name) && !busy

  const create = async (): Promise<void> => {
    if (!canCreate) return
    setBusy(true)
    setErr(null)
    const trimmed = name.trim()
    const r = await localUnitCall((api) => api.create({ name: trimmed, icon, ...(parent ? { parentDir: parent.path } : {}) }))
    if (!r.ok) {
      setBusy(false)
      const text = localUnitErrorText(r.code)
      if (text) setErr({ at: errAt(r.code), text })
      return
    }
    // 建好了:先关对话框(再试一次只会撞上 path_exists),再在它自己的窗口里打开;打不开只说一句,行已经在面板里了
    onClose()
    const o = await localUnitCall((api) => api.open(r.unit.id))
    if (!o.ok) {
      const text = localUnitErrorText(o.code)
      if (text) toast(translate('unit.local.createdOpenFailed', { name: r.unit.name, error: text }), true)
    }
  }
  const changeParent = async (): Promise<void> => {
    const api = window.tangu?.localUnits
    if (!api || busy) return
    const p = await api.chooseParent().catch(() => null)
    if (p && typeof p.path === 'string' && typeof p.display === 'string') {
      setParent(p)
      if (err?.at === 'location') setErr(null)
    }
  }
  const addExisting = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setErr(null)
    const r = await localUnitCall((api) => api.addExisting())
    setBusy(false)
    if (r.ok) {
      onClose()
      toast(translate('unit.local.added', { name: r.unit.name }))
      return
    }
    const text = localUnitErrorText(r.code)
    if (text) setErr({ at: 'general', text })
  }
  const byAddress = (): void => {
    onClose()
    void askString(t('unit.byAddressAsk'), 'http://').then((v) => {
      const url = normalizeUnitAddress(v ?? '')
      if (url) runUnitRoute({ kind: 'addr', url })
    })
  }
  const pickMode = (m: 'new' | 'existing'): void => { if (!busy) { setMode(m); setErr(null) } }

  return (
    <DialogOverlay onMouseDown={onClose}>
      <div className="dialog lu-dlg" role="dialog" aria-modal="true" aria-labelledby={titleId} data-lu-dialog="add" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title" id={titleId}>{t('unit.local.addTitle')}</div>
        <div className="lu-modes" role="radiogroup" aria-label={t('unit.local.addTitle')}>
          <button type="button" role="radio" className="lu-mode" data-lu-mode="new" aria-checked={mode === 'new'} onClick={() => pickMode('new')}>
            <Plus size={15} />
            <span className="lu-mode-text"><span className="lu-mode-title">{t('unit.local.modeNew')}</span><span className="lu-mode-sub">{t('unit.local.modeNewSub')}</span></span>
          </button>
          <button type="button" role="radio" className="lu-mode" data-lu-mode="existing" aria-checked={mode === 'existing'} onClick={() => pickMode('existing')}>
            <FolderOpen size={15} />
            <span className="lu-mode-text"><span className="lu-mode-title">{t('unit.local.modeExisting')}</span><span className="lu-mode-sub">{t('unit.local.modeExistingSub')}</span></span>
          </button>
        </div>
        {mode === 'new' ? (
          <>
            <NameIconRow name={name} icon={icon} onName={(v) => { setName(v); if (err?.at === 'name' || err?.at === 'location') setErr(null) }} onIcon={setIcon} onEnter={() => void create()} err={err?.at === 'name' ? err.text : null} />
            <div className="lu-field">
              <span className="lu-label">{t('unit.local.location')}</span>
              <div className="lu-row">
                <input className="dialog-input lu-path" data-lu="location" readOnly value={location} title={location} aria-label={t('unit.local.location')} />
                <button type="button" className="dialog-btn" data-lu="change" disabled={busy} onClick={() => void changeParent()}>{t('unit.local.change')}</button>
              </div>
              {err?.at === 'location' && <div className="lu-err" role="alert">{err.text}</div>}
            </div>
            <div className="dialog-msg lu-hint">{t('unit.local.hint')}</div>
          </>
        ) : (
          <div className="dialog-msg lu-hint">{t('unit.local.existingHint')}</div>
        )}
        {err?.at === 'general' && <div className="lu-err" role="alert" data-lu="error">{err.text}</div>}
        <div className="lu-other">
          {t('unit.local.otherDevice')}
          <button type="button" className="lu-link" data-lu="address" onClick={byAddress}>{t('unit.byAddress')}</button>
        </div>
        <div className="dialog-actions">
          <button type="button" className="dialog-btn" onClick={onClose}>{t('amdlg.cancel')}</button>
          {mode === 'new'
            ? <button type="button" className="dialog-btn" data-primary data-lu="create" disabled={!canCreate} onClick={() => void create()}>{t('unit.local.createOpen')}</button>
            : <button type="button" className="dialog-btn" data-primary data-lu="choose" disabled={busy} onClick={() => void addExisting()}>{t('unit.local.chooseFolder')}</button>}
        </div>
      </div>
    </DialogOverlay>
  )
}

function EditUnitDialog({ unit, onClose, toast }: { unit: LocalUnitRow; onClose: () => void; toast: Toast }): React.ReactElement {
  const { t } = useI18n()
  const titleId = useId()
  const [name, setName] = useState(unit.name)
  const [icon, setIcon] = useState(unit.icon)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<FieldErr>(null)
  useDialogEscape(onClose)
  const patch: { name?: string; icon?: string } = {
    ...(name.trim() !== unit.name ? { name: name.trim() } : {}),
    ...(icon !== unit.icon ? { icon } : {}),
  }
  const dirty = Object.keys(patch).length > 0
  const canSave = !busy && isValidLocalUnitName(name)
  const save = async (): Promise<void> => {
    if (!canSave) return
    if (!dirty) { onClose(); return }
    setBusy(true)
    setErr(null)
    const r = await localUnitCall((api) => api.rename(unit.id, patch))
    setBusy(false)
    if (r.ok) { onClose(); return }
    const text = localUnitErrorText(r.code)
    if (!text) return
    // 名字以外的错(被移除了 / 读不出名册 / 写不进标记)不落在输入框下面,关掉说一句
    if (errAt(r.code) === 'name') setErr({ at: 'name', text })
    else { onClose(); toast(translate('unit.local.actionFailed', { error: text }), true) }
  }
  return (
    <DialogOverlay onMouseDown={onClose}>
      <div className="dialog lu-dlg lu-dlg--edit" role="dialog" aria-modal="true" aria-labelledby={titleId} data-lu-dialog="edit" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title" id={titleId}>{t('unit.local.editTitle')}</div>
        <NameIconRow name={name} icon={icon} onName={(v) => { setName(v); if (err) setErr(null) }} onIcon={setIcon} onEnter={() => void save()} err={err?.text ?? null} />
        <div className="dialog-actions">
          <button type="button" className="dialog-btn" onClick={onClose}>{t('amdlg.cancel')}</button>
          <button type="button" className="dialog-btn" data-primary data-lu="save" disabled={!canSave} onClick={() => void save()}>{t('unit.local.save')}</button>
        </div>
      </div>
    </DialogOverlay>
  )
}

/** 挂在 AccountCard 旁边:面板收起以后对话框照样在。 */
export function LocalUnitDialogHost({ onToast }: { onToast?: Toast }): React.ReactElement | null {
  const req = useLocalUnitDialog((s) => s.req)
  if (!req || !window.tangu?.localUnits) return null
  const close = (): void => { if (useLocalUnitDialog.getState().req === req) useLocalUnitDialog.getState().close() }
  const toast: Toast = onToast ?? ((text, error) => useApp.getState().toast(text, error))
  const remove = async (u: LocalUnitRow): Promise<void> => {
    const r = await localUnitCall((api) => api.remove(u.id))
    if (r.ok) toast(translate('unit.local.removed', { name: u.name }))
    else {
      const text = localUnitErrorText(r.code)
      if (text) toast(translate('unit.local.actionFailed', { error: text }), true)
    }
  }
  return createPortal(
    <div className="am-app tangu-lovable" style={{ display: 'contents' }} data-local-unit-dialog={req.kind}>
      {req.kind === 'add' && <AddUnitDialog key="add" onClose={close} toast={toast} />}
      {req.kind === 'edit' && <EditUnitDialog key={`edit:${req.unit.id}`} unit={req.unit} onClose={close} toast={toast} />}
      {req.kind === 'remove' && (
        <ConfirmDialog
          title={translate('unit.local.removeTitle', { name: req.unit.name })}
          message={translate('unit.local.removeMsg')}
          confirmLabel={translate('unit.local.removeConfirm')}
          danger={false}
          onConfirm={() => void remove(req.unit)}
          onClose={close}
        />
      )}
    </div>,
    document.body,
  )
}
