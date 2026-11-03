/**
 * 设置 → 模型 → 语音(10-25 走查续 4.5 换成设置卡片 + 行;10-31 音色改成卡片,方案 B):
 *  - 语音通话(RealtimeVoiceSettings):开关 + 通话模型 + 通话音色卡片
 *  - 本地语音识别(AsrModelChoice):卡头右边「下载」→ 进度 →「已下载」
 *  - 朗读:朗读模型 + 朗读音色卡片 + 语速 + 回复完自动朗读。没选朗读模型时音色也能先选(只是不出声)。
 * 每行声明窄屏排法 fit(SettingsRow):开关、单个按钮留在右边,输入框换到下一行占满。
 * 通话音色和朗读音色互不通用,所以各放一份,不混排。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { ChevronRight, Volume2 } from 'lucide-react'
import type { DirectProviderConfig, StoredDesktopConfig, TanguDesktopConfig } from '../types'
import type { CloudCallModel } from '../services/realtimeModel'
import { isDashScope } from '../services/realtimeModel'
import { effectiveTtsConfig } from '../services/ttsService'
import { deleteTtsVoice, listTtsVoices, synthesizeTts, type TtsVoiceInfo } from '../services/backendService'
import { BAILIAN_READ_VOICES, OPENAI_READ_VOICES, toggleVoicePreview, voiceSampleUrl } from '../services/voiceCatalog'
import { homeTarget } from '../services/engine/targets'
import { registerMessages, useI18n } from '../i18n'
import { SettingsPanel, SettingsRow, SettingsSwitch } from './SettingsPrimitives'
import { RealtimeVoiceSettings } from './RealtimeVoiceSettings'
import { AsrModelChoice } from './AsrModelChoice'
import { VoiceGallery, type VoiceItem } from './VoiceGallery'
import { VoiceCreateDialog, type VoiceCreated } from './VoiceCreateDialog'

registerMessages({
  'settings.tts.unknownBinding': { zh: '绑定模型未知', en: 'Unknown model' },
  'settings.tts.unknownBindingHint': { zh: '不知道这个音色绑在哪个模型上，没法用于朗读。可以删掉重新复刻。', en: "We can't tell which model this voice is tied to, so it can't be used for read-aloud. You can delete it and clone again." },
  'settings.voice.secRead': { zh: '朗读', en: 'Read aloud' },
  'settings.voice.addProvider': { zh: '添加提供方', en: 'Add provider' },
  'settings.voice.chooseModel': { zh: '去选模型', en: 'Choose model' },
  'settings.voice.readDesc': { zh: '点消息下方的朗读键，或让新回复读出来。', en: 'Tap the read-aloud button under a message, or have new replies read out.' },
  'settings.voice.readNoModel': { zh: '还没选朗读模型。下面几项可以先设，选好模型以后生效。', en: 'No read-aloud model yet. You can set the options below now; they take effect once you pick one.' },
  'settings.voice.readModelRow': { zh: '朗读模型', en: 'Read-aloud model' },
  'settings.tts.voiceLabel': { zh: '朗读音色', en: 'Read-aloud voice' },
  'settings.tts.customVoice': { zh: '自定义音色', en: 'Custom voice' },
  'settings.tts.customVoiceHint': { zh: '部分服务（如 OpenAI）必填；留空就不传音色，用模型默认的。', en: 'Required by some services, such as OpenAI. Leave it empty to use the model default.' },
  'settings.tts.speedLabel': { zh: '语速', en: 'Speed' },
  'settings.tts.mineDelete': { zh: '删除音色「{name}」？删除后不能恢复。', en: 'Delete the voice "{name}"? This cannot be undone.' },
  'settings.tts.previewNoModel': { zh: '选好朗读模型后才能试听这个音色。', en: 'Pick a read-aloud model to preview this voice.' },
})

// 与后端 routes/tts.ts 的 DASHSCOPE_VC/VD_MODEL 保持一致(列表项缺 targetModel 时按 kind 兜底)。
// voice-enrollment 那一类(kind=cosy)不兜底:它底下有十来个模型,猜错就是一对配不上的模型和音色 → 不知道绑的是谁就不给用。
const KIND_MODEL: Record<'clone' | 'design', string> = { clone: 'qwen3-tts-vc-2026-01-22', design: 'qwen3-tts-vd-2026-01-26' }
const boundModel = (v: TtsVoiceInfo): string => v.targetModel || (v.kind === 'cosy' ? '' : KIND_MODEL[v.kind])
/** 绑在通话模型上的音色(Qwen-Omni / *-realtime):朗读用不了。 */
const callOnly = (targetModel?: string): boolean => /omni|realtime/i.test(targetModel || '')
/** 这个朗读模型认哪张系统音色表;认不出来就只剩「自定义音色」。 */
const readVoicesFor = (model: string): string[] => (/tts-1|gpt-.*tts|openai/i.test(model) ? OPENAI_READ_VOICES : !model || /qwen3?-tts/i.test(model) ? BAILIAN_READ_VOICES : [])
const COLLAPSED = 8

