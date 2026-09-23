/**
 * 语音输入「用哪个模型」统一选择器:一个列表里列 [本地 SenseVoice(下载/已就绪)] + [云端 asr 模型],
 * 点谁即用谁——选中同时写 asrBackend(local/cloud)+ asrModelId。自包含(getConfig/setConfig + asrLocal* IPC),
 * 设置页与引导页复用。非桌面环境自动隐藏(语音输入目前桌面独有)。
 */
import { useEffect, useState } from 'react'
import { Check, Cloud, Download, HardDrive, Loader2, Trash2 } from 'lucide-react'
import { useI18n } from '../i18n'
import type { ModelsResponse } from '../types'

export function AsrModelChoice({ models }: { models: ModelsResponse | null }) {
  const { t } = useI18n()
  const [ready, setReady] = useState(false)
  const [sizeBytes, setSizeBytes] = useState(0)
  const [backend, setBackend] = useState<'local' | 'cloud'>('cloud')
  const [asrModelId, setAsrModelId] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState(0) // 0..1
  const [err, setErr] = useState<string | null>(null)

  const refresh = () => window.tangu?.asrLocalStatus?.().then((s) => { setReady(s.ready); setSizeBytes(s.sizeBytes) })
  useEffect(() => {
    void refresh()
    void window.tangu?.getConfig?.().then((c) => { setBackend(c.asrBackend === 'local' ? 'local' : 'cloud'); setAsrModelId(c.asrModelId || '') })
  }, [])
  useEffect(() => window.tangu?.onAsrLocalProgress?.((e) => setProgress(e.total ? e.received / e.total : 0)), [])

  const pickLocal = () => { setBackend('local'); void window.tangu?.setConfig?.({ asrBackend: 'local' }) }
  const pickCloud = (id: string) => { setBackend('cloud'); setAsrModelId(id); void window.tangu?.setConfig?.({ asrBackend: 'cloud', asrModelId: id }) }

  const download = async () => {
    setErr(null); setDownloading(true); setProgress(0)
    try { const r = await window.tangu!.asrLocalDownload!(); await refresh(); if (r.ready) pickLocal() }
    catch (e: any) { setErr(e?.message || String(e)) } finally { setDownloading(false) }
  }
  const remove = async () => {
    await window.tangu?.asrLocalRemove?.()
    if (backend === 'local') { setBackend('cloud'); void window.tangu?.setConfig?.({ asrBackend: 'cloud' }) }
    await refresh()
  }

  if (!window.tangu?.asrLocalStatus) return null // 非桌面环境不显示

  const asrs = (models?.models || []).filter((m) => m.modelType === 'asr')
  const localSelected = backend === 'local' && ready

  return (
    <div className="field">
      <label>{t('settings.asr.chooseLabel')}</label>
      <div className="hint" style={{ marginBottom: 8 }}>{t('settings.asr.chooseHint')}</div>
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
        {/* 云端 asr 模型行(Forsion 托管 / 自带 provider) */}
        {asrs.map((m) => {
          const sel = backend === 'cloud' && asrModelId === m.id
          return (
            <button key={`${m.source}-${m.id}`} className={`file-row${sel ? ' active' : ''}`} onClick={() => pickCloud(m.id)}>
              <Cloud size={13} />
              <span className="file-name" style={{ color: sel ? 'var(--accent-ink)' : undefined }}>{m.name}</span>
              <span className="model-group-tag">{m.source === 'direct' ? t('model.group.direct') : m.provider}</span>
              {sel && <Check size={12} style={{ color: 'var(--accent-ink)' }} />}
            </button>
          )
        })}
      </div>
      {!asrs.length && <div className="hint" style={{ marginTop: 4 }}>{t('settings.asr.noCloudHint')}</div>}
      {err && <div className="hint" style={{ color: 'var(--danger)', marginTop: 6 }}>{err}</div>}
    </div>
  )
}
