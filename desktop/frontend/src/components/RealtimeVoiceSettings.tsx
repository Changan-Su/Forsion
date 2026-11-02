/**
 * 设置 → 模型 → 语音 →「语音通话」一节(对标 GPT Live):开关、通话音色卡片,可新建自己的音色。
 * 选哪个通话模型仍在「默认模型 → 语音通话」(10-17 用户定方案 C):那边用下面导出的 realtimeCandidates / saveRealtimeModel。
 * 通话模型两种来源:Forsion 云端的实时模型(登录即用,从额度里扣),或用户自己的百炼提供方(Qwen-Omni / Qwen-Audio Realtime)。
 * 没动过这个开关的用户默认开着(口径在 services/realtimeModel.ts,与输入框同一处)。
 * 开着时输入框空着发送键才变成通话键(Composer2)。
 * 百炼铁律:复刻音色只能配复刻时的 target_model —— 朗读那边的 cosyvoice / qwen3-tts 音色在这里一律不能用,换模型就得重新复刻。
 */
import { useEffect, useState } from 'react'
import { ChevronRight, LogIn, Phone } from 'lucide-react'
import type { DirectProviderConfig, StoredDesktopConfig } from '../types'
import { cloudDefaultVoice, defaultVoiceFor, effectiveRealtimeModel, isAudioFamily, isDashScope, type CloudCallModel } from '../services/realtimeModel'
import { cloudVoiceSample, deleteCloudVoice, deleteTtsVoice, listCloudVoices, listTtsVoices, type CloudVoice, type TtsVoiceInfo } from '../services/backendService'
import { homeTarget } from '../services/engine/targets'
import { REALTIME_CFG_BUMP_KEY } from '../services/realtimeCall'
import { AUDIO_VOICES, OMNI_VOICES, toggleVoicePreview, voiceSampleUrl } from '../services/voiceCatalog'
import { registerMessages, useI18n } from '../i18n'
import { SettingsPanel, SettingsRow, SettingsSwitch } from './SettingsPrimitives'
import { VoiceGallery, type VoiceItem } from './VoiceGallery'
import { VoiceCreateDialog, type VoiceCreated } from './VoiceCreateDialog'

// 两个家族:Qwen-Omni 与 Qwen-Audio。会话协议通用(10-04 实测:同一份 session.update、ask_tangu 照样调),
// 差在音色 —— 系统音色各一套、互不相认,复刻音色还绑死在具体型号上。qwen-audio-3.0 两个型号没加:用复刻音色实测不出声。
const MODELS = ['qwen3.8-omni-flash-realtime', 'qwen3.5-omni-plus-realtime', 'qwen3.5-omni-flash-realtime', 'qwen-audio-3.1-realtime-plus']
const presetsFor = (m: string, cloud?: CloudCallModel | null): string[] => (isAudioFamily(m, cloud) ? AUDIO_VOICES : OMNI_VOICES)

/** 「语音通话」的候选:云端那个(登录着,或者已经选着它 —— 不然显示不出当前值)+ 每个百炼连接 × 上面那张实时模型表。 */
export function realtimeCandidates(stored: Pick<StoredDesktopConfig, 'realtimeModelId'>, providers: DirectProviderConfig[], cloudModel: CloudCallModel | null | undefined, signedIn: boolean): Array<{ id: string; name: string; provider: string; source: 'forsion' | 'direct' }> {
  const cloud = cloudModel && (signedIn || stored.realtimeModelId === cloudModel.id) ? cloudModel : null
  return [
    ...(cloud ? [{ id: cloud.id, name: cloud.name, provider: 'forsion', source: 'forsion' as const }] : []),
    ...providers.filter(isDashScope).flatMap((p) => MODELS.map((m) => ({ id: `${p.providerId}/${m}`, name: m, provider: p.providerId, source: 'direct' as const }))),
  ]
}

/**
 * 换通话模型,'' = 关掉。关掉只清模型、不动音色:复刻出来的音色 ID 丢了就得重新花钱复刻。
 * 换模型:系统音色在同一家族里通用,留着;复刻 / 手填的音色绑在原来那个模型上,带过去只会让通话一接通就报「音色不支持」→ 回到默认
 * (复刻的音色没丢:还在账号里,切回原模型时列在音色下拉的「我的音色」里)。音色总是一并写:上一次改音色的保存可能还没落地。
 */
