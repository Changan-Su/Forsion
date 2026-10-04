/**
 * 百炼音色工作室(声音复刻 + 声音设计;SettingsModal「语音朗读」组内挂载)。
 * 前提:存在 baseUrl 指向阿里云百炼(dashscope/aliyuncs 域名)的直连 provider。
 * 铁律:百炼音色只能配 enrollment/design 时的 target_model 合成 → 「使用」音色时联动改写
 * ttsModelId=<providerId>/<targetModel> 与 ttsVoice,避免用户手配错配。
 * 复刻的目标模型可选(CLONE_MODELS,也能手填):用哪个复刻服务由引擎按模型名判(routes/tts.ts cloneService),这里只管传 targetModel。
 */
import { useState } from 'react'
import { Loader2, Play, RefreshCw, Trash2, Check } from 'lucide-react'
import type { TanguDesktopConfig, DirectProviderConfig } from '../types'
import { cloneTtsVoice, deleteTtsVoice, designTtsVoice, listTtsVoices, type TtsVoiceInfo } from '../services/backendService'
import { registerMessages, useI18n } from '../i18n'
import { homeTarget } from '../services/engine/targets'
import { VoiceSamplePicker, type VoiceSample } from './VoiceSamplePicker'
import { playDataUri } from '../services/voiceSample'

// 与后端 routes/tts.ts 的 DASHSCOPE_VC/VD_MODEL 保持一致(列表项缺 targetModel 时按 kind 兜底)。
// voice-enrollment 那一类(kind=cosy)不兜底:它底下有十来个模型,猜错就是一对配不上的模型和音色 → 不知道绑的是谁就不给「使用」。
const KIND_MODEL: Record<'clone' | 'design', string> = {
  clone: 'qwen3-tts-vc-2026-01-22',
  design: 'qwen3-tts-vd-2026-01-26',
}
const boundModel = (v: TtsVoiceInfo): string => v.targetModel || (v.kind === 'cosy' ? '' : KIND_MODEL[v.kind])
// 能复刻的朗读模型 = 百炼「声音复刻」文档的支持列表(2026-10 核对;第一个是官方推荐,缺省选它)。
// 不含 qwen3-tts-vc-realtime-*:那是另一套实时协议,引擎的朗读没接。
export const CLONE_MODELS = [
  'qwen-audio-3.0-tts-plus', 'qwen-audio-3.1-tts-flash', 'qwen-audio-3.0-tts-flash',
  'cosyvoice-v3.5-plus', 'cosyvoice-v3.5-flash', 'cosyvoice-v3-plus', 'cosyvoice-v3-flash', 'cosyvoice-v2',
  'qwen3-tts-vc-2026-01-22',
]
const CUSTOM = '__custom__'

registerMessages({
  'settings.tts.studio.cloneModel': { zh: '复刻模型', en: 'Clone model' },
  'settings.tts.studio.recommended': { zh: '推荐', en: 'recommended' },
  'settings.tts.studio.cloneModelCustom': { zh: '自定义模型 ID…', en: 'Custom model ID…' },
  'settings.tts.studio.cloneModelPlaceholder': { zh: '百炼模型 ID', en: 'Bailian model ID' },
  'settings.tts.studio.callVoice': { zh: '通话音色', en: 'Call voice' },
  'settings.tts.studio.callModelRejected': { zh: '这是通话模型，朗读用不了。通话音色请在上面的「语音通话」里复刻。', en: 'That is a call model and cannot be used for read-aloud. Clone call voices under Voice call above.' },
})
/** 绑在通话模型上的音色(Qwen-Omni / *-realtime):朗读用不了,列表里不给「使用」。 */
const callOnly = (targetModel?: string): boolean => /omni|realtime/i.test(targetModel || '')

