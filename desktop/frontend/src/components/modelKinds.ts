import type { DirectProviderConfig, ModelInfo, ModelsResponse } from '../types'

/**
 * 模型的六类,与后台 admin 的 modelType 同名同序(设置 → 模型 → 模型库的标签页就按这个排)。
 * 引擎目录里对话 / 生图 / 识别在 models 里,朗读 / 通话 / 翻译是三个单独字段 —— 这里统一拼成一张表,不改协议。
 */
export type ModelKind = 'llm' | 'image_gen' | 'asr' | 'tts' | 'realtime' | 'mt'
export const MODEL_KINDS: ModelKind[] = ['llm', 'image_gen', 'asr', 'tts', 'realtime', 'mt']

export interface CatalogItem {
  id: string
  name: string
  source: 'forsion' | 'direct'
  /** 直连:连接名;云端:后台的分组名或 provider。 */
  provider: string
  /** 来自 models 的才有(能隐藏、能改窗口);朗读 / 通话 / 翻译的候选没有。 */
  model?: ModelInfo
}

/** 直连的通话候选由调用方给(百炼的实时模型是写死的一张表,见 RealtimeVoiceSettings)。 */
export function catalogByKind(models: ModelsResponse | null, directRealtime: Array<{ id: string; name: string; provider: string }> = []): Record<ModelKind, CatalogItem[]> {
  const list = models?.models || []
  const of = (m: ModelInfo): CatalogItem => ({ id: m.id, name: m.name, source: m.source, provider: m.source === 'forsion' ? m.groupName || m.provider : m.provider, model: m })
  const directTts = (models?.directProviders || []).flatMap((p) => (p.ttsModelIds || []).map((id) => ({ id: `${p.providerId}/${id}`, name: id, source: 'direct' as const, provider: p.providerId })))
  return {
    llm: list.filter((m) => (m.modelType || 'llm') === 'llm').map(of),
    image_gen: list.filter((m) => m.modelType === 'image_gen').map(of),
    asr: list.filter((m) => m.modelType === 'asr').map(of),
    tts: [...(models?.ttsModels || []).map((m) => ({ id: m.id, name: m.name, source: 'forsion' as const, provider: 'forsion' })), ...directTts],
    realtime: [...(models?.realtimeModel ? [{ id: models.realtimeModel.id, name: models.realtimeModel.name, source: 'forsion' as const, provider: 'forsion' }] : []), ...directRealtime.map((m) => ({ ...m, source: 'direct' as const }))],
    mt: (models?.translateModels || []).map((m) => ({ id: m.id, name: m.name, source: 'forsion' as const, provider: m.provider || 'forsion' })),
  }
}

/** 来源标签:云端 / 自带 key / 订阅(OAuth 登录的提供方)/ 本机。 */
export type ModelOrigin = 'cloud' | 'key' | 'sub' | 'local'
export function originOf(item: { source: 'forsion' | 'direct'; provider: string } | undefined, subscriptionIds: readonly string[]): ModelOrigin | null {
  if (!item) return null
  if (item.source === 'forsion') return 'cloud'
  return subscriptionIds.includes(item.provider) ? 'sub' : 'key'
}

// ── 直连连接:拉取到的模型逐行认类型 ──────────────────────────────────────────

/** 直连连接里一个模型当什么用。写盘只有这四类(modelIds / imageModelIds / ttsModelIds / asrModelIds),off = 不写。 */
export type ProviderModelKind = 'llm' | 'image' | 'tts' | 'asr' | 'off'
/** orig = 打开编辑时这一行的类型(拉取新加的没有)。没改过类型的行,保存时连同它在旧配置里的其它归属一起留着。 */
export interface ProviderModelRow { id: string; kind: ProviderModelKind; textOnly: boolean; orig?: ProviderModelKind }

/**
 * 按模型名猜类型。只看最后一个 `/` 之后的裸名。猜错了用户在行上改,所以宁可简单。
 * 实时 / 翻译 / 向量这几类直连连接没有对应的槽(通话走写死的百炼表,翻译专用模型只有云端),猜到就是 off。
 */