const LAST_MODEL_KEY = 'forsion.realtime.lastModel' // 关掉通话前用的模型:选回同一个时音色(可能是复刻的)照留
export function saveRealtimeModel(next: string, stored: StoredDesktopConfig, cloudModel: CloudCallModel | null | undefined): Promise<StoredDesktopConfig> {
  const voice = stored.realtimeVoice || ''
  let prev = stored.realtimeModelId || ''
  if (!next && prev) try { localStorage.setItem(LAST_MODEL_KEY, prev) } catch { /* ignore */ }
  if (!prev) try { prev = localStorage.getItem(LAST_MODEL_KEY) || '' } catch { /* ignore */ }
  const patch: Partial<StoredDesktopConfig> = next ? { realtimeModelId: next, realtimeVoice: next === prev || presetsFor(next, cloudModel).includes(voice) ? voice : '' } : { realtimeModelId: '' }
  return window.tangu!.setConfig(patch).then((c) => {
    try { localStorage.setItem(REALTIME_CFG_BUMP_KEY, String(Date.now())) } catch { /* ignore */ } // 叫主窗重读(见 useRealtimeConfig)
    return c
  })
}

registerMessages({
  'settings.realtime.title': { zh: '语音通话', en: 'Voice call' },
  'settings.realtime.off': { zh: '已关闭。输入框的发送键不再变成通话键；你的音色都还在。', en: 'Off. The send button stays as send, and your voices are kept.' },
  'settings.realtime.billing': { zh: '走阿里云百炼的实时语音模型（Qwen-Omni / Qwen-Audio），费用由百炼按各模型的价格收取，不同模型差别很大。', en: 'Runs on Alibaba Cloud Bailian realtime voice models (Qwen-Omni / Qwen-Audio). Bailian bills each model at its own rate, and rates differ a lot between models.' },
  'settings.realtime.billingCloud': { zh: '走 Forsion 云端的实时语音模型，不用配密钥；通话用量从你的额度里扣。', en: 'Runs on the Forsion cloud voice model, with no key to set up. Calls use your quota.' },
  'settings.realtime.needProvider': { zh: '需要先在「模型 → 提供方」里添加一个阿里云百炼（DashScope）提供方。', en: 'Add an Alibaba Cloud Bailian (DashScope) provider under Models → Providers first.' },
  'settings.realtime.needProviderOrSignIn': { zh: '登录 Forsion 账号就能直接打；也可以用自己的阿里云百炼连接。', en: 'Sign in to your Forsion account to call right away, or use your own Alibaba Cloud Bailian connection.' },
  'settings.realtime.signIn': { zh: '登录', en: 'Sign in' },
  'settings.realtime.model': { zh: '通话模型', en: 'Call model' },
  'settings.realtime.voice': { zh: '通话音色', en: 'Call voice' },
  'settings.realtime.custom': { zh: '自定义音色 ID', en: 'Custom voice ID' },
  'settings.realtime.customHint': { zh: '填百炼音色 ID，回车保存。', en: 'Bailian voice ID, press Enter to save.' },
  'settings.realtime.mineCloned': { zh: '复刻', en: 'Cloned' },
  'settings.realtime.boundTo': { zh: '绑在 {model}', en: 'Tied to {model}' },
  'settings.realtime.boundNote': { zh: '这个音色绑在 {model} 上，在「默认模型 → 语音通话」换到它才能用。', en: 'This voice is tied to {model}. Switch to it under Default models → Voice call to use it.' },
  'settings.realtime.deleteConfirm': { zh: '删除音色「{name}」？删除后不能恢复。', en: 'Delete the voice "{name}"? This cannot be undone.' },
})

/** 通话音色卡片的显示名:有译名走译名,Qwen-Audio 文档没给说明,只能显示 ID。 */
export const callVoiceName = (t: (k: string) => string, v: string): string => (OMNI_VOICES.includes(v) ? t(`voice.call.${v}.name`) : v)