export function TtsVoiceStudio({ cfg, provider, onApplied }: { cfg: TanguDesktopConfig; provider: DirectProviderConfig; onApplied: () => void }) {
  const { t } = useI18n()
  const auth = { baseUrl: provider.baseUrl, apiKey: provider.apiKey || '' }
  const [voices, setVoices] = useState<TtsVoiceInfo[] | null>(null)
  const [busy, setBusy] = useState<'' | 'list' | 'clone' | 'design'>('')
  const [msg, setMsg] = useState('')
  const [cloneName, setCloneName] = useState('')
  const [sample, setSample] = useState<VoiceSample | null>(null)
  const [pickerKey, setPickerKey] = useState(0) // 复刻成功后换 key = 把录音区清回初始
  const [cloneModel, setCloneModel] = useState(CLONE_MODELS[0])
  const [customModel, setCustomModel] = useState<string | null>(null) // 非 null = 正在手填模型 ID
  const cloneTarget = (customModel ?? cloneModel).trim()
  const [designName, setDesignName] = useState('')
  const [designPrompt, setDesignPrompt] = useState('')
  const [designPreviewText, setDesignPreviewText] = useState('')
  const [preview, setPreview] = useState<{ voice: string; targetModel: string; b64: string } | null>(null)

  const refresh = (): void => {
    setBusy('list'); setMsg('')
    listTtsVoices(homeTarget(), auth)
      .then(setVoices)
      .catch((e) => setMsg(`✗ ${e?.message || e}`))
      .finally(() => setBusy(''))
  }

  const apply = (voice: string, targetModel: string, note = ''): void => {
    window.tangu!.setConfig({ ttsModelId: `${provider.providerId}/${targetModel}`, ttsVoice: voice }).then(() => {
      setMsg([t('settings.tts.studio.applied', { voice }), note].filter(Boolean).join(' '))
      onApplied()
    }).catch((e: any) => setMsg(`✗ ${e?.message || e}`))
  }

  const doClone = (): void => {
    if (!sample?.ok || !cloneTarget || busy) return
    if (callOnly(cloneTarget)) { setMsg(t('settings.tts.studio.callModelRejected')); return } // 手填了通话模型:建出来也只会把朗读配置写坏
    setBusy('clone'); setMsg('')
    cloneTtsVoice(homeTarget(), { ...auth, name: cloneName, audioData: sample.dataUri, targetModel: cloneTarget, ...sample.script })
      // 成功:先清 busy 再 refresh(refresh 自管 'list' 态,同一批次合并不闪);失败:保留错误信息,不 refresh(其 setMsg('') 会吃掉报错)。
      .then((r) => { apply(r.voice, r.targetModel, r.fallbackReason ? t('voicesample.scriptMismatch') : ''); setSample(null); setPickerKey((k) => k + 1); setCloneName(''); setBusy(''); refresh() })
      .catch((e) => { setMsg(`✗ ${e?.message || e}`); setBusy('') })
  }

  const doDesign = (): void => {
    if (!designPrompt.trim() || busy) return
    setBusy('design'); setMsg(''); setPreview(null)
    designTtsVoice(homeTarget(), { ...auth, name: designName, voicePrompt: designPrompt, previewText: designPreviewText || undefined })
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
    deleteTtsVoice(homeTarget(), { ...auth, voice: v.voice, kind: v.kind })
      .then(() => { setBusy(''); refresh() })
      .catch((e) => { setMsg(`✗ ${e?.message || e}`); setBusy('') })
  }

  const playPreview = (): void => {
    if (preview) playDataUri(`data:audio/wav;base64,${preview.b64}`)
  }

  return (
    <div className="field">
      <label>{t('settings.tts.studio.title')}</label>
      <div className="hint" style={{ marginBottom: 8 }}>{t('settings.tts.studio.hint')}</div>

      {/* 复刻:上传 10-20s 干净人声样本 → voice id,创建成功即自动采用 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
        <b style={{ fontSize: 'var(--ui-font-meta, 12px)' }}>{t('settings.tts.studio.cloneTitle')}</b>
        <div className="hint">{t('settings.tts.studio.cloneHint')}</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="tts-clone-model" style={{ width: 'auto', flex: '0 1 240px' }} aria-label={t('settings.tts.studio.cloneModel')}
            value={customModel !== null ? CUSTOM : cloneModel}
            onChange={(e) => { if (e.target.value === CUSTOM) setCustomModel(''); else { setCustomModel(null); setCloneModel(e.target.value) } }}>
            {CLONE_MODELS.map((m, i) => <option key={m} value={m}>{i === 0 ? `${m} · ${t('settings.tts.studio.recommended')}` : m}</option>)}
            <option value={CUSTOM}>{t('settings.tts.studio.cloneModelCustom')}</option>
          </select>
          {customModel !== null && (
            <input type="text" className="tts-clone-model-custom" autoFocus style={{ width: 200 }} value={customModel} aria-label={t('settings.tts.studio.cloneModel')}
              placeholder={t('settings.tts.studio.cloneModelPlaceholder')} onChange={(e) => setCustomModel(e.target.value)} />
          )}
        </div>
        <VoiceSamplePicker key={pickerKey} onChange={setSample} disabled={busy !== ''} />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="text" style={{ width: 140 }} value={cloneName} placeholder={t('settings.tts.studio.namePlaceholder')}
            onChange={(e) => setCloneName(e.target.value)} />
          <button className="btn primary sm tts-clone-go" disabled={!sample?.ok || !cloneTarget || busy !== ''} onClick={doClone}>
            {busy === 'clone' ? <Loader2 size={12} className="spin" /> : null} {t('settings.tts.studio.cloneBtn')}
          </button>
        </div>
      </div>

      {/* 设计:文字描述捏音色 → 试听 → 采用 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
        <b style={{ fontSize: 'var(--ui-font-meta, 12px)' }}>{t('settings.tts.studio.designTitle')}</b>
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
            <span style={{ fontSize: 'var(--ui-font-meta, 12px)', color: 'var(--text-muted)' }}>{preview.voice}</span>
          </div>
        )}
      </div>

      {/* 已有音色列表(懒加载) */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <b style={{ fontSize: 'var(--ui-font-meta, 12px)' }}>{t('settings.tts.studio.voices')}</b>
        <button className="icon-btn" title={t('settings.tts.studio.refresh')} onClick={refresh}>
          {busy === 'list' ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
        </button>
      </div>
      {voices && (voices.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {voices.map((v) => (
            <div key={`${v.kind}-${v.voice}`} className="file-row" style={{ cursor: 'default' }}>
              <span className="file-name">{v.voice}</span>
              <span className="file-size">{callOnly(v.targetModel) ? `${t('settings.tts.studio.callVoice')} · ` : ''}{v.targetModel || t(v.kind === 'clone' ? 'settings.tts.studio.kindClone' : v.kind === 'design' ? 'settings.tts.studio.kindDesign' : 'settings.tts.studio.kindCosy')}</span>
              {boundModel(v) && !callOnly(v.targetModel) && (
                <button className="icon-btn" title={t('settings.tts.studio.use')}
                  onClick={() => apply(v.voice, boundModel(v))}><Check size={12} /></button>
              )}
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
