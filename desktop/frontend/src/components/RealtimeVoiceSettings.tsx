/**
 * 设置 → 模型 → 语音 →「语音通话」一节(对标 GPT Live):开关 + 通话模型 + 通话音色,可就地复刻自己的声音。
 * 通话模型两种来源:Forsion 云端的实时模型(登录即用,按通话时长从额度里扣),或用户自己的百炼提供方(Qwen-Omni / Qwen-Audio Realtime)。
 * 从没动过这个开关、已登录 Forsion 的用户默认开着、用云端模型(口径在 services/realtimeModel.ts,与输入框同一处)。
 * 开着时输入框空着发送键才变成通话键(Composer2)。
 * 百炼铁律:复刻音色只能配复刻时的 target_model —— 朗读那边的 cosyvoice / qwen3-tts 音色在这里一律不能用,换模型就得重新复刻。
 */
import { useEffect, useRef, useState } from 'react'
import { Loader2, Mic } from 'lucide-react'
import type { DirectProviderConfig, StoredDesktopConfig } from '../types'
import { defaultVoiceFor, effectiveRealtimeModel, isAudioFamily, type CloudCallModel } from '../services/realtimeModel'
import { cloneTtsVoice, listTtsVoices } from '../services/backendService'
import { homeTarget } from '../services/engine/targets'
import { REALTIME_CFG_BUMP_KEY } from '../services/realtimeCall'
import { registerMessages, useI18n } from '../i18n'
import { cloneBusyText, cloneErrorText, VoiceSamplePicker, type VoiceSample } from './VoiceSamplePicker'

// 两个家族:Qwen-Omni 与 Qwen-Audio。会话协议通用(10-04 实测:同一份 session.update、ask_tangu 照样调),
// 差在音色 —— 系统音色各一套、互不相认,复刻音色还绑死在具体型号上。qwen-audio-3.0 两个型号没加:用复刻音色实测不出声。
const MODELS = ['qwen3.8-omni-flash-realtime', 'qwen3.5-omni-plus-realtime', 'qwen3.5-omni-flash-realtime', 'qwen-audio-3.1-realtime-plus']
// 百炼「Qwen-Omni-Realtime 音色列表」里的一部分(全表 36+ 种,可直接手输名字)
const VOICES = ['Tina', 'Cindy', 'Raymond', 'Katerina', 'Ryan', 'Mia', 'Jennifer', 'Aiden']
// qwen-audio-3.1-realtime-plus 认的系统音色(10-04 从接口的报错里抄的全表)。文档没有给名字 / 风格说明,所以只显示 ID,不编描述。
const AUDIO_VOICES = ['longanqian', 'longanlingxin', 'longanlufeng', 'longanlingxi', 'longanxiaoxin', 'longanfengyue', 'longanyuanfei', 'longanhuan_v3.6', 'longjielidou_v3.6',
  'longpaopao_v3.6', 'longhuohuo_v3.6', 'longchuanshu_v3.6', 'loongmary', 'loongeva_v3.6', 'loongjohn', 'daniel', 'echo', 'hannah', 'sherry',
  'longanqian_v3.1', 'longanhuan_v3.1', 'longanlingxin_v3.1', 'longanfengyue_v3.1', 'xunanchuan_v3.1', 'beth_v3.1', 'betty_v3.1', 'cally_v3.1']
const CUSTOM = '__custom__'
const LAST_MODEL_KEY = 'forsion.realtime.lastModel' // 关掉通话前用的模型:再打开时回到它(音色才对得上)