export function guessProviderModelKind(id: string): ProviderModelKind {
  const bare = id.slice(id.lastIndexOf('/') + 1).toLowerCase()
  if (/realtime|(^|[-_.])live([-_.]|$)/.test(bare)) return 'off'
  if (/(^|[-_.])(embed|embedding|rerank|reranker|moderation|mt)([-_.]|$)|translat/.test(bare)) return 'off'
  if (/asr|whisper|transcrib|paraformer|sensevoice|(^|[-_.])stt([-_.]|$)/.test(bare)) return 'asr'
  if (/tts|cosyvoice|sambert|(^|[-_.])speech([-_.]|$)/.test(bare)) return 'tts'
  if (/image|t2i|dall-?e|flux|wanx|imagen|seedream|stable-diffusion|sdxl|nano-banana|kolors/.test(bare)) return 'image'
  return 'llm'
}

export function rowsFromProvider(p: Partial<DirectProviderConfig>): ProviderModelRow[] {
  const noVision = new Set(p.noVisionModelIds || [])
  const rows = new Map<string, ProviderModelRow>()
  // 一个模型在旧配置里可能同时挂在几类下(如 omni 既是对话又是识别):行上只显示第一类,其余归属靠 providerFieldsFromRows 的 original 留住
  const add = (ids: string[] | undefined, kind: ProviderModelKind) => { for (const id of ids || []) if (!rows.has(id)) rows.set(id, { id, kind, textOnly: noVision.has(id), orig: kind }) }
  add(p.modelIds, 'llm'); add(p.imageModelIds, 'image'); add(p.ttsModelIds, 'tts'); add(p.asrModelIds, 'asr')
  return [...rows.values()]
}

/** 拉取结果并进现有行:已有的不动;新的按名字猜类型 —— 一次拉回很多(聚合网关动辄几百个)时新对话模型先不用,免得模型菜单被撑爆。 */
export const FETCH_ENABLE_LIMIT = 40
export function mergeFetched(rows: ProviderModelRow[], fetched: string[], noVisionIds: readonly string[] = []): ProviderModelRow[] {
  const known = new Set(rows.map((r) => r.id))
  const fresh = fetched.filter((id) => !known.has(id))
  const many = fetched.length > FETCH_ENABLE_LIMIT
  return [...rows, ...fresh.map((id) => {
    const kind = guessProviderModelKind(id)
    return { id, kind: many && kind === 'llm' ? 'off' as const : kind, textOnly: noVisionIds.includes(id) }
  })]
}

type ProviderModelFields = Pick<DirectProviderConfig, 'modelIds' | 'imageModelIds' | 'ttsModelIds' | 'asrModelIds' | 'noVisionModelIds'>
/**
 * 行 → 写盘字段。空数组写 undefined(modelIds 为空 = 这条连接任意模型名都放行,与旧表单同义)。
 * original = 打开编辑前的配置:行表示不了的旧归属照留 —— 没改过类型的模型在其它类下的归属、没有行的纯文本名单
 * (modelIds 为空时 noVisionModelIds 里的名字不成行,不留就会在只改密钥的保存里被清掉)。
 */
export function providerFieldsFromRows(rows: ProviderModelRow[], original: Partial<DirectProviderConfig> = {}): ProviderModelFields {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const keep = (id: string) => { const r = byId.get(id); return !r || (r.kind !== 'off' && r.kind === r.orig) }
  const ids = (kind: ProviderModelKind, old: string[] | undefined) => {
    const v = [...new Set([...rows.filter((r) => r.kind === kind).map((r) => r.id), ...(old || []).filter(keep)])]
    return v.length ? v : undefined
  }
  const noVision = [...new Set([...rows.filter((r) => r.kind === 'llm' && r.textOnly).map((r) => r.id), ...(original.noVisionModelIds || []).filter((id) => !byId.has(id))])]
  return {
    modelIds: ids('llm', original.modelIds), imageModelIds: ids('image', original.imageModelIds), ttsModelIds: ids('tts', original.ttsModelIds), asrModelIds: ids('asr', original.asrModelIds),
    noVisionModelIds: noVision.length ? noVision : undefined,
  }
}
