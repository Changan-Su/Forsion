import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AudioLines, ChevronRight, Eye, Image as ImageIcon, Info, Languages, MessageCircle, Mic, Phone, RefreshCw, RotateCcw, Sparkles, Volume2 } from 'lucide-react'
import { SettingsPanel, SettingsRow } from './SettingsPrimitives'
import { ModelSelect } from './ModelSelect'
import { catalogByKind, originOf, type CatalogItem, type ModelKind, type ModelOrigin } from './modelKinds'
import { realtimeCandidates, saveRealtimeModel } from './RealtimeVoiceSettings'
import { effectiveRealtimeModel } from '../services/realtimeModel'
import { registerMessages, useI18n } from '../i18n'
import type { DirectProviderConfig, ModelInfo, ModelsResponse, StoredDesktopConfig, VisionMode } from '../types'

/**
 * 设置 → 模型 → 默认模型(10-17 用户定方案 C,方案页 docs/ToBeImproved/模型设置整理方案_2026-10-17/):
 * 每个用途调哪个模型都在这一页,按后台的类型分四张卡(对话 / 图像 / 语音 / 翻译),全部用同一个 ModelSelect。
 * 留空 = 跟随后台的项目默认;选择器标出实际调到的模型从哪来(云端 / 自带 key / 订阅 / 本机),自选的行尾可「恢复跟随」。
 * 朗读、语音通话没有「跟随」,留空 = 未开启。音色、语速等旋钮在「语音」页。
 * 只有本机引擎才有的槽(后台、看图、语音、翻译)在网页 / 手机上不出现(stored 为空)。
 */