/** 语音页要去的地方:模型 → 提供方 / 默认模型里的「语音通话」「朗读」那一行。 */
export type VoiceSettingsTarget = 'providers' | 'call-model' | 'tts-model'

export function VoiceSettingsPage(p: {
  cfg: TanguDesktopConfig
  /** 合并视图(落盘快照 + 未保存草稿),同 SettingsModal 的 stored。 */
  stored: StoredDesktopConfig | null
  setStored: (c: StoredDesktopConfig) => void
  providers: DirectProviderConfig[]
  cloudModel?: CloudCallModel | null
  /** 后台给的朗读默认(用户没动过时跟随)。 */
  ttsDefault?: { ttsModelId?: string | null; ttsVoice?: string | null } | null
  cloudAccount: boolean
  signedIn: boolean
  edit: (patch: Partial<StoredDesktopConfig>) => void
  commitEdits: (keys: Array<keyof StoredDesktopConfig>, norm?: (v: Partial<StoredDesktopConfig>) => Partial<StoredDesktopConfig>) => Promise<void>
  commitErrorHint: (key: keyof StoredDesktopConfig) => ReactNode
  onOpen: (target: VoiceSettingsTarget) => void
  /** 非本地 external 后端:由 SettingsModal 按连接表单算好传入(引擎基址只许在白名单文件里读,见 engineTargetGuard)。 */
  remoteExternal: boolean
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
  const { t, locale } = useI18n()
  const { setStored } = p
  const stored = effectiveTtsConfig(p.stored, p.ttsDefault, p.signedIn)!
  const model = (stored.ttsModelId || '').trim()
  const voice = stored.ttsVoice || ''
  const [note, setNote] = useState('')
  const [creating, setCreating] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [voices, setVoices] = useState<TtsVoiceInfo[]>([])
  const [reload, setReload] = useState(0)
  // 非本地 external 后端不给新建:本地 providers 文件到不了远端 registry,采用的音色无法合成。
  const ds = p.remoteExternal ? undefined : p.providers.find(isDashScope)
  const auth = ds ? { baseUrl: ds.baseUrl, apiKey: ds.apiKey || '' } : null
  useEffect(() => {
    if (!auth) return
    let stale = false
    listTtsVoices(homeTarget(), auth).then((v) => { if (!stale) setVoices(v || []) }).catch(() => { /* 列不出来就只剩系统音色 */ })
    return () => { stale = true }
  }, [auth?.baseUrl, auth?.apiKey, reload])

  const save = (patch: Partial<StoredDesktopConfig>): void => { setNote(''); void window.tangu!.setConfig(patch).then(setStored).catch((e: any) => setNote(`✗ ${e?.message || e}`)) }
  const preview = (v: string): void => {
    const url = voiceSampleUrl('read', v, locale)
    if (!url && !model) { setNote(t('settings.tts.previewNoModel')); return }
    void toggleVoicePreview(`read:${v}`, () => url || previewTtsUrl(v)).catch((e: any) => setNote(`✗ ${e?.message || e}`))
  }
  // 系统音色没有样音、复刻 / 设计的音色:现合成一句(走当前朗读模型)
  const previewTtsUrl = (v: string): Promise<string> => synthesizeTts(homeTarget(), { text: t('settings.tts.testText'), model, voice: v, ...(stored.ttsSpeed && stored.ttsSpeed !== 1 ? { speed: stored.ttsSpeed } : {}) }).then((b) => URL.createObjectURL(b))
  const presets = readVoicesFor(model)
  const list = showAll ? presets : presets.slice(0, COLLAPSED)
  const named = (v: string): boolean => BAILIAN_READ_VOICES.includes(v)
  const system: VoiceItem[] = (list.includes(voice) || !presets.includes(voice) ? list : [...list.slice(0, -1), voice]).map((v) => ({
    id: v, name: named(v) ? t(`voice.read.${v}.name`) : v, desc: named(v) ? t(`voice.read.${v}.desc`) : undefined, onPreview: () => preview(v),
  }))
  const mine: VoiceItem[] = voices.filter((v) => !callOnly(v.targetModel)).map((v) => ({
    // 百炼没回绑定模型的音色:用不了,但要能删
    id: v.voice, name: v.voice, desc: boundModel(v) || t('settings.tts.unknownBinding'), bound: !boundModel(v), onPreview: boundModel(v) === model.slice((ds?.providerId.length ?? -1) + 1) ? () => preview(v.voice) : undefined,
    onDelete: () => { if (window.confirm(t('settings.tts.mineDelete', { name: v.voice }))) void deleteTtsVoice(homeTarget(), { ...auth!, voice: v.voice, kind: v.kind }).then(() => setReload((n) => n + 1)).catch((e: any) => setNote(`✗ ${e?.message || e}`)) },
  }))
  const pickVoice = (item: VoiceItem): void => {
    if (item.bound) { setNote(t('settings.tts.unknownBindingHint')); return }
    const bound = voices.find((v) => v.voice === item.id)
    // 百炼铁律:音色只认创建时的模型,采用时把朗读模型一起切过去
    save(bound && ds ? { ttsModelId: `${ds.providerId}/${boundModel(bound)}`, ttsVoice: item.id } : { ttsVoice: item.id })
  }
  const use = (v: VoiceCreated): void => { if (ds) save({ ttsModelId: `${ds.providerId}/${v.targetModel}`, ttsVoice: v.voice }); setCreating(false) }
  const voiceError = p.commitErrorHint('ttsVoice')
  return (
    <SettingsPanel className="settings-voice-read" icon={<Volume2 size={16} />} title={t('settings.voice.secRead')}
      description={t(model ? 'settings.voice.readDesc' : 'settings.voice.readNoModel')}
      actions={model ? undefined : <button type="button" className="btn ghost sm" onClick={() => p.onOpen('tts-model')}>{t('settings.voice.chooseModel')}</button>}>
      {model && (
        <div className="settings-control-list">
          <SettingsRow fit="inline" label={t('settings.voice.readModelRow')} control={
            <button type="button" className="voice-link" onClick={() => p.onOpen('tts-model')}>{model}<ChevronRight size={13} /></button>
          } />
        </div>
      )}
      <VoiceGallery title={t('settings.tts.voiceLabel')} system={system} mine={mine} value={voice} previewScope="read" onPick={pickVoice}
        onNew={auth ? () => setCreating(true) : undefined} newHint={t('voicegallery.newRead')}
        trailing={presets.length > COLLAPSED ? <button type="button" className="voice-link" onClick={() => setShowAll((v) => !v)}>{showAll ? t('voicegallery.fewer') : t('voicegallery.all', { n: presets.length })}<ChevronRight size={12} /></button> : undefined} />
      <div className="settings-control-list">
        <SettingsRow fit="wrap" className="settings-voice-tts-row" label={t('settings.tts.customVoice')} description={t('settings.tts.customVoiceHint')} control={
          <input type="text" className="settings-voice-tts" aria-label={t('settings.tts.customVoice')} value={p.stored.ttsVoice ?? ''}
            onChange={(e) => p.edit({ ttsVoice: e.target.value })}
            onBlur={() => void p.commitEdits(['ttsVoice'], (v) => ({ ttsVoice: (v.ttsVoice || '').trim() }))}
            placeholder={t('settings.tts.voicePlaceholder')} />
        } />
        {(voiceError || note) && (
          <div className="settings-row-notes">
            {voiceError}
            {note && <p className="settings-voice-note" role="status">{note}</p>}
          </div>
        )}
        <SettingsRow fit="wrap" label={t('settings.tts.speedLabel')} control={
          <span className="voice-slider">
            <input type="range" className="settings-voice-speed" aria-label={t('settings.tts.speedLabel')} min={0.5} max={2} step={0.1} value={stored.ttsSpeed ?? 1}
              onChange={(e) => void window.tangu!.setConfig({ ttsSpeed: Number(e.target.value) }).then(setStored)} />
            <span>{(stored.ttsSpeed ?? 1).toFixed(1)}×</span>
          </span>
        } />
        <SettingsRow fit="inline" label={t('settings.tts.autoSpeak')} description={t('settings.tts.autoSpeakHint')} control={
          <SettingsSwitch checked={stored.ttsAutoSpeak === true} label={t('settings.tts.autoSpeak')}
            onChange={(on) => void window.tangu!.setConfig({ ttsAutoSpeak: on }).then(setStored)} />
        } />
      </div>
      {creating && <VoiceCreateDialog kind="read" provider={ds} onCreated={() => setReload((n) => n + 1)} onUse={use} onClose={() => setCreating(false)} />}
    </SettingsPanel>
  )
}
