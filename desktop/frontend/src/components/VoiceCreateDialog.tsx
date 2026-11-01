/**
 * 新建音色弹层:录音 / 选文件 → 检查、起名、确认授权 → 复刻中(可放到后台)→ 试听后再决定用不用。通话、朗读共用。
 * 两条线路:云端(Forsion 账号代管,只做通话音色)走 /agent/tts/cloud-voices;自带百炼连接走 /agent/tts/voices。
 * 铁律:百炼音色只认复刻时的 target_model。云端和通话由打开它的那张卡定模型;朗读默认官方推荐的模型,也可以在「复刻模型」里换。
 * 文字描述(声音设计)只有自带连接能用,出来的音色只能朗读。
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { AudioLines, Check, Loader2, Play, Sparkles, Volume2, X } from 'lucide-react'
import type { DirectProviderConfig } from '../types'
import { cloneCloudVoice, cloneTtsVoice, designTtsVoice, type CloudVoice } from '../services/backendService'
import { homeTarget } from '../services/engine/targets'
import { registerMessages, useI18n } from '../i18n'
import { playDataUri } from '../services/voiceSample'
import { cloneBusyText, cloneErrorText, VoiceSamplePicker, type VoiceSample } from './VoiceSamplePicker'
import type { VoiceKind } from '../services/voiceCatalog'

// 能复刻的朗读模型 = 百炼「声音复刻」文档的支持列表(2026-10 核对;第一个是官方推荐)。
// 不含 qwen3-tts-vc-realtime-*:那是另一套实时协议,引擎的朗读没接。
export const CLONE_MODELS = [
  'qwen-audio-3.0-tts-plus', 'qwen-audio-3.1-tts-flash', 'qwen-audio-3.0-tts-flash',
  'cosyvoice-v3.5-plus', 'cosyvoice-v3.5-flash', 'cosyvoice-v3-plus', 'cosyvoice-v3-flash', 'cosyvoice-v2',
  'qwen3-tts-vc-2026-01-22',
]
const CUSTOM_MODEL = '__custom__'

registerMessages({
  'voicecreate.title': { zh: '新建音色', en: 'New voice' },
  'voicecreate.tabClone': { zh: '复刻我的声音', en: 'Clone my voice' },
  'voicecreate.tabDesign': { zh: '用文字描述', en: 'Describe it' },
  'voicecreate.close': { zh: '关闭', en: 'Close' },
  'voicecreate.nameCloud': { zh: '给音色起个名字', en: 'Name this voice' },
  'voicecreate.nameDirect': { zh: '名称（字母/数字/_）', en: 'Name (letters/digits/_)' },
  'voicecreate.consent': { zh: '这是我本人的声音，或我已获得本人授权。', en: "This is my own voice, or I have the speaker's permission." },
  'voicecreate.useCall': { zh: '用于语音通话 · 绑定 {model}，换模型要重新复刻', en: 'For voice calls · tied to {model}; a new model needs a new clone' },
  'voicecreate.useRead': { zh: '用于朗读 · 绑定 {model}，不能打电话', en: 'For read-aloud · tied to {model}; it cannot be used in calls' },
  'voicecreate.cloneModel': { zh: '复刻模型', en: 'Clone model' },
  'voicecreate.recommended': { zh: '推荐', en: 'recommended' },
  'voicecreate.start': { zh: '开始复刻', en: 'Start cloning' },
  'voicecreate.background': { zh: '在后台继续', en: 'Continue in background' },
  'voicecreate.doneTitle': { zh: '「{name}」做好了', en: '"{name}" is ready' },
  'voicecreate.doneHint': { zh: '听一下像不像。满意就用它，不满意可以删掉重录。', en: 'Have a listen. Use it if you like it, or delete it and record again.' },
  'voicecreate.doneHintNoSample': { zh: '现在还听不到样音。先用它打一通电话试试，不满意可以删掉重录。', en: 'No sample yet. Try it on a call; you can delete it and record again.' },
  'voicecreate.keep': { zh: '先留着', en: 'Keep for later' },
  'voicecreate.useForCall': { zh: '用于通话', en: 'Use for calls' },
  'voicecreate.useForRead': { zh: '用于朗读', en: 'Use for read-aloud' },
  'voicecreate.play': { zh: '试听', en: 'Preview' },
  'voicecreate.designPrompt': { zh: '描述想要的声音，如：年轻活泼的女性声音，语速较快，语调上扬，温柔亲切（请原创，勿模仿特定真人）', en: 'Describe the voice, e.g. a young, lively female voice, quick and upbeat (original only; do not imitate a real person)' },
  'voicecreate.designText': { zh: '试听文本（可选）', en: 'Preview text (optional)' },
  'voicecreate.designGo': { zh: '生成试听', en: 'Generate preview' },
  'voicecreate.designUse': { zh: '描述出来的音色只能朗读，不能打电话。', en: 'Described voices work for read-aloud only, not calls.' },
  'voicecreate.customModel': { zh: '自定义模型 ID…', en: 'Custom model ID…' },
  'voicecreate.customModelPlaceholder': { zh: '如 qwen-audio-3.2-tts-flash', en: 'e.g. qwen-audio-3.2-tts-flash' },
  'voicecreate.callModelInRead': { zh: '这是通话模型：到语音通话卡片里新建。', en: 'This is a call model. Create the voice from the Voice calls card.' },
  'voicecreate.limit': { zh: '最多 {n} 个音色，先删掉一个再新建。', en: 'You can keep up to {n} voices. Delete one first.' },
})

export interface VoiceCreated { voice: string; targetModel: string; name: string; cloud?: CloudVoice }

export function VoiceCreateDialog(p: {
  kind: VoiceKind
  /** 云端代管:modelId = 云端通话模型的 id,modelName 给人看。 */
  cloud?: { modelId: string; modelName: string; limit?: number } | null
  /** 自带连接;targetModel = 通话卡定的上游模型(朗读不传,用 cloneModel)。 */
  provider?: DirectProviderConfig | null
  targetModel?: string
  onCreated: (v: VoiceCreated) => void
  onUse: (v: VoiceCreated) => void
  onClose: () => void
  playCloudSample?: (id: string) => void
}) {
  const { t } = useI18n()
  const [tab, setTab] = useState<'clone' | 'design'>('clone')
  const [sample, setSample] = useState<VoiceSample | null>(null)
  const [name, setName] = useState('')
  const [consent, setConsent] = useState(false)
  const [cloneModel, setCloneModel] = useState(CLONE_MODELS[0])
  const [customModel, setCustomModel] = useState('')
  const [prompt, setPrompt] = useState('')
  const [previewText, setPreviewText] = useState('')
  const [busy, setBusy] = useState(false)
  const [hidden, setHidden] = useState(false) // 放到后台:弹层藏起来,请求和忙碌锁留着,别卸载(卸载 = 能再发一次,先发的晚回来会盖掉新音色)
  const [msg, setMsg] = useState('')
  const [done, setDone] = useState<(VoiceCreated & { previewB64?: string }) | null>(null)
  const auth = p.provider ? { baseUrl: p.provider.baseUrl, apiKey: p.provider.apiKey || '' } : null
  const custom = cloneModel === CUSTOM_MODEL
  const pickedModel = custom ? customModel.trim() : cloneModel
  const target = p.cloud?.modelName || p.targetModel || pickedModel
  const canDesign = p.kind === 'read' && !!auth

  const finish = (v: VoiceCreated & { previewB64?: string }): void => {
    p.onCreated(v)
    setBusy(false); setMsg(''); setDone(v); setHidden(false)
  }
  const doClone = (): void => {
    if (!sample?.ok || !consent || busy || !target) return
    // 朗读这边手填了通话模型:拦下,否则复刻出来的音色朗读用不了
    if (p.kind === 'read' && /omni|realtime/i.test(pickedModel)) { setMsg(t('voicecreate.callModelInRead')); return }
    setBusy(true); setMsg(cloneBusyText(sample, t))
    const fail = (e: any): void => { setBusy(false); setHidden(false); setMsg(e?.status === 409 ? t('voicecreate.limit', { n: p.cloud?.limit ?? 5 }) : cloneErrorText(e, sample, t)) }
    if (p.cloud) {
      cloneCloudVoice(homeTarget(), { modelId: p.cloud.modelId, name: name.trim(), audioData: sample.dataUri, ...sample.script })
        .then((v) => finish({ voice: v.voice, targetModel: v.modelId, name: v.name, cloud: v })).catch(fail)
    } else if (auth) {
      const targetModel = p.targetModel || pickedModel
      cloneTtsVoice(homeTarget(), { ...auth, name: name.trim(), audioData: sample.dataUri, targetModel, ...sample.script })
        .then((r) => finish({ voice: r.voice, targetModel: r.targetModel, name: name.trim() || r.voice })).catch(fail)
    }
  }
  const doDesign = (): void => {
    if (!auth || !prompt.trim() || busy) return
    setBusy(true); setMsg('')
    designTtsVoice(homeTarget(), { ...auth, name: name.trim(), voicePrompt: prompt, previewText: previewText || undefined })
      .then((r) => finish({ voice: r.voice, targetModel: r.targetModel, name: name.trim() || r.voice, previewB64: r.previewAudio?.data }))
      .catch((e: any) => { setBusy(false); setHidden(false); setMsg(`✗ ${e?.message || e}`) })
  }
  if (hidden) return null

  const close = <button type="button" className="icon-btn" aria-label={t('voicecreate.close')} title={t('voicecreate.close')} onClick={busy ? () => setHidden(true) : p.onClose}><X size={15} /></button>
  const body = done ? (
    <>
      <div className="voice-create-title"><strong>{t('voicecreate.doneTitle', { name: done.name })}</strong>{close}</div>
      <p className="voice-create-note">{t(done.previewB64 || done.cloud?.hasSample ? 'voicecreate.doneHint' : 'voicecreate.doneHintNoSample')}</p>
      {(done.previewB64 || done.cloud?.hasSample) && (
        <div><button type="button" className="btn ghost sm" onClick={() => { if (done.previewB64) playDataUri(`data:audio/wav;base64,${done.previewB64}`); else if (done.cloud) p.playCloudSample?.(done.cloud.id) }}><Play size={12} />{t('voicecreate.play')}</button></div>
      )}
      <div className="voice-create-foot">
        <button type="button" className="btn ghost sm" onClick={p.onClose}>{t('voicecreate.keep')}</button>
        <button type="button" className="btn primary sm voice-create-use-btn" onClick={() => p.onUse(done)}>{t(p.kind === 'call' ? 'voicecreate.useForCall' : 'voicecreate.useForRead')}</button>
      </div>
    </>
  ) : (
    <>
      <div className="voice-create-title"><strong>{t('voicecreate.title')}</strong>{close}</div>
      {canDesign && (
        <div className="voice-create-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'clone'} className={tab === 'clone' ? 'active' : ''} onClick={() => setTab('clone')}>{t('voicecreate.tabClone')}</button>
          <button type="button" role="tab" aria-selected={tab === 'design'} className={tab === 'design' ? 'active' : ''} onClick={() => setTab('design')}>{t('voicecreate.tabDesign')}</button>
        </div>
      )}
      {tab === 'clone' ? (
        <>
          <VoiceSamplePicker onChange={setSample} disabled={busy} />
          {p.kind === 'read' && auth && (
            <select className="voice-create-model" aria-label={t('voicecreate.cloneModel')} value={cloneModel} disabled={busy} onChange={(e) => setCloneModel(e.target.value)}>
              {CLONE_MODELS.map((m, i) => <option key={m} value={m}>{i === 0 ? `${m} · ${t('voicecreate.recommended')}` : m}</option>)}
              <option value={CUSTOM_MODEL}>{t('voicecreate.customModel')}</option>
            </select>
          )}
          {p.kind === 'read' && auth && custom && (
            <input type="text" className="voice-create-model-custom" value={customModel} disabled={busy} aria-label={t('voicecreate.customModel')} placeholder={t('voicecreate.customModelPlaceholder')} onChange={(e) => setCustomModel(e.target.value)} />
          )}
          <input type="text" className="voice-create-name" maxLength={p.cloud ? 20 : 32} value={name} disabled={busy} aria-label={t(p.cloud ? 'voicecreate.nameCloud' : 'voicecreate.nameDirect')} placeholder={t(p.cloud ? 'voicecreate.nameCloud' : 'voicecreate.nameDirect')} onChange={(e) => setName(e.target.value)} />
          <label className="voice-create-consent"><input type="checkbox" className="voice-create-agree" checked={consent} disabled={busy} onChange={(e) => setConsent(e.target.checked)} /><span>{t('voicecreate.consent')}</span></label>
          <div className="voice-create-use">{p.kind === 'call' ? <AudioLines size={13} /> : <Volume2 size={13} />}{t(p.kind === 'call' ? 'voicecreate.useCall' : 'voicecreate.useRead', { model: target })}</div>
        </>
      ) : (
        <>
          <textarea rows={3} value={prompt} disabled={busy} placeholder={t('voicecreate.designPrompt')} aria-label={t('voicecreate.tabDesign')} onChange={(e) => setPrompt(e.target.value)} />
          <input type="text" value={previewText} disabled={busy} placeholder={t('voicecreate.designText')} aria-label={t('voicecreate.designText')} onChange={(e) => setPreviewText(e.target.value)} />
          <input type="text" value={name} disabled={busy} placeholder={t('voicecreate.nameDirect')} aria-label={t('voicecreate.nameDirect')} onChange={(e) => setName(e.target.value)} />
          <div className="voice-create-use"><Volume2 size={13} />{t('voicecreate.designUse')}</div>
        </>
      )}
      {busy && <div className="voice-create-bar" role="progressbar"><i /></div>}
      {msg && <p className="voice-create-note" role="status">{msg}</p>}
      <div className="voice-create-foot">
        {busy && <button type="button" className="btn ghost sm" onClick={() => setHidden(true)}>{t('voicecreate.background')}</button>}
        {tab === 'clone'
          ? <button type="button" className="btn primary sm voice-create-go" disabled={!sample?.ok || !consent || busy || !target} onClick={doClone}>{busy ? <Loader2 size={12} className="spin" /> : <Check size={12} />}{t('voicecreate.start')}</button>
          : <button type="button" className="btn primary sm voice-create-design" disabled={!prompt.trim() || busy} onClick={doDesign}>{busy ? <Loader2 size={12} className="spin" /> : <Sparkles size={12} />}{t('voicecreate.designGo')}</button>}
      </div>
    </>
  )
  return createPortal(<div className="voice-create-overlay"><div className="voice-create" role="dialog" aria-modal="true" aria-label={t('voicecreate.title')}>{body}</div></div>, document.body)
}