registerMessages({
  'dm.panel.chat': { zh: '对话', en: 'Chat' },
  'dm.panel.image': { zh: '图像', en: 'Images' },
  'dm.panel.voice': { zh: '语音', en: 'Voice' },
  'dm.panel.translate': { zh: '翻译', en: 'Translation' },
  'dm.chat': { zh: '聊天与任务', en: 'Chats and tasks' },
  'dm.chatHint': { zh: '新会话和内置 Agent 默认用它。', en: 'New chats and built-in agents use it by default.' },
  'dm.background': { zh: '后台任务', en: 'Background tasks' },
  'dm.backgroundHint': { zh: '后台 Agent、摘要与整理。', en: 'Background agents, summaries and tidying up.' },
  'dm.vision': { zh: '图像识别', en: 'Image recognition' },
  'dm.visionHint': { zh: '主模型看不了图时帮它看。', en: "Looks at images when the main model can't." },
  // 这一行的名字和三个选项的字,被引擎写进了给模型读的一句话里(tangu-agent toolRegistry.computerUseUnavailableReason,live 10-08 调过),
  // 改文案时那边一起改、并重跑 live。所以方案页上的「什么时候用」没采用,沿用原来的说法。
  'aux.visionBehavior': { zh: '图像处理方式', en: 'Image handling' },
  'aux.visionCompact.auto': { zh: '按需使用', en: 'When needed' },
  'aux.visionCompact.always': { zh: '始终使用', en: 'Always' },
  'aux.visionCompact.off': { zh: '直接交给主模型', en: 'Send to main model' },
  'aux.visionModeAutoWarn': {
    zh: '「按需使用」靠一份内置名单判断主模型有没有视觉，名单外的纯文本模型会被当成能看图。图发过去没反应就改选「始终使用」。',
    en: 'When needed relies on a built-in list to tell whether the main model has vision; text-only models outside that list are assumed to have it. If images get ignored, switch to Always.',
  },
  'dm.image': { zh: '图像生成', en: 'Image generation' },
  'dm.imageHint': { zh: '生成和编辑图片。', en: 'Creates and edits images.' },
  'dm.asr': { zh: '语音输入', en: 'Voice input' },
  'dm.asrHint': { zh: '输入框的麦克风键把话转成文字。', en: 'The microphone button in the composer turns speech into text.' },
  'dm.asrLocal': { zh: '本地 SenseVoice', en: 'On-device SenseVoice' },
  'dm.asrLocalHint': { zh: '想离线用，先在「语音」里下载本地模型。', en: 'To use it offline, download the on-device model under Voice first.' },
  'dm.tts': { zh: '朗读', en: 'Read aloud' },
  'dm.ttsHint': { zh: '消息下方的朗读键与自动朗读。', en: 'The read-aloud button under messages and auto read-aloud.' },
  'dm.voiceSpeed': { zh: '音色与语速', en: 'Voice and speed' },
  'dm.voiceDefault': { zh: '默认音色', en: 'Default voice' },
  'dm.call': { zh: '语音通话', en: 'Voice call' },
  'dm.callHint': { zh: '像打电话一样和 Agent 对话。', en: 'Talk to the agent like a phone call.' },
  'dm.translate': { zh: '翻译', en: 'Translation' },
  'dm.translateHint': { zh: '划线菜单、笔记和插件里的翻译。', en: 'Translation in the selection menu, notes and plugins.' },
  'dm.translateChat': { zh: '跟随聊天模型', en: 'Same as chat' },
  'dm.off': { zh: '未开启', en: 'Off' },
  'dm.auto': { zh: '自动', en: 'Auto' },
  'dm.reset': { zh: '恢复跟随', en: 'Use default' },
  'dm.summary': { zh: '{count} 项自选，其余跟随 Forsion 云端默认', en: '{count} custom, the rest use Forsion Cloud defaults' },
  'dm.summaryNone': { zh: '全部跟随 Forsion 云端默认', en: 'All use Forsion Cloud defaults' },
  'dm.resetAll': { zh: '全部恢复跟随', en: 'Reset all to default' },
  'dm.resetDone': { zh: '已恢复 {count} 项', en: 'Reset {count}' },
  'dm.undo': { zh: '撤销', en: 'Undo' },
  'dm.manage': { zh: '在模型库里管理', en: 'Manage in model library' },
  'dm.refresh': { zh: '刷新模型', en: 'Refresh models' },
  'origin.cloud': { zh: '云端', en: 'Cloud' },
  'origin.key': { zh: '自带 key', en: 'Own key' },
  'origin.sub': { zh: '订阅', en: 'Subscription' },
  'origin.local': { zh: '本机', en: 'On device' },
  'origin.mt': { zh: '翻译专用', en: 'Translation' },
})

const LOCAL_ASR = '__local_sensevoice__'
const ORIGIN_COLOR: Record<ModelOrigin, string> = { cloud: 'blue', key: 'purple', sub: 'green', local: 'gray' }

export function OriginTag({ origin, mt }: { origin: ModelOrigin | null; mt?: boolean }) {
  const { t } = useI18n()
  if (!origin) return null
  return <span className="model-tag" data-color={ORIGIN_COLOR[origin]} data-origin={origin}>{t(mt ? 'origin.mt' : `origin.${origin}`)}</span>
}

/** 候选项喂给 ModelSelect 要长成 ModelInfo;朗读 / 通话 / 翻译 / 本地识别这些候选没有 ModelInfo,就地补一个。 */
const asInfo = (c: CatalogItem): ModelInfo => c.model || { id: c.id, name: c.name, provider: c.provider, source: c.source }

type Snapshot = { chat: string; image: string; background: string; vision: string; translate: string; asrBackend: 'local' | 'cloud'; asrModelId: string }

