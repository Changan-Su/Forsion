/**
 * 导入本机配置(借鉴 magpie 方案 3a,A + B):设置 → 模型 → 提供方 →「API 连接」里
 * A:找到了才出一行「在本机找到 N 个可以导入的配置 · 忽略 · 导入…」;B:「添加连接」变成菜单(手动填写 / 按来源导入),忽略过的从这里找回。
 * 扫描在主进程(electron/discovery/providers.ts,最多一分钟一次),这里只拿到 key 末 4 位;导入按 id 交回主进程重读。
 * 「忽略」按 来源 + 配置指纹(即 id)记在本机 localStorage:同一条换了 key / 地址会再提示。手机上没有这个 IPC,只剩手动填写。
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, Plus, X } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { CapabilityMenu } from './CapabilityMenu'
import { SettingsRow } from './SettingsPrimitives'
import type { DirectProviderConfig, LocalProviderCandidate } from '../types'

registerMessages({
  'provimp.found': { zh: '在本机找到 {n} 个可以导入的配置', en: 'Found {n} configurations to import' },
  'provimp.foundHint': { zh: '{list}。导入前逐个确认。', en: '{list}. You confirm each one before it is added.' },
  'provimp.count': { zh: '{source} {n} 个', en: '{source}: {n}' },
  'provimp.ignore': { zh: '忽略', en: 'Ignore' },
  'provimp.open': { zh: '导入…', en: 'Import…' },
  'provimp.manual': { zh: '手动填写地址和 key', en: 'Enter address and key' },
  'provimp.n': { zh: '{n} 个', en: '{n}' },
  'provimp.none': { zh: '没找到', en: 'None found' },
  'provimp.title': { zh: '导入本机配置', en: 'Import local configurations' },
  'provimp.exists': { zh: '已在 Forsion 里', en: 'Already in Forsion' },
  'provimp.note': { zh: '只复制地址、key 和模型名。之后在原来的应用里改，不会同步过来。', en: 'Only the address, key and model names are copied. Later changes in the original app won\'t sync here.' },
  'provimp.cancel': { zh: '取消', en: 'Cancel' },
  'provimp.import': { zh: '导入 {n} 个', en: 'Import {n}' },
  'provimp.failed': { zh: '导入失败：{e}', en: 'Import failed: {e}' },
  'provimp.stale': { zh: '这几条在原来的应用里刚改过，列表已刷新，请重新勾选。', en: 'These changed in the original app. The list is refreshed; pick again.' },
})

const SOURCES: Array<[LocalProviderCandidate['source'], string]> = [['cc-switch', 'CC Switch'], ['codex', 'Codex'], ['claude-code', 'Claude Code']]
const sourceName = (s: LocalProviderCandidate['source']) => SOURCES.find(([k]) => k === s)?.[1] || s
const IGNORED_KEY = 'forsion.providerImport.ignored'
const readIgnored = (): string[] => { try { const v = JSON.parse(localStorage.getItem(IGNORED_KEY) || '[]'); return Array.isArray(v) ? v : [] } catch { return [] } }
const writeIgnored = (ids: string[]) => { try { localStorage.setItem(IGNORED_KEY, JSON.stringify(ids.slice(-200))) } catch { /* 存不了:下次还提示 */ } }

