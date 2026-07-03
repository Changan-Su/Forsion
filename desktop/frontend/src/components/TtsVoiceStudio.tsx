/**
 * 百炼音色工作室(声音复刻 + 声音设计;SettingsModal「语音朗读」组内挂载)。
 * 前提:存在 baseUrl 指向阿里云百炼(dashscope/aliyuncs 域名)的直连 provider。
 * 铁律:百炼音色只能配 enrollment/design 时的 target_model 合成 → 「使用」音色时联动改写
 * ttsModelId=<providerId>/<targetModel> 与 ttsVoice,避免用户手配错配。
 */
import { useState } from 'react'
import { Loader2, Play, RefreshCw, Trash2, Check } from 'lucide-react'
import type { TanguDesktopConfig, DirectProviderConfig } from '../types'
import { cloneTtsVoice, deleteTtsVoice, designTtsVoice, listTtsVoices, type TtsVoiceInfo } from '../services/backendService'
import { useI18n } from '../i18n'

// 与后端 routes/tts.ts 的 DASHSCOPE_VC/VD/COSY_MODEL 保持一致(列表项缺 targetModel 时按 kind 兜底)。
const KIND_MODEL: Record<'clone' | 'design' | 'cosy', string> = {
  clone: 'qwen3-tts-vc-2026-01-22',
  design: 'qwen3-tts-vd-2026-01-26',
  cosy: 'cosyvoice-v2',
}
const MAX_AUDIO_MB = 10

