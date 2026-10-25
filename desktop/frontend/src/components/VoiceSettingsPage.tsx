/**
 * 设置 → 模型 → 语音(10-25 走查续 4.5 换成设置卡片 + 行,和「常规」「Space」「通知」同一套):
 *  - 语音通话(RealtimeVoiceSettings):卡头说明 + 下一步(添加提供方 / 去选模型);有通话模型时下面是音色与复刻
 *  - 本地语音识别(AsrModelChoice):卡头右边「下载」→ 进度 →「已下载」
 *  - 朗读:卡头右边「去选模型」(选好就不出);四行 = 音色 + 试听 / 语速 / 回复完自动朗读 / 复刻·设计音色。
 *    没选朗读模型时四行照样能填(只是不出声),不置灰;只有「试听」要模型才能按。
 * 每行声明窄屏排法 fit(SettingsRow):开关、单个按钮留在右边,输入框换到下一行占满。
 * 纯排法迁移:写的键与时机和旧页一致(ttsVoice 走草稿 + 失焦提交,ttsSpeed 失焦夹到 0.5–2,ttsAutoSpeak 即时写)。
 */
import { useState, type ReactNode } from 'react'
import { Loader2, Play, Volume2 } from 'lucide-react'
import type { DirectProviderConfig, StoredDesktopConfig, TanguDesktopConfig } from '../types'
import type { CloudCallModel } from '../services/realtimeModel'
import { previewTts } from '../services/ttsService'
import { homeTarget } from '../services/engine/targets'
import { registerMessages, useI18n } from '../i18n'
import { SettingsPanel, SettingsRow, SettingsSwitch } from './SettingsPrimitives'
import { RealtimeVoiceSettings } from './RealtimeVoiceSettings'
import { AsrModelChoice } from './AsrModelChoice'
import { TtsVoiceStudio } from './TtsVoiceStudio'

registerMessages({
  'settings.voice.secRead': { zh: '朗读', en: 'Read aloud' },
  'settings.voice.addProvider': { zh: '添加提供方', en: 'Add provider' },
  'settings.voice.chooseModel': { zh: '去选模型', en: 'Choose model' },
  'settings.voice.collapse': { zh: '收起', en: 'Hide' },
  'settings.voice.readNoModel': { zh: '还没选朗读模型。下面几项可以先填，选好模型以后生效。', en: 'No read-aloud model yet. You can fill in the options below now; they take effect once you pick one.' },
  'settings.voice.readModel': { zh: '用「{model}」朗读回复；换模型在「默认模型 → 朗读」。', en: 'Replies are read aloud with {model}. Change it under Default models → Read aloud.' },
  'settings.tts.voiceHint': { zh: '部分服务（如 OpenAI）必填；留空就不传音色，用模型默认的。', en: 'Required by some services, such as OpenAI. Leave it empty to use the model default.' },
  'settings.tts.voiceLabel': { zh: '音色', en: 'Voice' },
  'settings.tts.speedLabel': { zh: '语速', en: 'Speed' },
  'settings.tts.speedHint': { zh: '0.5 到 2 倍', en: '0.5× to 2×' },
  'settings.tts.studio.row': { zh: '复刻 / 设计音色', en: 'Clone or design a voice' },
  'settings.tts.studio.rowHint': { zh: '复刻你的声音，或用一句话设计一个。', en: 'Clone your voice, or design one from a description.' },
  'settings.tts.studio.rowNeedProvider': { zh: '需要一个指向阿里云百炼（DashScope）的提供方。', en: 'Needs a provider pointing at Alibaba Cloud Bailian (DashScope).' },
  'settings.tts.studio.open': { zh: '展开', en: 'Show' },
})