export function RealtimeVoiceSettings({ stored, providers, onSaved, cloudModel = null, signedIn = false, cloudAccount = false, onOpen }: {
  stored: StoredDesktopConfig
  providers: DirectProviderConfig[]
  onSaved: (c: StoredDesktopConfig) => void
  /** Forsion 云端的通话模型(引擎目录的 realtimeModel);没有 = 云端没开通话 / 没登录。 */
  cloudModel?: CloudCallModel | null
  /** 装了 Forsion Extend 且当前登录有效。 */
  signedIn?: boolean
  /** 装了 Forsion Extend(有登录入口):没有可用模型时给登录按钮。 */
  cloudAccount?: boolean
  /** 下一步:去「模型 → 提供方」加百炼连接 / 去「默认模型 → 语音通话」选模型。 */
  onOpen?: (target: 'providers' | 'call-model') => void
}) {
  const { t, locale } = useI18n()
  const [creating, setCreating] = useState(false)
  const [note, setNote] = useState('')
  const [customId, setCustomId] = useState('')
  const ds = providers.filter(isDashScope)
  const model = effectiveRealtimeModel(stored, { model: cloudModel, signedIn, providers: ds }) // 实际生效的
  const provider = ds.find((p) => model.startsWith(p.providerId + '/'))
  const onCloud = !!cloudModel && model === cloudModel.id
  const voice = stored.realtimeVoice || ''
  const apiModel = provider ? model.slice(provider.providerId.length + 1) : ''
  const presets = presetsFor(model, cloudModel)
  const candidates = realtimeCandidates(stored, providers, cloudModel, signedIn)
  const effectiveVoice = voice || (onCloud ? cloudDefaultVoice(model, cloudModel!) : defaultVoiceFor(model, cloudModel))

  // 账号里的复刻音色:绑在当前模型上的能采用,绑在别的模型上的变灰。连同它属于哪份账号一起存:换提供方 / 换密钥的那一帧不能把上一份列出来。
  const scope = provider ? `${provider.baseUrl}|${provider.apiKey || ''}` : onCloud ? 'cloud' : ''
  const [mineOf, setMineOf] = useState<{ scope: string; direct: TtsVoiceInfo[]; cloud: CloudVoice[]; limit: number }>({ scope: '', direct: [], cloud: [], limit: 5 })
  const [mineKey, setMineKey] = useState(0)
  useEffect(() => {
    if (!scope) return
    let stale = false
    const load = provider
      ? listTtsVoices(homeTarget(), { baseUrl: provider.baseUrl, apiKey: provider.apiKey || '' }).then((direct) => ({ scope, direct: direct || [], cloud: [], limit: 5 }))
      : listCloudVoices(homeTarget()).then((r) => ({ scope, direct: [], cloud: r.voices || [], limit: r.limit || 5 }))
    load.then((v) => { if (!stale) setMineOf(v) }).catch(() => { /* 列不出来就只剩系统音色 */ })
    return () => { stale = true }
  }, [scope, mineKey])
  const mineFor = mineOf.scope === scope ? mineOf : { direct: [] as TtsVoiceInfo[], cloud: [] as CloudVoice[], limit: 5 }

  const save = (patch: Partial<StoredDesktopConfig>): Promise<void> => window.tangu!.setConfig(patch).then((c) => {
    onSaved(c)
    try { localStorage.setItem(REALTIME_CFG_BUMP_KEY, String(Date.now())) } catch { /* ignore */ } // 叫主窗重读(见 useRealtimeConfig)
  })
  const toggle = (on: boolean): void => {
    let last = ''
    try { last = localStorage.getItem(LAST_MODEL_KEY) || '' } catch { /* ignore */ }
    const next = !on ? '' : candidates.some((c) => c.id === last) ? last : candidates[0]?.id || ''
    void saveRealtimeModel(next, stored, cloudModel).then((c) => { onSaved(c); setNote('') })
  }
  const pick = (id: string): void => { setNote(''); void save({ realtimeVoice: id }) }
  const remove = (item: { id: string; name: string }, del: () => Promise<unknown>): void => {
    if (!window.confirm(t('settings.realtime.deleteConfirm', { name: item.name }))) return
    void del().then(() => { setMineKey((k) => k + 1); if (voice === item.id) return save({ realtimeVoice: '' }) }).catch((e: any) => setNote(`✗ ${e?.message || e}`))
  }
  const previewSystem = (v: string): void => { const url = voiceSampleUrl('call', v, locale); if (url) void toggleVoicePreview(`call:${v}`, () => url).catch(() => {}) }
  const previewCloud = (key: string, id: string): void => {
    void toggleVoicePreview(key, () => cloudVoiceSample(homeTarget(), id).then((r) => URL.createObjectURL(new Blob([Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0))], { type: r.mime })))).catch((e: any) => setNote(`✗ ${e?.message || e}`))
  }
  const system: VoiceItem[] = presets.map((v) => ({
    id: v, name: callVoiceName(t, v), desc: OMNI_VOICES.includes(v) ? t(`voice.call.${v}.desc`) : undefined,
    onPreview: voiceSampleUrl('call', v, locale) ? () => previewSystem(v) : undefined,
  }))
  const shortModel = (m: string): string => m.replace(/-realtime.*$/, '')
  const mine: VoiceItem[] = [
    ...mineFor.cloud.map((v): VoiceItem => ({
      id: v.voice, name: v.name || t('settings.realtime.mineCloned'), desc: v.modelId === cloudModel?.id ? t('settings.realtime.mineCloned') : t('settings.realtime.boundTo', { model: shortModel(v.modelId) }), bound: v.modelId !== cloudModel?.id,
      onPreview: v.hasSample ? () => previewCloud(`call:${v.voice}`, v.id) : undefined,
      onDelete: () => remove({ id: v.voice, name: v.name }, () => deleteCloudVoice(homeTarget(), v.id)),
    })),
    ...mineFor.direct.filter((v) => /omni|realtime/i.test(v.targetModel || '')).map((v): VoiceItem => ({
      id: v.voice, name: v.voice, desc: v.targetModel === apiModel ? t('settings.realtime.mineCloned') : t('settings.realtime.boundTo', { model: shortModel(v.targetModel || '') }), bound: v.targetModel !== apiModel,
      onDelete: () => remove({ id: v.voice, name: v.voice }, () => deleteTtsVoice(homeTarget(), { baseUrl: provider!.baseUrl, apiKey: provider!.apiKey || '', voice: v.voice, kind: v.kind })),
    })),
    // 手填过、账号里又列不到的音色也要看得见,不然选中态无处落
    ...(voice && !presets.includes(voice) && !mineFor.cloud.some((v) => v.voice === voice) && !mineFor.direct.some((v) => v.voice === voice) ? [{ id: voice, name: voice }] : []),
  ]
  const pickItem = (item: VoiceItem): void => {
    if (item.bound) { setNote(t('settings.realtime.boundNote', { model: item.desc?.replace(/^.*?(?=qwen)/, '') || '' })); return }
    pick(item.id)
  }
  const canCreate = onCloud ? mine.length < mineFor.limit && /omni/i.test(cloudModel?.apiModelId || '') : !!provider
  const created = (): void => setMineKey((k) => k + 1)
  const use = (v: VoiceCreated): void => { void save({ realtimeVoice: v.voice }); setCreating(false) }

  const on = !!model
  const signInBtn = !candidates.length && cloudAccount
    ? <button type="button" className="btn primary sm realtime-signin" onClick={() => void window.tangu?.forsionLogin?.()}><LogIn size={12} />{t('settings.realtime.signIn')}</button>
    : undefined
  const action = candidates.length
    ? <SettingsSwitch checked={on} label={t('settings.realtime.title')} className="realtime-switch" onChange={toggle} />
    : signInBtn ?? (onOpen ? <button type="button" className="btn ghost sm" onClick={() => onOpen('providers')}>{t('settings.voice.addProvider')}</button> : undefined)
  const desc = on
    ? t(onCloud ? 'settings.realtime.billingCloud' : 'settings.realtime.billing')
    : t(!candidates.length ? (cloudAccount ? 'settings.realtime.needProviderOrSignIn' : 'settings.realtime.needProvider') : 'settings.realtime.off')
  const modelName = onCloud ? `Forsion · ${cloudModel!.name}` : apiModel
  return (
    <SettingsPanel className="settings-voice-call" icon={<Phone size={16} />} title={t('settings.realtime.title')} description={desc} actions={action}>
      {on && (
        <div className="settings-control-list">
          <SettingsRow fit="inline" label={t('settings.realtime.model')} control={
            <button type="button" className="voice-link realtime-model-link" onClick={() => onOpen?.('call-model')}>{modelName}<ChevronRight size={13} /></button>
          } />
        </div>
      )}
      {on && <VoiceGallery title={t('settings.realtime.voice')} system={system} mine={mine} value={effectiveVoice} previewScope="call" onPick={pickItem}
        onNew={canCreate ? () => setCreating(true) : undefined} newHint={t('voicegallery.newCall')} />}
      {on && provider && (
        <div className="settings-control-list">
          <SettingsRow fit="wrap" label={t('settings.realtime.custom')} description={t('settings.realtime.customHint')} control={
            <input type="text" className="realtime-voice-custom" aria-label={t('settings.realtime.custom')} value={customId} onChange={(e) => setCustomId(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && customId.trim()) { pick(customId.trim()); setCustomId('') } }} />
          } />
        </div>
      )}
      {!on && !candidates.length && cloudAccount && <VoiceGallery title={t('settings.realtime.voice')} hint={t('voicegallery.hintListen')} system={system} value="" previewScope="call" />}
      {note && <div className="settings-row-notes"><p className="settings-voice-note" role="status">{note}</p></div>}
      {creating && <VoiceCreateDialog kind="call" cloud={onCloud ? { modelId: cloudModel!.id, modelName: cloudModel!.name, limit: mineFor.limit } : null} provider={provider} targetModel={apiModel || undefined}
        onCreated={created} onUse={use} onClose={() => setCreating(false)} playCloudSample={(id) => previewCloud(`call:new:${id}`, id)} />}
    </SettingsPanel>
  )
}
