/**
 * 设置 → 语音 → 实时语音通话(对标 GPT Live):选百炼 Qwen-Omni-Realtime 模型 + 音色,可就地复刻自己的声音。
 * 选了模型输入框才出「实时语音通话」按钮(Composer2)。
 * 百炼铁律:复刻音色只能配复刻时的 target_model —— 朗读那边的 cosyvoice / qwen3-tts 音色在这里一律不能用,换模型就得重新复刻。
 */
import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { DirectProviderConfig, StoredDesktopConfig } from '../types'
import { cloneTtsVoice } from '../services/backendService'
import { homeTarget } from '../services/engine/targets'
import { REALTIME_CFG_BUMP_KEY } from '../services/realtimeCall'
import { registerMessages, useI18n } from '../i18n'

const MODELS = ['qwen3.8-omni-flash-realtime', 'qwen3.5-omni-plus-realtime', 'qwen3.5-omni-flash-realtime']
// 百炼「Qwen-Omni-Realtime 音色列表」里的一部分(全表 36+ 种,可直接手输名字)
const VOICES = ['Tina', 'Cindy', 'Raymond', 'Katerina', 'Ryan', 'Mia', 'Jennifer', 'Aiden']
const MAX_AUDIO_MB = 10

registerMessages({
  'settings.realtime.title': { zh: '实时语音通话', en: 'Voice call' },
  'settings.realtime.intro': { zh: '像 GPT Live 一样直接对话：随时插话打断，要动手的事（查资料、读写文件、跑任务）它会交给 Agent 去办，结果再说给你听。走阿里云百炼的 Qwen-Omni-Realtime，按百炼的音频计费。选好模型后，输入框会出现通话按钮。', en: 'Talk to it like GPT Live: interrupt any time, and anything that needs real work (looking things up, files, tasks) is handed to the agent, then read back to you. Runs on Alibaba Cloud Bailian Qwen-Omni-Realtime and is billed by Bailian per audio. Once a model is selected, a call button appears in the composer.' },
  'settings.realtime.off': { zh: '不启用', en: 'Off' },
  'settings.realtime.needProvider': { zh: '需要先在「模型 → 服务商」里添加一个阿里云百炼（DashScope）服务商。', en: 'Add an Alibaba Cloud Bailian (DashScope) provider under Models → Providers first.' },
  'settings.realtime.voice': { zh: '音色', en: 'Voice' },
  'settings.realtime.voiceHint': { zh: '可选预置音色，也可填复刻出来的音色 ID；留空用 Tina。朗读用的音色不能用在这里。', en: 'Pick a preset or enter a cloned voice ID; empty means Tina. Read-aloud voices do not work here.' },
  'settings.realtime.cloneTitle': { zh: '用自己的声音', en: 'Use your own voice' },
  'settings.realtime.cloneHint': { zh: '上传 10–20 秒干净的人声（不超过 60 秒、10MB，采样率 ≥ 24kHz），复刻成功后自动采用。音色只认当前选的模型，换模型后要重新复刻。', en: 'Upload 10–20 seconds of clean speech (max 60 s and 10 MB, at least 24 kHz). The cloned voice is applied automatically. It only works with the model selected now; re-clone after switching models.' },
  'settings.realtime.cloneBtn': { zh: '复刻', en: 'Clone' },
  'settings.realtime.cloned': { zh: '已采用复刻音色 {voice}', en: 'Now using cloned voice {voice}' },
  'settings.realtime.fileTooLarge': { zh: '文件超过 {mb}MB', en: 'File is larger than {mb} MB' },
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
  const [voiceText, setVoiceText] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const ds = providers.filter((p) => /dashscope|aliyuncs\.com/i.test(p.baseUrl))
  const model = stored.realtimeModelId || ''
  const provider = ds.find((p) => model.startsWith(p.providerId + '/'))
  const save = (patch: Partial<StoredDesktopConfig>) => window.tangu!.setConfig(patch).then((c) => {
    onSaved(c)
    try { localStorage.setItem(REALTIME_CFG_BUMP_KEY, String(Date.now())) } catch { /* ignore */ } // 叫主窗重读(见 useRealtimeConfig)
  })

  const doClone = (): void => {
    if (!file || !provider || busy) return
    if (file.size > MAX_AUDIO_MB * 1024 * 1024) { setMsg(t('settings.realtime.fileTooLarge', { mb: MAX_AUDIO_MB })); return }
    setBusy(true); setMsg('')
    const fr = new FileReader()
    fr.onerror = () => { setBusy(false); setMsg('✗ read file failed') }
    fr.onload = () => {
      cloneTtsVoice(homeTarget(), { baseUrl: provider.baseUrl, apiKey: provider.apiKey || '', name, audioData: String(fr.result), targetModel: model.slice(provider.providerId.length + 1) })
        .then((r) => save({ realtimeVoice: r.voice }).then(() => { setMsg(t('settings.realtime.cloned', { voice: r.voice })); setFile(null); setName('') }))
        .catch((e: any) => setMsg(`✗ ${e?.message || e}`))
        .finally(() => setBusy(false))
    }
    fr.readAsDataURL(file)
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
        <label>{t('settings.realtime.title')}</label>
        <div className="hint" style={{ marginBottom: 8 }}>{t('settings.realtime.intro')}</div>
        <select className="realtime-model" value={model} onChange={(e) => void save({ realtimeModelId: e.target.value })}>
          <option value="">{t('settings.realtime.off')}</option>
          {ds.flatMap((p) => MODELS.map((m) => (
            <option key={`${p.providerId}/${m}`} value={`${p.providerId}/${m}`}>{ds.length > 1 ? `${p.providerId} · ${m}` : m}</option>
          )))}
          {model && !provider && <option value={model}>{model}</option>}
        </select>
      </div>
      {model && (
        <div className="field">
          <label>{t('settings.realtime.voice')}</label>
          <input
            type="text"
            list="realtime-voice-options"
            value={voiceText ?? stored.realtimeVoice ?? ''}
            placeholder="Tina"
            onChange={(e) => setVoiceText(e.target.value)}
            onBlur={() => { if (voiceText !== null) { const v = voiceText.trim(); setVoiceText(null); void save({ realtimeVoice: v }) } }}
          />
          <datalist id="realtime-voice-options">
            {VOICES.map((v) => <option key={v} value={v} label={t(`settings.realtime.voice.${v}`)} />)}
          </datalist>
          <div className="hint">{t('settings.realtime.voiceHint')}</div>
        </div>
      )}
      {model && provider && (
        <div className="field">
          <label>{t('settings.realtime.cloneTitle')}</label>
          <div className="hint" style={{ marginBottom: 8 }}>{t('settings.realtime.cloneHint')}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="file" accept="audio/*" onChange={(e) => { setFile(e.target.files?.[0] || null); e.target.value = '' }} />
            {file && <span style={{ fontSize: 'var(--ui-font-meta, 12px)', color: 'var(--text-muted)' }}>{file.name}</span>}
            <input type="text" style={{ width: 140 }} value={name} placeholder={t('settings.tts.studio.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
            <button className="btn primary sm" disabled={!file || busy} onClick={doClone}>
              {busy ? <Loader2 size={12} className="spin" /> : null} {t('settings.realtime.cloneBtn')}
            </button>
          </div>
          {msg && <div className="hint" style={{ marginTop: 6 }}>{msg}</div>}
        </div>
      )}
    </>
  )
}