// 系统音色候选(datalist 可输可选;百炼无音色列表 API,静态维护常用项;全量见百炼「Qwen-TTS 音色列表」文档)。
// ⚠️ 表在模块作用域,只能存**文案 key**:写死字面量会在模块加载时冻结,切语言不会更新。
// 第一列是音色 id(发给接口的标识符,永不翻译),第二列是显示名的 key,渲染时 t() 解析。
const TTS_VOICE_SUGGESTIONS: Array<[string, string]> = [
  ['Cherry', 'settingsmodal.tts.voice.cherry'], ['Serena', 'settingsmodal.tts.voice.serena'],
  ['Ethan', 'settingsmodal.tts.voice.ethan'], ['Chelsie', 'settingsmodal.tts.voice.chelsie'],
  ['Nofish', 'settingsmodal.tts.voice.nofish'], ['Jennifer', 'settingsmodal.tts.voice.jennifer'],
  ['Ryan', 'settingsmodal.tts.voice.ryan'], ['Katerina', 'settingsmodal.tts.voice.katerina'],
  ['Dylan', 'settingsmodal.tts.voice.dylan'], ['Jada', 'settingsmodal.tts.voice.jada'],
  ['Sunny', 'settingsmodal.tts.voice.sunny'], ['Rocky', 'settingsmodal.tts.voice.rocky'],
  ['Kiki', 'settingsmodal.tts.voice.kiki'], ['Marcus', 'settingsmodal.tts.voice.marcus'],
  ['Roy', 'settingsmodal.tts.voice.roy'], ['Peter', 'settingsmodal.tts.voice.peter'],
  ['alloy', 'settingsmodal.tts.voice.openai'], ['echo', 'settingsmodal.tts.voice.openai'],
  ['fable', 'settingsmodal.tts.voice.openai'], ['onyx', 'settingsmodal.tts.voice.openai'],
  ['nova', 'settingsmodal.tts.voice.openai'], ['shimmer', 'settingsmodal.tts.voice.openai'],
]

/** 语音页要去的地方:模型 → 提供方 / 默认模型里的「语音通话」「朗读」那一行。 */
export type VoiceSettingsTarget = 'providers' | 'call-model' | 'tts-model'

export function VoiceSettingsPage(p: {
  cfg: TanguDesktopConfig
  /** 合并视图(落盘快照 + 未保存草稿),同 SettingsModal 的 stored。 */
  stored: StoredDesktopConfig | null
  setStored: (c: StoredDesktopConfig) => void
  providers: DirectProviderConfig[]
  cloudModel?: CloudCallModel | null
  cloudAccount: boolean
  signedIn: boolean
  edit: (patch: Partial<StoredDesktopConfig>) => void
  commitEdits: (keys: Array<keyof StoredDesktopConfig>, norm?: (v: Partial<StoredDesktopConfig>) => Partial<StoredDesktopConfig>) => Promise<void>
  commitErrorHint: (key: keyof StoredDesktopConfig) => ReactNode
  onOpen: (target: VoiceSettingsTarget) => void
}) {
  const { stored, setStored } = p
  return (
    <>
      {stored && (
        <RealtimeVoiceSettings stored={stored} providers={p.providers} onSaved={setStored}
          cloudModel={p.cloudModel} cloudAccount={p.cloudAccount} signedIn={p.signedIn} onOpen={p.onOpen} />
      )}
      <AsrModelChoice onSaved={setStored} />
      {stored && <ReadAloudPanel {...p} stored={stored} />}
    </>
  )
}

