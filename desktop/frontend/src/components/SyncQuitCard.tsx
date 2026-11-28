/**
 * 退出卡(智库同步第 2 步,方案 5C):退出时还有没同步完的文件,主进程的退出门禁(H 的 electron/syncQuitGate.ts)
 * 经 `window.remoteSync.quitGate` 问一次:正在同步 → 同步完自动退出;没同步完 / 有失败 → 列出来,「直接退出」或「取消退出」。
 * 「取消退出」= 宿主照旧开着(门禁收起,什么都不动)。旧主进程没有 quitGate → 不挂,退出照今天。
 * 订阅了门禁才会被问(H 的契约:没人订阅 = 不拦),所以只在主窗口挂一份(Root),浮窗 / 手机不挂。
 */
import { useEffect, useState } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { useI18n } from '../i18n'
import { windowKind } from '../windowKind'
import { DialogOverlay } from '../amadeus/components/DialogOverlay'
import './syncSettingsMessages'
import './syncSettings.css'

interface QuitGateResult { state: 'synced' | 'pending' | 'failed'; pending: number; failed: Array<{ path: string; reason: string }> }
interface QuitGate {
  subscribe(cb: (s: { open: boolean; result?: QuitGateResult }) => void): () => void
  answer(a: 'quit' | 'cancel'): Promise<unknown>
}
/** H 的类型还在它的分支上(types.ts 的 remoteSync.quitGate),这里按契约读,免得两边改同一段类型。 */
const gate = (): QuitGate | undefined => (window.remoteSync as unknown as { quitGate?: QuitGate } | undefined)?.quitGate

export function SyncQuitCard() {
  const { t } = useI18n()
  const [s, setS] = useState<{ open: boolean; result?: QuitGateResult }>({ open: false })
  const [busy, setBusy] = useState(false)
  const main = windowKind() === 'main'
  useEffect(() => {
    const g = gate()
    if (!g || !main) return
    return g.subscribe((next) => { setS(next); if (!next.open) setBusy(false) })
  }, [main])
  if (!main || !s.open) return null
  const r = s.result
  const failed = r?.state === 'failed'
  const answer = (a: 'quit' | 'cancel'): void => {
    setBusy(true)
    void gate()?.answer(a).catch(() => {}).finally(() => { if (a === 'cancel') setS({ open: false }) })
  }
  const shown = r?.failed.slice(0, 5) ?? []
  return (
    <div className="am-app tangu-lovable" style={{ display: 'contents' }}>
      <DialogOverlay>
        <div className="dialog ssync-quit" role="alertdialog" aria-modal="true" aria-labelledby="ssync-quit-title" data-sync-quit={r?.state ?? 'pending'}>
          <div>
            <div className="dialog-title" id="ssync-quit-title">
              {failed ? <AlertCircle size={16} aria-hidden="true" className="ssync-warn" /> : <RefreshCw size={16} aria-hidden="true" className="spin" />}
              {failed ? t('ssync.quit.failedTitle') : t('ssync.quit.syncing')}
            </div>
            {!!r?.pending && <div className="dialog-msg">{t('ssync.quit.pending', { n: r.pending })}</div>}
            {failed && !!r?.failed.length && <div className="dialog-msg">{t('ssync.quit.failed', { n: r.failed.length })}</div>}
          </div>
          {shown.length > 0 && (
            <div className="ssync-quit-list">
              {shown.map((f) => <div key={f.path} className="ssync-quit-row" title={`${f.path} · ${f.reason}`}><span>{f.path}</span></div>)}
              {r!.failed.length > shown.length && <div className="ssync-faint">{t('ssync.sum.more', { n: r!.failed.length - shown.length })}</div>}
            </div>
          )}
          <p className="ssync-faint ssync-quit-hint">{t('ssync.quit.nowHint')}</p>
          <div className="dialog-actions">
            <button type="button" className="btn" disabled={busy} data-sync-quit-act="cancel" onClick={() => answer('cancel')}>{t('ssync.quit.cancel')}</button>
            <button type="button" className={`btn${failed ? ' primary' : ''}`} disabled={busy} data-sync-quit-act="quit" onClick={() => answer('quit')}>{t('ssync.quit.now')}</button>
          </div>
        </div>
      </DialogOverlay>
    </div>
  )
}