export function DefaultModelsPage(p: {
  models: ModelsResponse | null
  loading: boolean
  onRefresh: () => void
  chatModelId: string
  imageModelId: string
  onChat: (id: string) => void
  onImage: (id: string) => void
  /** 本机引擎的设置(window.tangu.getConfig);网页 / 手机为空 → 只有聊天和生图两行。 */
  stored: StoredDesktopConfig | null
  onStored: (c: StoredDesktopConfig) => void
  providers: DirectProviderConfig[]
  /** OAuth 登录的提供方 id(codex / xai …):它们的模型标「订阅」。 */
  subscriptionIds: string[]
  realtimeSignedIn: boolean
  onOpen: (sub: 'm-display' | 'm-voice', kind?: ModelKind) => void
  children?: ReactNode
}) {
  const { t } = useI18n()
  const { models, stored } = p
  const [localReady, setLocalReady] = useState(false)
  const [undo, setUndo] = useState<{ snap: Snapshot; count: number } | null>(null)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => { void window.tangu?.asrLocalStatus?.().then((s) => setLocalReady(s.ready)) }, [])
  useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current) }, [])

  const directRealtime = stored ? realtimeCandidates(stored, p.providers, models?.realtimeModel, p.realtimeSignedIn).filter((c) => c.source === 'direct') : []
  const cat = catalogByKind(models, directRealtime)
  const llms = cat.llm.map(asInfo)
  const find = (list: CatalogItem[], id: string | null | undefined) => (id ? list.find((c) => c.id === id) : undefined)
  const tag = (list: CatalogItem[], id: string | null | undefined) => <OriginTag origin={originOf(find(list, id), p.subscriptionIds)} mt={list === cat.mt} />
  const save = (patch: Partial<StoredDesktopConfig>) => window.tangu!.setConfig(patch).then(p.onStored)
  const manage = (kind: ModelKind) => ({ label: t('dm.manage'), onClick: () => p.onOpen('m-display', kind) })

  // 一行 = 选择器 + 自选时的「恢复跟随」
  const slot = (o: { value: string; onChange: (id: string) => void; models: ModelInfo[]; icon: ReactNode; label: string; cloudDefaultId?: string | null; defaultLabel?: string; chip?: ReactNode; disabled?: boolean; kind: ModelKind; resettable?: boolean }) => (
    <div className="model-slot">
      <ModelSelect models={o.models} value={o.value} onChange={o.onChange} icon={o.icon} ariaLabel={o.label} cloudDefaultId={o.cloudDefaultId}
        defaultLabel={o.defaultLabel} chip={o.chip} disabled={o.disabled || p.loading} footer={manage(o.kind)} />
      {o.resettable !== false && o.value && <button className="btn ghost sm model-slot-reset" title={t('dm.reset')} aria-label={`${t('dm.reset')} · ${o.label}`} onClick={() => o.onChange('')}><RotateCcw size={13} /></button>}
    </div>
  )

  // ── 各槽当前值 ──
  const snap: Snapshot = {
    chat: p.chatModelId, image: p.imageModelId,
    background: stored?.backgroundModelId || '', vision: stored?.visionModelId || '', translate: stored?.translateModelId || '',
    asrBackend: stored?.asrBackend === 'local' ? 'local' : 'cloud', asrModelId: stored?.asrModelId || '',
  }
  const asrValue = snap.asrBackend === 'local' && localReady ? LOCAL_ASR : snap.asrModelId
  const custom = [snap.chat, snap.image, ...(stored ? [snap.background, snap.vision, snap.translate, asrValue] : [])].filter(Boolean).length
  const restore = (s: Snapshot) => {
    p.onChat(s.chat); p.onImage(s.image)
    if (stored) void save({ backgroundModelId: s.background, visionModelId: s.vision, translateModelId: s.translate, asrBackend: s.asrBackend, asrModelId: s.asrModelId })
  }
  const resetAll = () => {
    restore({ chat: '', image: '', background: '', vision: '', translate: '', asrBackend: 'cloud', asrModelId: '' })
    setUndo({ snap, count: custom })
    if (undoTimer.current) clearTimeout(undoTimer.current)
    undoTimer.current = setTimeout(() => setUndo(null), 8000)
  }

  const visionMode: VisionMode = stored?.visionMode || 'auto'
  const asrModels = [...(localReady ? [{ id: LOCAL_ASR, name: t('dm.asrLocal'), provider: t('origin.local'), source: 'direct' as const }] : []), ...cat.asr.map(asInfo)]
  const ttsValue = stored?.ttsModelId?.trim() || ''
  const ttsList = ttsValue && !find(cat.tts, ttsValue) ? [...cat.tts, { id: ttsValue, name: ttsValue, provider: ttsValue.split('/')[0], source: 'direct' as const }] : cat.tts
  const callValue = stored ? effectiveRealtimeModel(stored, { model: models?.realtimeModel, signedIn: p.realtimeSignedIn }) : ''
  const callList = stored ? realtimeCandidates(stored, p.providers, models?.realtimeModel, p.realtimeSignedIn) : []
  const autoMt = cat.mt[0]?.id
  const translators = [...llms, ...cat.mt.map(asInfo)]
  const followOrValue = (v: string, def?: string | null) => v || def || ''

  return <>
    <div className="model-defaults-summary">
      <Info size={13} />
      <span>{undo ? t('dm.resetDone', { count: undo.count }) : custom ? t('dm.summary', { count: custom }) : t('dm.summaryNone')}</span>
      {undo && <button className="btn ghost sm" onClick={() => { restore(undo.snap); setUndo(null) }}>{t('dm.undo')}</button>}
      <span className="grow" />
      {!undo && custom > 0 && <button className="btn ghost sm" onClick={resetAll}>{t('dm.resetAll')}</button>}
      <button className="btn ghost sm" disabled={p.loading} onClick={p.onRefresh}><RefreshCw size={12} className={p.loading ? 'spin' : ''} />{t('dm.refresh')}</button>
    </div>

    <SettingsPanel className="model-defaults-panel" icon={<MessageCircle size={14} />} title={t('dm.panel.chat')}>
      <SettingsRow label={t('dm.chat')} description={t('dm.chatHint')} control={slot({
        value: snap.chat, onChange: p.onChat, models: llms, icon: <MessageCircle size={13} />, label: t('dm.chat'), kind: 'llm',
        cloudDefaultId: models?.defaultModelId, chip: tag(cat.llm, followOrValue(snap.chat, models?.defaultModelId)),
      })} />
      {stored && <SettingsRow label={t('dm.background')} description={t('dm.backgroundHint')} control={slot({
        value: snap.background, onChange: (id) => void save({ backgroundModelId: id }), models: llms, icon: <Sparkles size={13} />, label: t('dm.background'), kind: 'llm',
        cloudDefaultId: models?.backgroundModelId, chip: tag(cat.llm, followOrValue(snap.background, models?.backgroundModelId)),
      })} />}
    </SettingsPanel>

    <SettingsPanel className="model-defaults-panel" icon={<ImageIcon size={14} />} title={t('dm.panel.image')}>
      {stored && <>
        {/* 图像识别槽只列能看图的:选了个没视觉的进去,主模型无视觉时图先被辅助模型拒、再退给同样看不了的主模型,整轮必挂(Codex 评审) */}
        <SettingsRow label={t('dm.vision')} description={t('dm.visionHint')} control={slot({
          value: snap.vision, onChange: (id) => void save({ visionModelId: id }), models: llms.filter((m) => m.supportsVision !== false), icon: <Eye size={13} />, label: t('dm.vision'), kind: 'llm',
          cloudDefaultId: models?.visionModelId, disabled: visionMode === 'off', chip: tag(cat.llm, followOrValue(snap.vision, models?.visionModelId)),
        })} />
        <SettingsRow className="model-slot-sub" label={t('aux.visionBehavior')} description={visionMode === 'auto' ? t('aux.visionModeAutoWarn') : undefined} control={
          <div className="seg seg-sm" role="group" aria-label={t('aux.visionBehavior')}>
            {(['auto', 'always', 'off'] as VisionMode[]).map((m) => <button key={m} aria-pressed={visionMode === m} className={visionMode === m ? 'active' : ''} onClick={() => void save({ visionMode: m })}>{t(`aux.visionCompact.${m}`)}</button>)}
          </div>
        } />
      </>}
      <SettingsRow label={t('dm.image')} description={t('dm.imageHint')} control={slot({
        value: snap.image, onChange: p.onImage, models: cat.image_gen.map(asInfo), icon: <ImageIcon size={13} />, label: t('dm.image'), kind: 'image_gen',
        cloudDefaultId: models?.imageModelId, chip: tag(cat.image_gen, followOrValue(snap.image, models?.imageModelId)),
      })} />
    </SettingsPanel>

    {stored && <SettingsPanel className="model-defaults-panel" icon={<AudioLines size={14} />} title={t('dm.panel.voice')}>
      {window.tangu?.asrLocalStatus && <SettingsRow label={t('dm.asr')} description={localReady ? t('dm.asrHint') : t('dm.asrLocalHint')} control={slot({
        value: asrValue, models: asrModels, icon: <Mic size={13} />, label: t('dm.asr'), kind: 'asr', cloudDefaultId: models?.asrModelId,
        onChange: (id) => void save(id === LOCAL_ASR ? { asrBackend: 'local' } : { asrBackend: 'cloud', asrModelId: id }),
        chip: asrValue === LOCAL_ASR ? <OriginTag origin="local" /> : tag(cat.asr, followOrValue(asrValue, models?.asrModelId)),
      })} />}
      <SettingsRow anchor="default-tts" label={t('dm.tts')} description={t('dm.ttsHint')} control={slot({
        value: ttsValue, onChange: (id) => void save({ ttsModelId: id }), models: ttsList.map(asInfo), icon: <Volume2 size={13} />, label: t('dm.tts'), kind: 'tts',
        defaultLabel: t('dm.off'), chip: tag(ttsList, ttsValue), resettable: false,
      })} />
      {ttsValue && <SettingsRow className="model-slot-sub" label={t('dm.voiceSpeed')} control={
        <button className="btn ghost sm model-slot-link" onClick={() => p.onOpen('m-voice')}>{stored.ttsVoice || t('dm.voiceDefault')} · {stored.ttsSpeed ?? 1}×<ChevronRight size={12} /></button>
      } />}
      <SettingsRow anchor="default-call" label={t('dm.call')} description={callValue ? t(find(callList, callValue)?.source === 'forsion' ? 'settings.realtime.billingCloud' : 'settings.realtime.billing') : t('dm.callHint')} control={slot({
        value: callValue, models: callList.map(asInfo), icon: <Phone size={13} />, label: t('dm.call'), kind: 'realtime', defaultLabel: t('dm.off'), resettable: false,
        disabled: !callList.length, chip: tag(callList, callValue),
        onChange: (id) => void saveRealtimeModel(id, stored, models?.realtimeModel).then(p.onStored),
      })} />
    </SettingsPanel>}

    {stored && <SettingsPanel className="model-defaults-panel" icon={<Languages size={14} />} title={t('dm.panel.translate')}>
      {/* 没有 app 级的槽可跟:不选 = 目录里第一个机器翻译模型,没有就跟聊天当前模型(tanguProbe.translateModelChoice 同一条规则) */}
      <SettingsRow label={t('dm.translate')} description={t('dm.translateHint')} control={slot({
        value: snap.translate, onChange: (id) => void save({ translateModelId: id }), models: translators, icon: <Languages size={13} />, label: t('dm.translate'), kind: 'mt',
        cloudDefaultId: autoMt, defaultLabel: t(autoMt ? 'dm.auto' : 'dm.translateChat'),
        chip: find(cat.mt, followOrValue(snap.translate, autoMt)) ? tag(cat.mt, followOrValue(snap.translate, autoMt)) : tag(cat.llm, snap.translate),
      })} />
    </SettingsPanel>}

    {p.children}
  </>
}