function ReadAloudPanel(p: Parameters<typeof VoiceSettingsPage>[0] & { stored: StoredDesktopConfig }) {
  const { t } = useI18n()
  const { stored, setStored } = p
  const [speedText, setSpeedText] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testMsg, setTestMsg] = useState('')
  const [studioOpen, setStudioOpen] = useState(false)
  const [studioMounted, setStudioMounted] = useState(false)
  const model = (stored.ttsModelId || '').trim()

  // 百炼音色工作室:有指向阿里云百炼的 provider 才可用(域名判定与后端 isDashScopeBase 一致)。
  // 非本地 external 后端整行不出:本地 providers 文件到不了远端 registry,采用的音色无法合成(判定同上方 externalWarning)。
  const remoteExternal = stored.mode === 'external' && !(stored.backendUrl || '').includes('localhost') && !(stored.backendUrl || '').includes('127.0.0.1')
  const ds = p.providers.find((cp) => /dashscope|aliyuncs\.com/i.test(cp.baseUrl))

  const test = (): void => {
    setTesting(true); setTestMsg('')
    previewTts(homeTarget(), { model, voice: (stored.ttsVoice || '').trim() || undefined, speed: stored.ttsSpeed }, t('settings.tts.testText'))
      .then(() => setTestMsg(`✓ ${t('settings.tts.testOk')}`))
      .catch((e: any) => setTestMsg(`✗ ${e?.message || e}`))
      .finally(() => setTesting(false))
  }
  const voiceError = p.commitErrorHint('ttsVoice')

  return (
    <SettingsPanel className="settings-voice-read" icon={<Volume2 size={16} />} title={t('settings.voice.secRead')}
      description={model ? t('settings.voice.readModel', { model }) : t('settings.voice.readNoModel')}
      actions={model ? undefined : <button type="button" className="btn ghost sm" onClick={() => p.onOpen('tts-model')}>{t('settings.voice.chooseModel')}</button>}>
      <div className="settings-control-list">
        <SettingsRow fit="wrap" className="settings-voice-tts-row" label={t('settings.tts.voiceLabel')} description={t('settings.tts.voiceHint')} control={
          <span className="settings-voice-inline settings-voice-tts">
            <input
              type="text"
              list="tts-voice-options"
              aria-label={t('settings.tts.voice')}
              value={stored.ttsVoice ?? ''}
              onChange={(e) => p.edit({ ttsVoice: e.target.value })}
              onBlur={() => void p.commitEdits(['ttsVoice'], (v) => ({ ttsVoice: (v.ttsVoice || '').trim() }))}
              placeholder={t('settings.tts.voicePlaceholder')}
            />
            {/* 系统音色候选(可输可选);复刻 / 设计音色经下方工作室「使用」自动填入 */}
            <datalist id="tts-voice-options">
              {TTS_VOICE_SUGGESTIONS.map(([v, labelKey]) => <option key={v} value={v} label={t(labelKey)} />)}
            </datalist>
            <button type="button" className="btn ghost sm settings-voice-test" disabled={testing || !model} onClick={test}>
              {testing ? <Loader2 size={12} className="spin" /> : <Play size={12} />}{t('settings.tts.testBtn')}
            </button>
          </span>
        } />
        {(voiceError || testMsg) && (
          <div className="settings-row-notes">
            {voiceError}
            {testMsg && <p className="settings-voice-note" role="status">{testMsg}</p>}
          </div>
        )}
        <SettingsRow fit="wrap" label={t('settings.tts.speedLabel')} description={t('settings.tts.speedHint')} control={
          <input
            type="number"
            className="settings-number-input settings-voice-speed"
            aria-label={t('settings.tts.speedLabel')}
            min={0.5}
            max={2}
            step={0.1}
            value={speedText ?? String(stored.ttsSpeed ?? 1)}
            onChange={(e) => setSpeedText(e.target.value)}
            onBlur={() => {
              const n = Number(speedText)
              const v = speedText !== null && Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, 0.5), 2) : (stored.ttsSpeed ?? 1)
              setSpeedText(null)
              void window.tangu!.setConfig({ ttsSpeed: v }).then(setStored)
            }}
          />
        } />
        <SettingsRow fit="inline" label={t('settings.tts.autoSpeak')} description={t('settings.tts.autoSpeakHint')} control={
          <SettingsSwitch checked={stored.ttsAutoSpeak === true} label={t('settings.tts.autoSpeak')}
            onChange={(on) => void window.tangu!.setConfig({ ttsAutoSpeak: on }).then(setStored)} />
        } />
        {!remoteExternal && (
          <SettingsRow fit="inline" label={t('settings.tts.studio.row')} description={t(ds ? 'settings.tts.studio.rowHint' : 'settings.tts.studio.rowNeedProvider')} control={
            ds
              ? <button type="button" className="btn ghost sm tts-studio-toggle" aria-expanded={studioOpen} onClick={() => { setStudioMounted(true); setStudioOpen((o) => !o) }}>{t(studioOpen ? 'settings.voice.collapse' : 'settings.tts.studio.open')}</button>
              : <button type="button" className="btn ghost sm" onClick={() => p.onOpen('providers')}>{t('settings.voice.addProvider')}</button>
          } />
        )}
        {/* 第一次展开以后一直挂着,收起只是藏起来(Codex 评审 P2):工作室里有进行中的复刻 / 设计请求和忙碌锁,
            卸载会丢掉锁,收起再展开就能再发一次,先发的那个晚回来会把新音色覆盖掉。 */}
        {!remoteExternal && ds && studioMounted && (
          <div className="settings-voice-studio-wrap" hidden={!studioOpen}>
            <TtsVoiceStudio cfg={p.cfg} provider={ds} onApplied={() => void window.tangu!.getConfig().then(setStored)} />
          </div>
        )}
      </div>
    </SettingsPanel>
  )
}
