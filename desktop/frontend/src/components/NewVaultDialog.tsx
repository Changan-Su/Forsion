import { useEffect, useRef, useState } from 'react'
import { amadeus } from '@amadeus/api'
import { usePageStore } from '@amadeus/store/pageStore'
import { useI18n } from '../i18n'
import { vaultSync } from '../sync/v2/client'
import { checkNewVaultName, runCreateVault, type CreateVaultRun, type NameCheck, type UploadOption } from '../sync/v2/createVault'
import { downloadTargetPath, type DownloadLibrary } from '../sync/v2/download'
import { folderHost, validLandingName } from '../sync/v2/vaultSurfaces'
import { refreshVaultSync } from '../sync/vaultSyncStore'
import { discardRemoved } from '../sync/v2/createdFolder'
import { landingError } from './vaultLandingMessages'
import { VaultLandingDialog } from './VaultLandingDialog'

type Issue = Extract<CreateVaultRun, { kind: 'name_exists' | 'name_rejected' | 'host_failed' | 'host_invalid' }>
export function NewVaultDialog({ option, onClose, onDownload, onCreated }: {
  option: UploadOption | { available: false; defaultChecked: false; reason: 'offline' } | null
  onClose: () => void
  onDownload: (library: DownloadLibrary) => void
  onCreated: (result: Extract<CreateVaultRun, { kind: 'created' }>, name: string) => void
}) {
  const { t } = useI18n()
  const [value, setValue] = useState('')
  const [checked, setChecked] = useState(option?.defaultChecked ?? false)
  const [parent, setParent] = useState('')
  const [busy, setBusy] = useState(false)
  const [pre, setPre] = useState<NameCheck | null>(null)
  const [issue, setIssue] = useState<Issue | null>(null)
  const [lookupFailed, setLookupFailed] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const inFlight = useRef(false)
  const name = validLandingName(value) ? value : null
  const invalid = !!value.trim() && !name
  const upload = checked && option?.available === true

  useEffect(() => {
    let active = true
    void folderHost(amadeus)?.parent().then((p) => { if (active) setParent(p.path) }, () => {})
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!name || !upload) return
    let active = true
    const timer = setTimeout(() => {
      void checkNewVaultName(vaultSync.resolveName, name).then((result) => { if (active) setPre(result) })
    }, 300)
    return () => { active = false; clearTimeout(timer) }
  }, [name, upload])

  const close = () => { if (!inFlight.current) onClose() }
  const clearIssue = () => { setPre(null); setIssue(null); setLookupFailed(false) }
  const collision = issue?.kind === 'name_exists' ? issue : pre?.kind === 'name_exists' ? pre : null
  const nameProblem = issue?.kind === 'name_rejected' ? issue.code : pre?.kind === 'reserved' || pre?.kind === 'invalid_name' ? pre.kind : null
  const error = invalid ? t('landing.invalidHostName') : nameProblem ? landingError(t, nameProblem, value)
    : issue?.kind === 'host_failed' ? (issue.code === 'invalid_name' ? t('landing.invalidHostName') : landingError(t, issue.code, value))
      : issue?.kind === 'host_invalid' ? t('landing.err.failed') : null
  const cleanup = issue && 'cleanup' in issue ? issue.cleanup : null

  const submit = async () => {
    if (inFlight.current || !name || collision || nameProblem) return
    const host = folderHost(amadeus)
    if (!host) return
    inFlight.current = true
    setBusy(true)
    const result = await runCreateVault({
      ...host, currentAccount: async () => {
        const auth = await window.tangu?.authStatus?.()
        return auth?.loggedIn === true ? auth.accountId ?? null : null
      }, resolveName: vaultSync.resolveName, create: vaultSync.create,
      open: (root) => usePageStore.getState().switchLocalVault(root),
    }, { name, upload }).catch(() => ({ kind: 'host_invalid' }) as const)
    inFlight.current = false
    setBusy(false)
    if (result.kind === 'created') { refreshVaultSync(); onClose(); onCreated(result, name); return }
    if (result.kind !== 'empty_name') setIssue(result)
  }

  const download = async () => {
    const id = collision?.libraryId
    if (!id || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    const lookup = await vaultSync.libraries(true)
    const lib = lookup.ok && !lookup.value.stale && lookup.value.list.libraries.find((v) => v.id === id && !v.deleted)
    inFlight.current = false
    setBusy(false)
    if (lib) { onDownload(lib); return }
    setLookupFailed(true)
  }

  const hint = option?.available ? 'landing.uploadHint'
    : option?.reason === 'not_signed_in' ? 'landing.uploadSignIn'
      : option?.reason === 'unknown' ? 'landing.unknown'
        : `landing.err.${option?.reason === 'not_full' ? 'compat_mode' : option?.reason}`
  return <VaultLandingDialog kind="new" title={t('vaultMenu.newTitle')} onClose={close} onSubmit={() => void submit()}>
    <label className="landing-detail">
      <input aria-label={t('landing.name')} ref={input} autoFocus className="dialog-input" value={value} disabled={busy} aria-invalid={invalid || !!nameProblem}
        onChange={(e) => { setValue(e.target.value); clearIssue() }} />
    </label>
    {parent && <div className="landing-detail">{t('landing.willCreate', { path: name ? downloadTargetPath(parent, name) : parent })}</div>}
    {option && <label className="dialog-check">
      <input type="checkbox" checked={upload} disabled={!option.available || busy} onChange={(e) => { setChecked(e.target.checked); clearIssue() }} />
      <span>{t('landing.upload')}<small className="landing-detail">{t(hint)}</small></span>
    </label>}
    {error && <div role="alert" className="dialog-msg landing-warn">{error}</div>}
    {collision && <div className="landing-box landing-detail" role="status">
      {t('landing.nameExists', { name })}
      <div className="dialog-actions">
        <button type="button" className="dialog-btn" disabled={busy || !collision.libraryId || !amadeus.vaultSyncActions?.().download}
          onClick={() => void download()}>{t('landing.downloadExisting')}</button>
        <button type="button" className="dialog-btn" disabled={busy} onClick={() => { input.current?.focus(); input.current?.select() }}>{t('landing.rename')}</button>
      </div>
      {lookupFailed && <div className="landing-warn">{t('landing.cloudUnreadable')}</div>}
    </div>}
    {cleanup === 'removed_still_listed' && <div className="dialog-msg">{t('landing.folderStillListed')}</div>}
    {cleanup && !discardRemoved(cleanup) && parent && name && validLandingName(name) &&
      <div className="dialog-msg">{t('landing.folderKept', { path: downloadTargetPath(parent, name) })}</div>}
    <div className="dialog-actions">
      <button type="button" className="dialog-btn" disabled={busy} onClick={close}>{t('amdlg.cancel')}</button>
      <button type="submit" className="dialog-btn" data-primary disabled={busy || !name || !!collision || !!nameProblem}>{t(busy ? 'landing.working' : 'vaultMenu.create')}</button>
    </div>
  </VaultLandingDialog>
}
