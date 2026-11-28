import { useRef, useState } from 'react'
import { Cloud, Folder, RefreshCw, TriangleAlert } from 'lucide-react'
import { amadeus } from '@amadeus/api'
import { usePageStore } from '@amadeus/store/pageStore'
import { useI18n } from '../i18n'
import { vaultSync } from '../sync/v2/client'
import { finishStopLanding, prepareStopLanding, stopBindingIdentity } from '../sync/v2/finishStopLanding'
import { runStopLanding, stopPreflight, type StopPhase, type StopRun } from '../sync/v2/stopLanding'
import type { BindingView } from '../sync/v2/types'
import { refreshVaultSync } from '../sync/vaultSyncStore'
import { landingError } from './vaultLandingMessages'
import { VaultLandingDialog } from './VaultLandingDialog'

export function StopDownloadCard({ binding, blocked, onClose, onReview, onStopped }: {
  binding: BindingView
  blocked?: boolean
  onClose: () => void
  onReview: () => void
  onStopped: (forgot: boolean, problem?: string) => void
}) {
  const { t } = useI18n()
  const [confirmed] = useState(() => stopBindingIdentity(binding))
  const [snapshot, setSnapshot] = useState(binding)
  const [result, setResult] = useState<StopRun | null>(null)
  const [phase, setPhase] = useState<StopPhase | null>(null)
  const inFlight = useRef(false)
  const preflight = stopPreflight(snapshot)
  const canStart = !blocked && preflight.eligible
  const name = binding.name
  const close = () => { if (!inFlight.current) onClose() }
  const run = async (syncFirst: boolean, directConfirmed = false) => {
    if (inFlight.current || !canStart) return
    inFlight.current = true
    setPhase(syncFirst ? 'syncing' : 'stopping')
    try {
      const problem = await prepareStopLanding(amadeus, binding.root, usePageStore.getState().vaultRoot)
      if (problem) { setResult({ kind: 'failed', code: problem }); return }
      const fresh = await vaultSync.get()
      const current = fresh.ok && fresh.value?.mode === 'full' && fresh.value.bindings.find((b) => b.id === binding.id)
      if (!fresh.ok) { setResult({ kind: 'failed', code: fresh.error }); return }
      if (!current || !confirmed || stopBindingIdentity(current) !== confirmed) {
        setResult({ kind: 'failed', code: 'stop-binding-changed' })
        return
      }
      const pre = stopPreflight(current)
      if (!pre.eligible) { setResult({ kind: 'busy', code: pre.reason }); return }
      if (!syncFirst && !directConfirmed && pre.recommendSyncFirst) { setSnapshot(current); return }

      const r = await runStopLanding(vaultSync, { bindingId: current.id, syncFirst })
      setResult(r)
      if (r.kind === 'stopped') {
        const after = await vaultSync.get()
        const unbound = r.root === binding.root && after.ok && after.value?.mode === 'full' && !after.value.bindings.some((b) => b.root === r.root)
        const problem = unbound ? await finishStopLanding(amadeus, r.root, () => usePageStore.getState().vaultRoot,
          (root) => usePageStore.getState().switchLocalVault(root)) : null
        const forgot = unbound && !problem && await amadeus.forgetVault?.(r.root).catch(() => false) === true
        onClose()
        if (problem) onStopped(false, problem)
        else onStopped(forgot)
      }
    } catch { setResult({ kind: 'failed', code: 'failed' }) }
    finally { inFlight.current = false; setPhase(null); refreshVaultSync() }
  }

  const pending = result?.kind === 'pending' || result?.kind === 'unconfirmed'
  const direct = pending || result?.kind === 'not_running'
  const extra = preflight.eligible && preflight.recommendSyncFirst
  const code = blocked ? 'local-vault-unavailable' : !preflight.eligible ? preflight.reason
    : result?.kind === 'gone' ? 'binding_not_found' : result?.kind === 'not_running' ? 'binding_not_running'
      : result?.kind === 'failed' || result?.kind === 'busy' ? result.code : null
  const status = result?.kind === 'pending' ? t('landing.pending', { n: result.pending + result.failures, m: result.held })
    : result?.kind === 'unconfirmed' ? t('landing.unconfirmed')
      : result?.kind === 'local_pending' ? t('landing.localPending', { name })
        : code ? landingError(t, code, name) : null
  const terminal = !!status && !pending && !direct
  const rows = [
    { Icon: Folder, title: t('landing.stopFolder', { path: binding.root }), detail: t('landing.stopFolderDesc'), fate: t('landing.kept') },
    { Icon: Cloud, title: t('landing.stopCloud', { name }), detail: t('landing.stopCloudDesc'), fate: t('landing.unchanged') },
    { Icon: RefreshCw, title: t('landing.stopLink'), detail: t('landing.stopLinkDesc'), fate: t('landing.stops') },
  ]

  return <VaultLandingDialog kind="stop" title={t('landing.stopTitle', { name })} onClose={close}>
    {result?.kind !== 'local_pending' && <div className="un-list">{rows.map(({ Icon, title, detail, fate }) => <div className="un-row" key={title}>
      <Icon size={15} /><div className="un-tx">{title}<small>{detail}</small></div><span className="un-pill">{fate}</span>
    </div>)}</div>}
    {status ? <div className="dialog-msg" role="status">{status}</div>
      : extra && <div className="dialog-msg landing-box landing-stop-warning"><TriangleAlert size={15} aria-hidden="true" />{preflight.unknown ? t('landing.leftoverUnknown') : t('landing.leftover', { n: preflight.unsynced, m: preflight.held })}</div>}
    <div className="dialog-actions">
      {canStart && !terminal && (extra || direct) && <button type="button" className="dialog-btn landing-button-first" disabled={!!phase} onClick={() => void run(false, true)}>{t('landing.stopNow')}</button>}
      {pending && <button type="button" className="dialog-btn" disabled={!!phase} onClick={() => { close(); onReview() }}>{t('landing.seeWhich')}</button>}
      <button type="button" className="dialog-btn" data-primary={terminal || pending || undefined} autoFocus={!extra || terminal}
        disabled={!!phase} onClick={close}>{t(terminal ? 'landing.ok' : pending ? 'landing.keepSyncing' : 'amdlg.cancel')}</button>
      {canStart && !terminal && !direct && <button type="button" className="dialog-btn" data-primary autoFocus={extra} disabled={!!phase}
        onClick={() => void run(extra)}>{t(phase ? `landing.${phase}` : extra ? 'landing.syncFirst' : 'landing.stopConfirm')}</button>}
    </div>
  </VaultLandingDialog>
}
