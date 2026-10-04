/**
 * 设置 → 模型 → 语音 →「语音通话」一节(对标 GPT Live):开关 + 百炼 Qwen-Omni-Realtime 模型 + 通话音色,可就地复刻自己的声音。
 * 开了(选了模型)输入框空着时发送键才变成通话键(Composer2)。
 * 百炼铁律:复刻音色只能配复刻时的 target_model —— 朗读那边的 cosyvoice / qwen3-tts 音色在这里一律不能用,换模型就得重新复刻。
 */
import { useRef, useState } from 'react'
import { Loader2, Mic } from 'lucide-react'
import type { DirectProviderConfig, StoredDesktopConfig } from '../types'
import { cloneTtsVoice } from '../services/backendService'
import { homeTarget } from '../services/engine/targets'
import { REALTIME_CFG_BUMP_KEY } from '../services/realtimeCall'
import { registerMessages, useI18n } from '../i18n'
import { VoiceSamplePicker, type VoiceSample } from './VoiceSamplePicker'

const MODELS = ['qwen3.8-omni-flash-realtime', 'qwen3.5-omni-plus-realtime', 'qwen3.5-omni-flash-realtime']
// 百炼「Qwen-Omni-Realtime 音色列表」里的一部分(全表 36+ 种,可直接手输名字)
const VOICES = ['Tina', 'Cindy', 'Raymond', 'Katerina', 'Ryan', 'Mia', 'Jennifer', 'Aiden']
const PRESETS = new Set(VOICES)
const DEFAULT_VOICE = 'Tina' // 引擎留空时用的那个(realtimeVoice.ts DEFAULT_VOICE)
const CUSTOM = '__custom__'

registerMessages({
  'settings.realtime.title': { zh: '语音通话', en: 'Voice call' },
  'settings.realtime.enable': { zh: '启用语音通话', en: 'Turn on voice calls' },
  'settings.realtime.intro': { zh: '像打电话一样和 Agent 对话，随时插话打断；要动手的事（查资料、读写文件、跑任务）交给 Agent 办完再说给你听。开启后，输入框空着时发送键就是通话键。', en: 'Talk to the agent like a phone call and interrupt any time; anything that needs real work (looking things up, files, tasks) is handed to the agent and read back to you. Once on, the send button becomes the call button while the composer is empty.' },
  'settings.realtime.model': { zh: '通话模型', en: 'Call model' },
  'settings.realtime.billing': { zh: '走阿里云百炼 Qwen-Omni-Realtime，按百炼的音频时长计费。', en: 'Runs on Alibaba Cloud Bailian Qwen-Omni-Realtime and is billed by Bailian per audio duration.' },
  'settings.realtime.needProvider': { zh: '需要先在「模型 → 提供方」里添加一个阿里云百炼（DashScope）提供方。', en: 'Add an Alibaba Cloud Bailian (DashScope) provider under Models → Providers first.' },
  'settings.realtime.voice': { zh: '通话音色', en: 'Call voice' },
  'settings.realtime.voiceHint': { zh: '只用于语音通话，和下面「朗读」的音色互不通用。', en: 'Used only in voice calls; it is not shared with the read-aloud voices below.' },
  'settings.realtime.voiceCustom': { zh: '自定义音色 ID…', en: 'Custom voice ID…' },
  'settings.realtime.voiceMine': { zh: '我的音色 · {id}', en: 'My voice · {id}' },
  'settings.realtime.voiceIdPlaceholder': { zh: '填百炼音色 ID，回车保存', en: 'Bailian voice ID, press Enter to save' },
  'settings.realtime.cloneTitle': { zh: '用自己的声音复刻…', en: 'Clone your own voice…' },
  'settings.realtime.cloneHint': { zh: '照着文案录一段，或选一个 10–20 秒的干净人声录音；复刻成功后自动采用。音色只认当前的通话模型，换模型后要重新复刻。', en: 'Record the passage, or choose a clean 10–20 second voice recording. The voice is applied automatically once cloned. It only works with the current call model, so switching models means cloning again.' },
  'settings.realtime.cloneBtn': { zh: '复刻', en: 'Clone' },
  'settings.realtime.cloned': { zh: '已采用复刻音色 {voice}', en: 'Now using cloned voice {voice}' },
  'settings.realtime.voice.Tina': { zh: '甜甜 · 温暖女声', en: 'Warm female' },
  'settings.realtime.voice.Cindy': { zh: '林欣宜 · 台湾腔女声', en: 'Taiwanese-accent female' },
  'settings.realtime.voice.Raymond': { zh: '林川野 · 清亮男声', en: 'Clear male' },
  'settings.realtime.voice.Katerina': { zh: '卡捷琳娜 · 御姐音', en: 'Mature female' },
  'settings.realtime.voice.Ryan': { zh: '甜茶 · 戏感男声', en: 'Dramatic male' },
  'settings.realtime.voice.Mia': { zh: '舒然 · 温柔女声', en: 'Gentle female' },
  'settings.realtime.voice.Jennifer': { zh: '詹妮弗 · 美语女声', en: 'American female' },
  'settings.realtime.voice.Aiden': { zh: '艾登 · 美语男声', en: 'American male' },
})

