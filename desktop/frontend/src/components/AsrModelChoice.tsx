import { useEffect, useState } from 'react'
import { Check, Download, HardDrive, Loader2, Trash2 } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import type { StoredDesktopConfig } from '../types'

/**
 * 设置 → 模型 → 语音 →「本地语音识别」:下载 / 删除本地 SenseVoice,下载完自动选它。
 * 语音输入用哪个模型(本地 / 云端 / 自带)在「默认模型 → 语音输入」里选(10-17 方案 C);这里只管本地模型文件。
 * 自包含(getConfig/setConfig + asrLocal* IPC)。非桌面环境自动隐藏。
 */

registerMessages({
  'asr.localTitle': { zh: '本地语音识别', en: 'On-device speech recognition' },
  'asr.localHint': { zh: '下载后语音输入可以离线用、不计额度；在「默认模型 → 语音输入」里选它。', en: 'Once downloaded, voice input works offline at no cost. Choose it under Default models → Voice input.' },
})

export function AsrModelChoice({ onSaved }: { onSaved?: (c: StoredDesktopConfig) => void } = {}) {
  const { t } = useI18n()
  const [ready, setReady] = useState(false)
  const [sizeBytes, setSizeBytes] = useState(0)
  const [backend, setBackend] = useState<'local' | 'cloud'>('cloud')
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState(0) // 0..1
  const [err, setErr] = useState<string | null>(null)

  const refresh = () => window.tangu?.asrLocalStatus?.().then((s) => { setReady(s.ready); setSizeBytes(s.sizeBytes) })
  useEffect(() => {
    void refresh()
    void window.tangu?.getConfig?.().then((c) => { setBackend(c.asrBackend === 'local' ? 'local' : 'cloud') })
  }, [])
  useEffect(() => window.tangu?.onAsrLocalProgress?.((e) => setProgress(e.total ? e.received / e.total : 0)), [])

  // 写完回报给设置页:「默认模型 → 语音输入」读的是设置页那份 stored,不回报就显示旧值、撤销也会恢复错
  const save = (asrBackend: 'local' | 'cloud') => { setBackend(asrBackend); void window.tangu?.setConfig?.({ asrBackend }).then((c) => { if (c) onSaved?.(c) }) }
  const pickLocal = () => save('local')

  const download = async () => {
    setErr(null); setDownloading(true); setProgress(0)
    try { const r = await window.tangu!.asrLocalDownload!(); await refresh(); if (r.ready) pickLocal() }
    catch (e: any) { setErr(e?.message || String(e)) } finally { setDownloading(false) }
  }
  const remove = async () => {
    await window.tangu?.asrLocalRemove?.()
    if (backend === 'local') save('cloud')
    await refresh()
  }

  if (!window.tangu?.asrLocalStatus) return null // 非桌面环境不显示

  const localSelected = backend === 'local' && ready

  return (
    <div className="field">
      <label>{t('asr.localTitle')}</label>
      <div className="hint" style={{ marginBottom: 8 }}>{t('asr.localHint')}</div>
      <div className="model-group-body">
        {/* 本地 SenseVoice 行:未下载=下载按钮 / 下载中=进度 / 已就绪=可选中 + 删除 */}
        {ready ? (
          <button className={`file-row${localSelected ? ' active' : ''}`} onClick={pickLocal}>
            <HardDrive size={13} />
            <span className="file-name" style={{ color: localSelected ? 'var(--accent-ink)' : undefined }}>{t('settings.asr.localName')}</span>
            <span className="model-group-tag">{t('settings.asr.offlineTag')} · {(sizeBytes / 1048576).toFixed(0)}MB</span>
            {localSelected && <Check size={12} style={{ color: 'var(--accent-ink)' }} />}
            <span
              role="button"
              tabIndex={0}
              title={t('settings.asr.localRemove')}
              onClick={(e) => { e.stopPropagation(); void remove() }}
              style={{ marginLeft: 4, opacity: 0.55, display: 'inline-flex' }}
            >
              <Trash2 size={12} />
            </span>
          </button>
        ) : downloading ? (
          <div className="file-row" style={{ gap: 10 }}>
            <Loader2 size={13} className="spin" />
            <span style={{ fontSize: 'var(--ui-font-meta, 12px)' }}>{t('settings.asr.downloading')} {Math.round(progress * 100)}%</span>
            <div style={{ flex: 1, height: 5, background: 'var(--overlay-light, rgba(127,127,127,.15))', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${Math.round(progress * 100)}%`, height: '100%', background: 'var(--accent, #6366f1)', transition: 'width .2s' }} />
            </div>
          </div>
        ) : (
          <button className="file-row" onClick={() => void download()}>
            <Download size={13} />
            <span className="file-name">{t('settings.asr.localName')} — {t('settings.asr.download')}</span>
          </button>
        )}
      </div>
      {err && <div className="hint" style={{ color: 'var(--danger)', marginTop: 6 }}>{err}</div>}
    </div>
  )
}
