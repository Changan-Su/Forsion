import { useEffect, useRef, useState } from 'react'
import { Folder } from 'lucide-react'
import { amadeus } from '@amadeus/api'
import { useI18n } from '../i18n'
import { bytesText } from '../sync/VaultSyncPanel'
import { checkDownload, downloadBlock, downloadFolderName, downloadTargetPath, runDownload, type DownloadCheckState, type DownloadLibrary, type DownloadRun } from '../sync/v2/download'
import { vaultSync } from '../sync/v2/client'
import { folderHost, validLandingName } from '../sync/v2/vaultSurfaces'
import { openSyncSettings } from '../sync/v2/openSyncSettings'
import { refreshVaultSync } from '../sync/vaultSyncStore'
import type { VaultSyncPreviewArgs } from '../sync/v2/types'
import { discardRemoved } from '../sync/v2/createdFolder'
import { landingError } from './vaultLandingMessages'
import { VaultLandingDialog } from './VaultLandingDialog'

export function DownloadVaultDialog({ library, onClose, onPreview, onStarted }: {
  library: DownloadLibrary
  onClose: () => void
  onPreview: (preview: VaultSyncPreviewArgs, name: string) => void
  onStarted?: () => void
}) {
  const { t } = useI18n()
  const name = downloadFolderName(library, t('amadeus.default.cloudNotes'))
  const invalid = !validLandingName(name)
  const [locationRevision, setLocationRevision] = useState(0)
  const [parent, setParent] = useState<string | null>(null)
  const [check, setCheck] = useState<DownloadCheckState>({ kind: 'checking' })
  const [error, setError] = useState<string | null>(null)
  const [runResult, setRunResult] = useState<DownloadRun | null>(null)
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const inFlight = useRef(false)
  useEffect(() => {
    let active = true
    if (invalid) return
    if (library.kind === 'default') { setCheck(downloadBlock('default_unsupported')); return }
    const host = folderHost(amadeus)
    if (!host) { setCheck(downloadBlock('channel_missing')); return }
    void host.parent().then((p) => { if (active) setParent(p) }, () => { if (active) setCheck(downloadBlock('failed')) })
    return () => { active = false }
  }, [invalid, library.kind])

  useEffect(() => {
    if (!parent || invalid) return
    let active = true
    void checkDownload(vaultSync, library, parent).then((r) => {
      if (!active) return
      setCheck((r.kind === 'ready' || r.kind === 'compare') && r.name !== name ? downloadBlock('name_mismatch') : r)
    })
    return () => { active = false }
  }, [parent, locationRevision, invalid, library.id, library.kind, library.name, name]) // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => { if (!inFlight.current) onClose() }
  const pick = async () => {
    const selected = await window.tangu?.pickDirectory?.({ purpose: 'project' }).catch(() => null)
    if (!selected) return
    setLocationRevision((revision) => revision + 1)
    setCheck({ kind: 'checking' }); setError(null); setRunResult(null); setRenaming(false); setParent(selected)
  }
  const submit = async () => {
    if (inFlight.current || invalid || renaming || check.kind === 'checking') return
    if (check.kind === 'already_local') {
      if (check.root) { onClose(); openSyncSettings({ root: check.root, intent: 'start' }) }
      return
    }
    if (check.kind === 'blocked') {
      if (check.primary === 'open_settings') { onClose(); openSyncSettings() }
      return
    }
    const host = folderHost(amadeus)
    if (!parent || !host) return
    inFlight.current = true
    setBusy(true)
    const result = await runDownload({ ...host, download: vaultSync.download }, library, check, { parent, folderName: name })
      .catch(() => ({ kind: 'host_failed', code: 'failed' }) as const)
    inFlight.current = false
    setBusy(false)
    if (result.kind === 'started') { refreshVaultSync(); onClose(); onStarted?.(); return }
    if (result.kind === 'needs_preview') { onClose(); onPreview(result.preview, name); return }
    setRunResult(result)
    if (result.kind === 'blocked') setCheck(result.state)
    else if (result.kind === 'host_failed') setError(result.code === 'invalid_name' ? t('landing.invalidHostName') : landingError(t, result.code, name))
    else setError(t('landing.err.failed'))
  }
  const canChange = !invalid && !!window.tangu?.pickDirectory && (check.kind === 'checking' || check.canChangeLocation)
  const primary = invalid || renaming || check.kind === 'checking' ? 'none' : check.primary
  const label = { none: 'landing.start', download: 'landing.start', compare: 'landing.compare', sync_existing: 'landing.syncExisting', open_settings: 'landing.settings' }[primary]
  const amount = check.kind === 'ready' || check.kind === 'compare' ? t('landing.amount', { n: check.files, size: bytesText(check.bytes) })
    : check.kind === 'blocked' && check.bytes !== undefined ? bytesText(check.bytes) : null
  const freeBytes = check.kind === 'ready' || check.kind === 'compare' || check.kind === 'blocked' ? check.freeBytes : null
  const cleanup = runResult?.kind === 'blocked' ? runResult.cleanup : null

  return <VaultLandingDialog kind="download" title={t('landing.downloadTitle', { name })} onClose={close} onSubmit={() => void submit()}>
    {check.kind !== 'already_local' && parent && <>
      <div className="landing-location">
        <div className="landing-path" aria-label={t('landing.location')}><Folder size={15} aria-hidden="true" /><span>{downloadTargetPath(parent, name)}</span></div>
        {canChange && <button className="dialog-btn" type="button" disabled={busy} onClick={() => void pick()}>{t('landing.change')}</button>}
      </div>
      <div className="landing-detail">{t('landing.locationHint')}</div>
    </>}
    {!invalid && (check.kind === 'checking' || amount || freeBytes != null) && <div className="landing-measures landing-detail">
      {check.kind === 'checking' ? t('landing.checking') : amount}
      {freeBytes != null && <span className={check.kind === 'blocked' ? 'landing-warn' : undefined}>{t('landing.free', { size: bytesText(freeBytes) })}</span>}
    </div>}
    {(invalid || error || check.kind === 'blocked') && <div role="alert" className="dialog-msg landing-warn">{invalid ? t('landing.invalidHostName') : error ?? (check.kind === 'blocked' && landingError(t, check.code, name))}</div>}
    {check.kind === 'already_local' && <div className="dialog-msg">{t('landing.alreadyLocal', { name })} {check.root}</div>}
    {check.kind === 'ready' && <div className="dialog-msg">{t(check.state === 'empty' ? 'landing.emptyFolder' : 'landing.newFolder')}</div>}
    {check.kind === 'compare' && <div className="dialog-msg">{t(renaming ? 'landing.renameFirst' : 'landing.nonemptyFolder')}</div>}
    {cleanup && cleanup === 'removed_still_listed' && <div className="dialog-msg">{t('landing.folderStillListed')}</div>}
    {cleanup && !discardRemoved(cleanup) && runResult?.kind === 'blocked' && <div className="dialog-msg">{t('landing.folderKept', { path: runResult.root })}</div>}
    <div className="dialog-actions">
      {check.kind === 'compare' && <button type="button" className="dialog-btn landing-button-first" disabled={busy} onClick={() => setRenaming(true)}>{t('landing.different')}</button>}
      <button type="button" className="dialog-btn" autoFocus disabled={busy} onClick={close}>{t('amdlg.cancel')}</button>
      <button type="submit" className="dialog-btn" data-primary disabled={busy || primary === 'none' || (check.kind === 'already_local' && !check.root)}>{t(busy ? 'landing.working' : label)}</button>
    </div>
  </VaultLandingDialog>
}
