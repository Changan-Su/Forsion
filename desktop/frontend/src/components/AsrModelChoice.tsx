import { useEffect, useState } from 'react'
import { Check, Download, Loader2, Mic, Trash2 } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import type { StoredDesktopConfig } from '../types'
import { SettingsPanel } from './SettingsPrimitives'

/**
 * 设置 → 模型 → 语音 →「本地语音识别」卡(10-25 换成设置卡片):下载 / 删除本地 SenseVoice,下载完自动选它。
 * 语音输入用哪个模型(本地 / 云端 / 自带)在「默认模型 → 语音输入」里选(10-17 方案 C);这里只管本地模型文件。
 * 自包含(getConfig/setConfig + asrLocal* IPC)。非桌面环境自动隐藏。
 */

registerMessages({
  'asr.localTitle': { zh: '本地语音识别', en: 'On-device speech recognition' },
  'asr.localHint': { zh: '下载后语音输入可以离线用、不计额度，约 230 MB；在「默认模型 → 语音输入」里选它。', en: 'Once downloaded, voice input works offline at no cost. About 230 MB. Choose it under Default models → Voice input.' },
  'asr.downloadBtn': { zh: '下载', en: 'Download' },
  'asr.downloaded': { zh: '已下载', en: 'Downloaded' },
  'asr.downloadedInUse': { zh: '已下载 · 在用', en: 'Downloaded · in use' },
  'asr.use': { zh: '使用', en: 'Use' },
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
  const pct = Math.round(progress * 100)

  // 卡头右边一个动作(走查续 4.5):没下载 =「下载」/ 下载中 = 进度 / 下好了 =「已下载」+ 没在用时「使用」+ 删除。
  const actions = ready ? (
    <>
      <span className="settings-voice-ready" title={`${t('settings.asr.localName')} · ${t('settings.asr.offlineTag')} · ${(sizeBytes / 1048576).toFixed(0)} MB`}>
        <Check size={12} />{t(localSelected ? 'asr.downloadedInUse' : 'asr.downloaded')}
      </span>
      {!localSelected && <button type="button" className="btn ghost sm" onClick={pickLocal}>{t('asr.use')}</button>}
      <button type="button" className="btn ghost sm" title={t('settings.asr.localRemove')} aria-label={t('settings.asr.localRemove')} onClick={() => void remove()}>
        <Trash2 size={13} />
      </button>
    </>
  ) : downloading ? (
    <span className="settings-voice-progress" role="progressbar" aria-label={t('settings.asr.downloading')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <Loader2 size={13} className="spin" />
      <span>{t('settings.asr.downloading')} {pct}%</span>
      <span className="settings-voice-progress-track"><span style={{ width: `${pct}%` }} /></span>
    </span>
  ) : (
    <button type="button" className="btn ghost sm" onClick={() => void download()}><Download size={13} />{t('asr.downloadBtn')}</button>
  )

  return (
    <SettingsPanel className="settings-voice-asr" icon={<Mic size={16} />} title={t('asr.localTitle')} description={t('asr.localHint')} actions={actions}>
      {err && <div className="settings-voice-block"><p className="settings-voice-error" role="alert">{err}</p></div>}
    </SettingsPanel>
  )
}