export function LocalProviderImport({ providers, onManual, onImported }: { providers: DirectProviderConfig[]; onManual: () => void; onImported: (list: DirectProviderConfig[]) => void }) {
  const { t } = useI18n()
  const scan = window.tangu?.scanLocalProviders
  const [found, setFound] = useState<LocalProviderCandidate[]>([])
  const [ignored, setIgnored] = useState<string[]>(readIgnored)
  const [dialog, setDialog] = useState<LocalProviderCandidate['source'] | 'all' | null>(null)
  // 第一次用主进程的一分钟缓存;之后连接增删改了(「已在 Forsion 里」会变)就强制重扫
  const first = useRef(true)
  useEffect(() => { void scan?.(!first.current).then(setFound).catch(() => setFound([])); first.current = false }, [providers])

  const fresh = found.filter((c) => !c.exists && !ignored.includes(c.id))
  const countOf = (list: LocalProviderCandidate[]) => SOURCES.map(([k, name]) => [name, list.filter((c) => c.source === k).length] as const).filter(([, n]) => n > 0)
  const ignore = () => { const next = [...new Set([...ignored, ...fresh.map((c) => c.id)])]; setIgnored(next); writeIgnored(next) }
  const imported = (list: DirectProviderConfig[]) => { setDialog(null); onImported(list) }
  const rescan = () => void scan?.(true).then(setFound).catch(() => {})

  return <>
    {fresh.length > 0 && <SettingsRow label={t('provimp.found', { n: fresh.length })}
      description={t('provimp.foundHint', { list: countOf(fresh).map(([source, n]) => t('provimp.count', { source, n })).join(' · ') })}
      control={<div className="provider-import-actions">
        <button type="button" className="btn ghost sm" onClick={ignore}>{t('provimp.ignore')}</button>
        <button type="button" className="btn ghost sm" onClick={() => setDialog('all')}><Download size={13} /> {t('provimp.open')}</button>
      </div>} />}
    <div className="provider-add">
      {scan ? <CapabilityMenu label={t('prov.add')} className="btn ghost sm" items={[
        { id: 'manual', label: t('provimp.manual'), icon: <Plus size={14} />, onSelect: onManual },
        ...SOURCES.map(([k, name]) => {
          const n = found.filter((c) => c.source === k).length
          return { id: k, label: name, icon: <Download size={14} />, hint: n ? t('provimp.n', { n }) : t('provimp.none'), disabled: !n, onSelect: () => setDialog(k) }
        }),
      ]}><Plus size={13} /> {t('prov.add')}</CapabilityMenu>
        : <button className="btn ghost sm" onClick={onManual}><Plus size={13} /> {t('prov.add')}</button>}
    </div>
    {dialog && <ImportDialog list={dialog === 'all' ? fresh : found.filter((c) => c.source === dialog)} onClose={() => setDialog(null)} onImported={imported} onStale={rescan} />}
  </>
}

function ImportDialog({ list, onClose, onImported, onStale }: { list: LocalProviderCandidate[]; onClose: () => void; onImported: (list: DirectProviderConfig[]) => void; onStale: () => void }) {
  const { t } = useI18n()
  const [picked, setPicked] = useState(() => new Set(list.filter((c) => !c.exists).map((c) => c.id)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const go = () => {
    setBusy(true); setError('')
    void window.tangu!.importLocalProviders!([...picked]).then(onImported)
      .catch((e: any) => {
        const stale = /import_stale/.test(String(e?.message || e))
        setError(stale ? t('provimp.stale') : t('provimp.failed', { e: e?.message || String(e) })); setBusy(false)
        if (stale) onStale()
      })
  }
  return createPortal(
    <div className="u-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="modal modal-sm provider-import" role="dialog" aria-modal="true" aria-label={t('provimp.title')}
        onKeyDown={(e) => { if (e.key === 'Escape' && !busy) onClose() }}>
        <div className="modal-head"><span className="grow">{t('provimp.title')}</span>
          <button type="button" className="icon-btn" aria-label={t('provimp.cancel')} onClick={onClose} disabled={busy}><X size={15} /></button></div>
        <div className="provider-import-list">{list.map((c) => (
          <label key={c.id} className={`provider-import-row${c.exists ? ' is-disabled' : ''}`}>
            <input type="checkbox" disabled={c.exists || busy} checked={picked.has(c.id)}
              onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n })} />
            <span className="provider-import-copy"><b>{c.name}</b><small>{c.host} · {c.exists ? t('provimp.exists') : `…${c.keyTail}`}</small></span>
            <small className="provider-import-source">{sourceName(c.source)}</small>
          </label>
        ))}</div>
        <p className="provider-import-note">{t('provimp.note')}</p>
        {error && <p className="provider-import-note error">{error}</p>}
        <div className="provider-import-foot">
          <button type="button" className="btn ghost sm" onClick={onClose} disabled={busy}>{t('provimp.cancel')}</button>
          <button type="button" className="btn primary sm" disabled={!picked.size || busy} onClick={go}>{t('provimp.import', { n: picked.size })}</button>
        </div>
      </div>
    </div>, document.body)
}