export function TtsVoiceStudio({ cfg, provider, onApplied }: { cfg: TanguDesktopConfig; provider: DirectProviderConfig; onApplied: () => void }) {
  const { t } = useI18n()
  const auth = { baseUrl: provider.baseUrl, apiKey: provider.apiKey || '' }
  const [voices, setVoices] = useState<TtsVoiceInfo[] | null>(null)
  const [busy, setBusy] = useState<'' | 'list' | 'clone' | 'design' | 'cosy'>('')
  const [msg, setMsg] = useState('')
  const [cloneName, setCloneName] = useState('')
  const [cloneFile, setCloneFile] = useState<File | null>(null)
  const [cosyUrl, setCosyUrl] = useState('')
  const [cosyName, setCosyName] = useState('')
  const [designName, setDesignName] = useState('')
  const [designPrompt, setDesignPrompt] = useState('')
  const [designPreviewText, setDesignPreviewText] = useState('')
  const [preview, setPreview] = useState<{ voice: string; targetModel: string; b64: string } | null>(null)

  const refresh = (): void => {
    setBusy('list'); setMsg('')
    listTtsVoices(cfg, auth)
      .then(setVoices)
      .catch((e) => setMsg(`✗ ${e?.message || e}`))
      .finally(() => setBusy(''))
  }

  const apply = (voice: string, targetModel: string): void => {
    window.tangu!.setConfig({ ttsModelId: `${provider.providerId}/${targetModel}`, ttsVoice: voice }).then(() => {
      setMsg(t('settings.tts.studio.applied', { voice }))
      onApplied()
    }).catch((e: any) => setMsg(`✗ ${e?.message || e}`))
  }

  const doClone = (): void => {
    if (!cloneFile || busy) return
    if (cloneFile.size > MAX_AUDIO_MB * 1024 * 1024) { setMsg(t('settings.tts.studio.fileTooLarge', { mb: MAX_AUDIO_MB })); return }
    setBusy('clone'); setMsg('')
    const fr = new FileReader()
    fr.onerror = () => { setBusy(''); setMsg('✗ read file failed') }
    fr.onload = () => {
      cloneTtsVoice(cfg, { ...auth, name: cloneName, audioData: String(fr.result) })
        // 成功:先清 busy 再 refresh(refresh 自管 'list' 态,同一批次合并不闪);失败:保留错误信息,不 refresh(其 setMsg('') 会吃掉报错)。
        .then((r) => { apply(r.voice, r.targetModel); setCloneFile(null); setCloneName(''); setBusy(''); refresh() })
        .catch((e) => { setMsg(`✗ ${e?.message || e}`); setBusy('') })
    }
    fr.readAsDataURL(cloneFile)
  }

  // CosyVoice 复刻:百炼只收公网 URL(不收文件上传),故这里传链接而非 base64。
  const doCosyClone = (): void => {
    if (!cosyUrl.trim() || busy) return
    setBusy('cosy'); setMsg('')
    cloneTtsVoice(cfg, { ...auth, name: cosyName, engine: 'cosy', audioUrl: cosyUrl.trim() })
      .then((r) => { apply(r.voice, r.targetModel); setCosyUrl(''); setCosyName(''); setBusy(''); refresh() })
      .catch((e) => { setMsg(`✗ ${e?.message || e}`); setBusy('') })
  }

  const doDesign = (): void => {
    if (!designPrompt.trim() || busy) return
    setBusy('design'); setMsg(''); setPreview(null)
    designTtsVoice(cfg, { ...auth, name: designName, voicePrompt: designPrompt, previewText: designPreviewText || undefined })
      .then((r) => {
        if (r.previewAudio?.data) setPreview({ voice: r.voice, targetModel: r.targetModel, b64: r.previewAudio.data })
        else apply(r.voice, r.targetModel)
        setBusy(''); refresh()
      })
      .catch((e) => { setMsg(`✗ ${e?.message || e}`); setBusy('') })
  }

  const doDelete = (v: TtsVoiceInfo): void => {
    if (busy) return
    setBusy('list'); setMsg('')
    deleteTtsVoice(cfg, { ...auth, voice: v.voice, kind: v.kind })
      .then(() => { setBusy(''); refresh() })
      .catch((e) => { setMsg(`✗ ${e?.message || e}`); setBusy('') })
  }

  const playPreview = (): void => {
    if (preview) void new Audio(`data:audio/wav;base64,${preview.b64}`).play().catch(() => {})
  }

  return (
    <div className="field">
      <label>{t('settings.tts.studio.title')}</label>
      <div className="hint" style={{ marginBottom: 8 }}>{t('settings.tts.studio.hint')}</div>

      {/* 复刻:上传 10-20s 干净人声样本 → voice id,创建成功即自动采用 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
        <b style={{ fontSize: 12.5 }}>{t('settings.tts.studio.cloneTitle')}</b>
        <div className="hint">{t('settings.tts.studio.cloneHint')}</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* 选中即清 input.value:File 存 state,同一文件可重选(Chromium 同名重选不触发 onChange);文件名由下方 span 显示 */}
          <input type="file" accept="audio/*" onChange={(e) => { setCloneFile(e.target.files?.[0] || null); e.target.value = '' }} />
          {cloneFile && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{cloneFile.name}</span>}
          <input type="text" style={{ width: 140 }} value={cloneName} placeholder={t('settings.tts.studio.namePlaceholder')}
            onChange={(e) => setCloneName(e.target.value)} />
          <button className="btn primary sm" disabled={!cloneFile || busy !== ''} onClick={doClone}>
            {busy === 'clone' ? <Loader2 size={12} className="spin" /> : null} {t('settings.tts.studio.cloneBtn')}
          </button>
        </div>
      </div>

      {/* CosyVoice 复刻:百炼要求公网音频 URL(不收文件上传);成功即自动采用,合成走 cosyvoice-* WS */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
        <b style={{ fontSize: 12.5 }}>{t('settings.tts.studio.cosyTitle')}</b>
        <div className="hint">{t('settings.tts.studio.cosyHint')}</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="url" style={{ flex: 1, minWidth: 200 }} value={cosyUrl} placeholder={t('settings.tts.studio.cosyUrlPlaceholder')}
            onChange={(e) => setCosyUrl(e.target.value)} />
          <input type="text" style={{ width: 140 }} value={cosyName} placeholder={t('settings.tts.studio.namePlaceholder')}
            onChange={(e) => setCosyName(e.target.value)} />
          <button className="btn primary sm" disabled={!cosyUrl.trim() || busy !== ''} onClick={doCosyClone}>
            {busy === 'cosy' ? <Loader2 size={12} className="spin" /> : null} {t('settings.tts.studio.cosyBtn')}
          </button>
        </div>
      </div>

      {/* 设计:文字描述捏音色 → 试听 → 采用 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
        <b style={{ fontSize: 12.5 }}>{t('settings.tts.studio.designTitle')}</b>
        <textarea rows={2} value={designPrompt} placeholder={t('settings.tts.studio.designPromptPlaceholder')}
          onChange={(e) => setDesignPrompt(e.target.value)} />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="text" style={{ flex: 1, minWidth: 160 }} value={designPreviewText} placeholder={t('settings.tts.studio.previewTextPlaceholder')}
            onChange={(e) => setDesignPreviewText(e.target.value)} />
          <input type="text" style={{ width: 140 }} value={designName} placeholder={t('settings.tts.studio.namePlaceholder')}
            onChange={(e) => setDesignName(e.target.value)} />
          <button className="btn primary sm" disabled={!designPrompt.trim() || busy !== ''} onClick={doDesign}>
            {busy === 'design' ? <Loader2 size={12} className="spin" /> : null} {t('settings.tts.studio.designBtn')}
          </button>
        </div>
        {preview && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn ghost sm" onClick={playPreview}><Play size={12} /> {t('settings.tts.studio.playPreview')}</button>
            <button className="btn primary sm" onClick={() => { apply(preview.voice, preview.targetModel); setPreview(null) }}>
              <Check size={12} /> {t('settings.tts.studio.adopt')}
            </button>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{preview.voice}</span>
          </div>
        )}
      </div>

      {/* 已有音色列表(懒加载) */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <b style={{ fontSize: 12.5 }}>{t('settings.tts.studio.voices')}</b>
        <button className="icon-btn" title={t('settings.tts.studio.refresh')} onClick={refresh}>
          {busy === 'list' ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
        </button>
      </div>
      {voices && (voices.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {voices.map((v) => (
            <div key={`${v.kind}-${v.voice}`} className="file-row" style={{ cursor: 'default' }}>
              <span className="file-name">{v.voice}</span>
              <span className="file-size">{t(v.kind === 'clone' ? 'settings.tts.studio.kindClone' : v.kind === 'design' ? 'settings.tts.studio.kindDesign' : 'settings.tts.studio.kindCosy')}</span>
              <button className="icon-btn" title={t('settings.tts.studio.use')}
                onClick={() => apply(v.voice, v.targetModel || KIND_MODEL[v.kind])}><Check size={12} /></button>
              <button className="icon-btn" title={t('settings.tts.studio.delete')} disabled={busy !== ''}
                onClick={() => doDelete(v)}><Trash2 size={12} /></button>
            </div>
          ))}
        </div>
      ) : (
        <div className="hint">{t('settings.tts.studio.empty')}</div>
      ))}
      {msg && <div className="hint" style={{ marginTop: 6 }}>{msg}</div>}
    </div>
  )
}