export function RealtimeVoiceSettings({ stored, providers, onSaved }: {
  stored: StoredDesktopConfig
  providers: DirectProviderConfig[]
  onSaved: (c: StoredDesktopConfig) => void
}) {
  const { t } = useI18n()
  const [customId, setCustomId] = useState<string | null>(null) // 非 null = 正在填自定义音色 ID
  const [sample, setSample] = useState<VoiceSample | null>(null)
  const [pickerKey, setPickerKey] = useState(0) // 复刻成功后换 key = 把录音区清回初始
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const voiceRef = useRef<HTMLSelectElement>(null)
  const [cloneOpen, setCloneOpen] = useState(false)
  const lastModel = useRef('') // 关掉再打开回到上次选的模型
  const ds = providers.filter((p) => /dashscope|aliyuncs\.com/i.test(p.baseUrl))
  const model = stored.realtimeModelId || ''
  const provider = ds.find((p) => model.startsWith(p.providerId + '/'))
  const voice = stored.realtimeVoice || ''
  const save = (patch: Partial<StoredDesktopConfig>) => window.tangu!.setConfig(patch).then((c) => {
    onSaved(c)
    try { localStorage.setItem(REALTIME_CFG_BUMP_KEY, String(Date.now())) } catch { /* ignore */ } // 叫主窗重读(见 useRealtimeConfig)
  })
  // 关掉只清模型、不动音色:复刻出来的音色 ID 丢了就得重新花钱复刻
  const toggle = (): void => {
    if (model) { lastModel.current = model; void save({ realtimeModelId: '' }) }
    else void save({ realtimeModelId: lastModel.current || `${ds[0].providerId}/${MODELS[0]}` })
  }
  const pickVoice = (v: string): void => {
    if (v === CUSTOM) { setCustomId(PRESETS.has(voice) ? '' : voice); return }
    setCustomId(null)
    void save({ realtimeVoice: v })
  }
  const commitCustom = (): void => {
    if (customId === null) return
    const v = customId.trim()
    setCustomId(null)
    if (v && v !== voice) void save({ realtimeVoice: v }) // 空着离开 = 放弃,别把已选的音色清成默认(Codex 10-02);要默认就在下拉里选 Tina
  }

  const doClone = (): void => {
    if (!sample?.ok || !provider || busy) return
    setBusy(true); setMsg('')
    cloneTtsVoice(homeTarget(), { baseUrl: provider.baseUrl, apiKey: provider.apiKey || '', name, audioData: sample.dataUri, targetModel: model.slice(provider.providerId.length + 1), ...sample.script })
      .then((r) => save({ realtimeVoice: r.voice }).then(() => {
        setMsg([t('settings.realtime.cloned', { voice: r.voice }), r.fallbackReason ? t('voicesample.scriptMismatch') : ''].filter(Boolean).join(' '))
        setSample(null); setPickerKey((k) => k + 1); setName('')
      }))
      .catch((e: any) => setMsg(`✗ ${e?.message || e}`))
      .finally(() => setBusy(false))
  }

  if (!ds.length) {
    return (
      <div className="field">
        <label>{t('settings.realtime.title')}</label>
        <div className="hint">{t('settings.realtime.needProvider')}</div>
      </div>
    )
  }
  return (
    <>
      <div className="field">
        <div className="switch-row" style={{ minHeight: 30 }}>
          <button type="button" role="switch" aria-checked={!!model} aria-label={t('settings.realtime.enable')}
            className={`switch realtime-switch${model ? ' on' : ''}`} onClick={toggle} />
          <span>{t('settings.realtime.enable')}</span>
        </div>
        <div className="hint" style={{ marginTop: 6 }}>{t('settings.realtime.intro')}</div>
        {model && (
          <>
            <label style={{ marginTop: 12 }}>{t('settings.realtime.model')}</label>
            <select className="realtime-model" aria-label={t('settings.realtime.model')} value={model} onChange={(e) => void save({ realtimeModelId: e.target.value })}>
              {ds.flatMap((p) => MODELS.map((m) => (
                <option key={`${p.providerId}/${m}`} value={`${p.providerId}/${m}`}>{ds.length > 1 ? `${p.providerId} · ${m}` : m}</option>
              )))}
              {!provider && <option value={model}>{model}</option>}
            </select>
            <div className="hint">{t('settings.realtime.billing')}</div>
          </>
        )}
      </div>
      {model && (
        <div className="field">
          <label>{t('settings.realtime.voice')}</label>
          <select ref={voiceRef} className="realtime-voice" aria-label={t('settings.realtime.voice')} value={customId !== null ? CUSTOM : voice || DEFAULT_VOICE} onChange={(e) => pickVoice(e.target.value)}>
            {VOICES.map((v) => <option key={v} value={v}>{`${v} · ${t(`settings.realtime.voice.${v}`)}`}</option>)}
            {voice && !PRESETS.has(voice) && <option value={voice}>{t('settings.realtime.voiceMine', { id: voice })}</option>}
            <option value={CUSTOM}>{t('settings.realtime.voiceCustom')}</option>
          </select>
          {customId !== null && (
            <input type="text" autoFocus style={{ marginTop: 8 }} value={customId} placeholder={t('settings.realtime.voiceIdPlaceholder')}
              onChange={(e) => setCustomId(e.target.value)} onBlur={commitCustom}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { commitCustom(); voiceRef.current?.focus() } }} />
          )}
          <div className="hint">{t('settings.realtime.voiceHint')}</div>
          {provider && (
            <>
              <button className="btn ghost sm realtime-clone-toggle" style={{ marginTop: 10 }} aria-expanded={cloneOpen} onClick={() => setCloneOpen((o) => !o)}>
                <Mic size={12} /> {t('settings.realtime.cloneTitle')}
              </button>
              {cloneOpen && (<>
              <div className="hint" style={{ margin: '8px 0' }}>{t('settings.realtime.cloneHint')}</div>
              <VoiceSamplePicker key={pickerKey} onChange={setSample} disabled={busy} />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                <input type="text" style={{ width: 140 }} value={name} placeholder={t('settings.tts.studio.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
                <button className="btn primary sm realtime-clone-go" disabled={!sample?.ok || busy} onClick={doClone}>
                  {busy ? <Loader2 size={12} className="spin" /> : null} {t('settings.realtime.cloneBtn')}
                </button>
              </div>
              </>)}
              {msg && <div className="hint" style={{ marginTop: 6 }}>{msg}</div>}
            </>
          )}
        </div>
      )}
    </>
  )
}