registerMessages({
  'settings.realtime.title': { zh: '语音通话', en: 'Voice call' },
  'settings.realtime.enable': { zh: '启用语音通话', en: 'Turn on voice calls' },
  'settings.realtime.intro': { zh: '像打电话一样和 Agent 对话，随时插话打断；要动手的事（查资料、读写文件、跑任务）交给 Agent 办完再说给你听。开启后，输入框空着时发送键就是通话键。', en: 'Talk to the agent like a phone call and interrupt any time; anything that needs real work (looking things up, files, tasks) is handed to the agent and read back to you. Once on, the send button becomes the call button while the composer is empty.' },
  'settings.realtime.model': { zh: '通话模型', en: 'Call model' },
  'settings.realtime.billing': { zh: '走阿里云百炼的实时语音模型（Qwen-Omni / Qwen-Audio），费用由百炼按各模型的价格收取，不同模型差别很大。', en: 'Runs on Alibaba Cloud Bailian realtime voice models (Qwen-Omni / Qwen-Audio). Bailian bills each model at its own rate, and rates differ a lot between models.' },
  'settings.realtime.billingCloud': { zh: '走 Forsion 云端的实时语音模型，不用自己配密钥；按通话时长从你的额度里扣。', en: 'Runs on the Forsion cloud voice model, with no key to set up. Calls are charged to your quota by call time.' },
  'settings.realtime.cloudOption': { zh: 'Forsion 云端 · {name}', en: 'Forsion cloud · {name}' },
  'settings.realtime.needProvider': { zh: '需要先在「模型 → 提供方」里添加一个阿里云百炼（DashScope）提供方。', en: 'Add an Alibaba Cloud Bailian (DashScope) provider under Models → Providers first.' },
  'settings.realtime.needProviderOrSignIn': { zh: '登录 Forsion 账号就能直接用云端的通话模型；也可以在「模型 → 提供方」里添加自己的阿里云百炼（DashScope）提供方。', en: 'Sign in to your Forsion account to use the cloud call model, or add your own Alibaba Cloud Bailian (DashScope) provider under Models → Providers.' },
  'settings.realtime.voice': { zh: '通话音色', en: 'Call voice' },
  'settings.realtime.voiceHint': { zh: '只用于语音通话，和下面「朗读」的音色互不通用。', en: 'Used only in voice calls; it is not shared with the read-aloud voices below.' },
  'settings.realtime.voiceCustom': { zh: '自定义音色 ID…', en: 'Custom voice ID…' },
  'settings.realtime.voiceMine': { zh: '我的音色 · {id}', en: 'My voice · {id}' },
  'settings.realtime.voiceIdPlaceholder': { zh: '填百炼音色 ID，回车保存', en: 'Bailian voice ID, press Enter to save' },
  'settings.realtime.cloneTitle': { zh: '用自己的声音复刻…', en: 'Clone your own voice…' },
  'settings.realtime.cloneHint': { zh: '照着文案录一段，或选一个 10–20 秒的干净人声录音；复刻成功后自动采用。音色只认复刻时的通话模型：换模型后音色回到默认，之前在那个模型上复刻的会列在上面的下拉里。', en: 'Record the passage, or choose a clean 10–20 second voice recording; the clone is applied as soon as it is ready. A cloned voice only works with the call model it was made for: after switching models the voice goes back to the default, and voices you cloned for that model are listed in the menu above.' },
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

export function RealtimeVoiceSettings({ stored, providers, onSaved, cloudModel = null, signedIn = false, cloudAccount = false }: {
  stored: StoredDesktopConfig
  providers: DirectProviderConfig[]
  onSaved: (c: StoredDesktopConfig) => void
  /** Forsion 云端的通话模型(引擎目录的 realtimeModel);没有 = 云端没开通话 / 没登录。 */
  cloudModel?: CloudCallModel | null
  /** 装了 Forsion Extend 且当前登录有效。 */
  signedIn?: boolean
  /** 装了 Forsion Extend(有登录入口):没有可用模型时的提示里才提「登录」。 */
  cloudAccount?: boolean
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
  // 云端那一项只在登录着时可选;已经选着它(哪怕这会儿没登录)也照列,不然下拉显示不出当前值
  const cloud = cloudModel && (signedIn || stored.realtimeModelId === cloudModel.id) ? cloudModel : null
  const model = effectiveRealtimeModel(stored, { model: cloudModel, signedIn }) // 实际生效的:存了就是存的,从没动过且已登录 = 云端那个
  const onCloud = !!cloud && model === cloud.id
  const provider = ds.find((p) => model.startsWith(p.providerId + '/'))
  const voice = stored.realtimeVoice || ''
  const apiModel = provider ? model.slice(provider.providerId.length + 1) : ''
  const presetsFor = (m: string): string[] => (isAudioFamily(m, cloudModel) ? AUDIO_VOICES : VOICES)
  const presets = presetsFor(model)
  // 账号里绑在当前通话模型上的复刻音色:换模型后从这里挑回来,不用去翻 ID
  // 连同它属于哪个模型一起存:换模型的那一帧不能把上一个模型的音色列出来(列出来就能被选中,一接通就报错)
  const scope = provider && apiModel ? `${model}|${provider.baseUrl}|${provider.apiKey || ''}` : '' // 换提供方 / 换密钥也算换了一份
  const [mineOf, setMineOf] = useState<{ scope: string; voices: string[] }>({ scope: '', voices: [] })
  const mine = scope && mineOf.scope === scope ? mineOf.voices : []
  const [mineKey, setMineKey] = useState(0)
  useEffect(() => {
    if (!provider || !apiModel) return
    let stale = false
    listTtsVoices(homeTarget(), { baseUrl: provider.baseUrl, apiKey: provider.apiKey || '' })
      .then((vs) => { if (!stale) setMineOf({ scope, voices: vs.filter((v) => v.targetModel === apiModel).map((v) => v.voice) }) })
      .catch(() => { /* 列不出来就只剩系统音色和手填 */ })
    return () => { stale = true }
  }, [provider?.providerId, provider?.baseUrl, provider?.apiKey, apiModel, mineKey])
  const save = (patch: Partial<StoredDesktopConfig>) => window.tangu!.setConfig(patch).then((c) => {
    onSaved(c)
    try { localStorage.setItem(REALTIME_CFG_BUMP_KEY, String(Date.now())) } catch { /* ignore */ } // 叫主窗重读(见 useRealtimeConfig)
  })
  // 关掉只清模型、不动音色:复刻出来的音色 ID 丢了就得重新花钱复刻
  const toggle = (): void => {
    if (model) {
      lastModel.current = model
      try { localStorage.setItem(LAST_MODEL_KEY, model) } catch { /* ignore */ }
      void save({ realtimeModelId: '' })
      return
    }
    let remembered = lastModel.current
    if (!remembered) try { remembered = localStorage.getItem(LAST_MODEL_KEY) || '' } catch { /* ignore */ }
    // 记得上次的模型(且它的提供方还在 / 就是云端那个)→ 原样开回来,音色跟它是一对;否则回落到缺省模型,这时留着的音色不一定是它的
    if (remembered && (remembered === cloud?.id || ds.some((p) => remembered.startsWith(p.providerId + '/')))) { void save({ realtimeModelId: remembered }); return }
    const next = cloud ? cloud.id : `${ds[0].providerId}/${MODELS[0]}` // 缺省:有云端用云端(不用配密钥),否则自己的第一个百炼模型
    void save({ realtimeModelId: next, realtimeVoice: presetsFor(next).includes(voice) ? voice : '' })
  }
  // 换模型:系统音色在同一家族里通用,留着;复刻 / 手填的音色绑在原来那个模型上,带过去只会让通话一接通就报「音色不支持」→ 回到默认。
  // 复刻的音色没丢:还在账号里,切回原模型时列在音色下拉的「我的音色」里。
  const pickModel = (next: string): void => {
    setMsg('') // 「已采用复刻音色 …」说的是上一个模型
    void save({ realtimeModelId: next, realtimeVoice: presetsFor(next).includes(voice) ? voice : '' }) // 音色总是一并写:上一次改音色的保存可能还没落地
  }
  const pickVoice = (v: string): void => {
    if (v === CUSTOM) { setCustomId(presets.includes(voice) ? '' : voice); return }
    setCustomId(null)
    void save({ realtimeVoice: v })
  }
  const commitCustom = (): void => {
    if (customId === null) return
    const v = customId.trim()
    setCustomId(null)
    if (v && v !== voice) void save({ realtimeVoice: v }) // 空着离开 = 放弃,别把已选的音色清成默认(Codex 10-02);要默认就在下拉里选第一个
  }

  const doClone = (): void => {
    if (!sample?.ok || !provider || busy) return
    setBusy(true); setMsg(cloneBusyText(sample, t))
    cloneTtsVoice(homeTarget(), { baseUrl: provider.baseUrl, apiKey: provider.apiKey || '', name, audioData: sample.dataUri, targetModel: model.slice(provider.providerId.length + 1), ...sample.script })
      .then((r) => save({ realtimeVoice: r.voice }).then(() => {
        setMsg([t('settings.realtime.cloned', { voice: r.voice }), r.fallbackReason ? t('voicesample.scriptMismatch') : ''].filter(Boolean).join(' '))
        setSample(null); setPickerKey((k) => k + 1); setName(''); setMineKey((k) => k + 1)
      }))
      .catch((e: any) => setMsg(cloneErrorText(e, sample, t)))
      .finally(() => setBusy(false))
  }

  if (!ds.length && !cloud) {
    return (
      <div className="field">
        <label>{t('settings.realtime.title')}</label>
        <div className="hint">{t(cloudAccount ? 'settings.realtime.needProviderOrSignIn' : 'settings.realtime.needProvider')}</div>
      </div>
    )
  }
  return (
    <>
      <div className="field">
        <div className="switch-row" style={{ minHeight: 30 }}>
          <button type="button" role="switch" aria-checked={!!model} aria-label={t('settings.realtime.enable')}
            className={`switch realtime-switch${model ? ' on' : ''}`} disabled={busy} onClick={toggle} />
          <span>{t('settings.realtime.enable')}</span>
        </div>
        <div className="hint" style={{ marginTop: 6 }}>{t('settings.realtime.intro')}</div>
        {model && (
          <>
            <label style={{ marginTop: 12 }}>{t('settings.realtime.model')}</label>
            <select className="realtime-model" aria-label={t('settings.realtime.model')} value={model} disabled={busy} onChange={(e) => pickModel(e.target.value)}>{/* 复刻途中不许换:完成时写进来的音色绑的是原模型 */}
              {cloud && <option value={cloud.id}>{t('settings.realtime.cloudOption', { name: cloud.name })}</option>}
              {ds.flatMap((p) => MODELS.map((m) => (
                <option key={`${p.providerId}/${m}`} value={`${p.providerId}/${m}`}>{ds.length > 1 ? `${p.providerId} · ${m}` : m}</option>
              )))}
              {!provider && !onCloud && <option value={model}>{model}</option>}
            </select>
            <div className="hint">{t(onCloud ? 'settings.realtime.billingCloud' : 'settings.realtime.billing')}</div>
          </>
        )}
      </div>
      {model && (
        <div className="field">
          <label>{t('settings.realtime.voice')}</label>
          <select ref={voiceRef} className="realtime-voice" aria-label={t('settings.realtime.voice')} value={customId !== null ? CUSTOM : voice || defaultVoiceFor(model, cloudModel)} onChange={(e) => pickVoice(e.target.value)}>
            {presets.map((v) => <option key={v} value={v}>{isAudioFamily(model, cloudModel) ? v : `${v} · ${t(`settings.realtime.voice.${v}`)}`}</option>)}
            {[...new Set([...(voice && !presets.includes(voice) ? [voice] : []), ...mine])].map((v) => <option key={v} value={v}>{t('settings.realtime.voiceMine', { id: v })}</option>)}
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
              <button className="btn ghost sm realtime-clone-toggle" style={{ marginTop: 10 }} aria-expanded={cloneOpen} onClick={() => { setCloneOpen((o) => !o); setSample(null) }}>{/* 收起 = 录音区卸载,选好的样本一并作废 */}
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
