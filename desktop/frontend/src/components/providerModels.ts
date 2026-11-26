/**
 * 设置 → 模型 → 模型与服务(2026-11-26 方案 C2,`docs/ToBeImproved/自定义模型添加与管理方案_2026-11-26/r2.html`):
 * 模型库里每一行的 ⋯(改类型 / 能看图 / 移除)与「添加模型」弹窗直接改一条直连连接的四张名单,不再经过逐行下拉的编辑器。
 *
 * 口径:
 *  - 只动被点的那一类的名单,模型在别的类下的归属不碰(同一个 omni 可以既是对话又是识别)。
 *  - modelIds 为空 = 这条连接任意模型名都放行(引擎口径)。所以对话类的最后一个不让「移除」,
 *    否则一次移除会把白名单变成全放行(canDropLlm);改类型放行(只有朗读 / 识别的连接是正当配置)。
 *  - 读不到状态记录 = 不知道(灰点),不当成「通过」也不当成「失败」。
 */
import type { DirectProviderConfig } from '../types'
import { guessProviderModelKind, type ModelKind } from './modelKinds'

/** 直连连接写盘的四类;朗读 / 识别 / 生图 / 对话之外的(通话、翻译、补全)直连没有名单。 */
export type ListKind = 'llm' | 'image' | 'tts' | 'asr'
const FIELD: Record<ListKind, 'modelIds' | 'imageModelIds' | 'ttsModelIds' | 'asrModelIds'> = {
  llm: 'modelIds', image: 'imageModelIds', tts: 'ttsModelIds', asr: 'asrModelIds',
}
export const LIST_KINDS: ListKind[] = ['llm', 'image', 'tts', 'asr']

/** 模型库的类型标签 → 直连名单;没有名单的类返回 null(那几类的行不给改类型 / 移除)。 */
export function listKindOf(kind: ModelKind): ListKind | null {
  return kind === 'llm' ? 'llm' : kind === 'image_gen' ? 'image' : kind === 'tts' ? 'tts' : kind === 'asr' ? 'asr' : null
}

/** 目录里直连模型的 id 是 `<providerId>/<模型名>`;模型名本身也可能带 `/`(openrouter 的 anthropic/claude-…)。 */
export function bareModelId(providerId: string, id: string): string {
  return id.startsWith(`${providerId}/`) ? id.slice(providerId.length + 1) : id
}

export function modelsIn(cp: Partial<DirectProviderConfig>, kind: ListKind): string[] {
  return cp[FIELD[kind]] || []
}

/** 这条连接一共登记了几个模型(四类去重)。 */
export function providerModelCount(cp: Partial<DirectProviderConfig>): number {
  return new Set(LIST_KINDS.flatMap((k) => modelsIn(cp, k))).size
}

const put = (cp: DirectProviderConfig, kind: ListKind, ids: string[]): DirectProviderConfig => {
  const next = { ...cp }
  const uniq = [...new Set(ids)]
  if (uniq.length) next[FIELD[kind]] = uniq
  else delete next[FIELD[kind]]
  return next
}

/** 从对话名单「移除」bare 之后会不会变成「全放行」:名单里只剩它一个时不行(重复写了几遍的同名也算一个)。不在名单里的(空名单下随叫随用的)也不行。 */
export function canDropLlm(cp: Partial<DirectProviderConfig>, bare: string): boolean {
  const ids = new Set(modelsIn(cp, 'llm'))
  return ids.has(bare) && ids.size > 1
}

export function removeModel(cp: DirectProviderConfig, kind: ListKind, bare: string): DirectProviderConfig {
  if (kind === 'llm' && !canDropLlm(cp, bare)) throw new Error('last-llm')
  let next = put(cp, kind, modelsIn(cp, kind).filter((id) => id !== bare))
  if (kind === 'llm') next = setTextOnly(next, bare, false)
  return next
}

/**
 * 改类型 = 从 from 的名单挪到 to 的名单;对话类的「看图」标记跟着对话名单走。
 * 最后一个对话模型也能改走(只有朗读 / 识别的连接是正当配置,旧编辑器同样允许全部不是对话);拦的只是「移除」。
 */
export function changeModelKind(cp: DirectProviderConfig, bare: string, from: ListKind, to: ListKind): DirectProviderConfig {
  if (from === to) return cp
  // 盘上它已经不在 from 下了(连点两次改类型,第一次已写完):不再往 to 里加,免得一个模型挂进两类(评审二轮 P2)
  if (!modelsIn(cp, from).includes(bare)) throw new Error('stale')
  let next = put(cp, from, modelsIn(cp, from).filter((id) => id !== bare))
  next = put(next, to, [...modelsIn(next, to), bare])
  if (from === 'llm') next = setTextOnly(next, bare, false)
  return next
}

/** textOnly = 看不了图(写进 noVisionModelIds 黑名单)。 */
export function setTextOnly(cp: DirectProviderConfig, bare: string, textOnly: boolean): DirectProviderConfig {
  const cur = cp.noVisionModelIds || []
  const ids = textOnly ? [...new Set([...cur, bare])] : cur.filter((id) => id !== bare)
  const next = { ...cp }
  if (ids.length) next.noVisionModelIds = ids
  else delete next.noVisionModelIds
  return next
}

/** 「添加模型」弹窗勾的那些:按名字认类型(认成 off 的 —— 实时 / 翻译 / 向量 —— 直连没有名单,不加)。已在任何一类里的不重复加。 */
export function addModels(cp: DirectProviderConfig, picks: Array<{ id: string; kind?: ListKind }>): DirectProviderConfig {
  const known = new Set(LIST_KINDS.flatMap((k) => modelsIn(cp, k)))
  let next = cp
  for (const p of picks) {
    if (known.has(p.id)) continue
    const guessed = guessProviderModelKind(p.id)
    const kind = p.kind || (guessed === 'off' ? null : guessed)
    if (!kind) continue
    next = put(next, kind, [...modelsIn(next, kind), p.id])
    known.add(p.id)
  }
  return next
}

/** 弹窗筛选用:拉回来的模型名按名字归到哪一类(off = 直连用不了的,列在「全部」里但不能勾)。 */
export function pickKindOf(id: string): ListKind | 'off' {
  return guessProviderModelKind(id)
}

/**
 * 「常用」:主流厂商最近两代的型号,按名字认(和 guessProviderModelKind 一样宁可简单)。聚合网关一拉几百个,
 * 缺省只露这些;连接本身 ≤ 40 个模型时弹窗直接列全部(见 AddModelsDialog)。
 */
const COMMON = [
  /claude-(opus|sonnet|haiku)-[45]/, /(^|\/)gpt-[56]/, /(^|\/)o[45](-mini)?$/, /gemini-[23]/, /deepseek-(v[34]|r[23]|chat|reasoner)/,
  /qwen3/, /qwq/, /kimi-k[23]/, /moonshot-v1/, /glm-[45]/, /grok-[45]/, /doubao-(seed|1\.[56])/, /minimax-m[23]/, /mistral-(large|medium)/,
]
export function isCommonModel(id: string): boolean {
  const bare = id.toLowerCase()
  if (/(:free|:beta|-preview|-exp|-base|-awq|-fp8|-int4)/.test(bare)) return false
  return COMMON.some((re) => re.test(bare))
}

/**
 * 写一条连接:先读盘上最新的那份再改,并且一条一条排队写(评审 P1:两次快速操作都从同一份旧快照算整条记录,后写的会把先写的改动盖回去;
 * 别处同时改了 Key / 地址也会被旧快照盖掉)。读不到这条 = 不写(读失败不当空)。fallback 只给还没写过盘的新连接。
 */
let writeChain: Promise<unknown> = Promise.resolve()
export function mutateProvider(providerId: string, fn: (cur: DirectProviderConfig) => DirectProviderConfig, fallback?: DirectProviderConfig): Promise<DirectProviderConfig[]> {
  const run = writeChain.then(async () => {
    const api = window.tangu
    if (!api?.listProviders || !api.saveProvider) throw new Error('providers api unavailable')
    const list = await api.listProviders()
    const found = list.find((x) => x.providerId === providerId)
    // 带 fallback = 新建:同名的已经有了(别处刚建的)就停,不把这份草稿的模型并进别人的连接、也不丢草稿的地址和 Key(评审二轮 P2)
    if (fallback && found) throw new Error('provider-exists')
    const cur = found ?? fallback
    if (!cur) throw new Error('provider-gone')
    return api.saveProvider(fn(cur))
  })
  writeChain = run.catch(() => undefined)
  return run
}

/** 检测失败的原文可能被网关回显出 Key:存进状态缓存 / 显示前把它遮掉。 */
export function scrubKey(message: string | undefined, key: string | undefined): string | undefined {
  if (!message || !key || key.length < 6) return message
  return message.split(key).join(`…${key.slice(-4)}`)
}

// ── 连接检测状态(本机记一份,只为了状态点;打开页面不自动检测) ──

export interface ProviderStatus { ok: boolean; at: number; message?: string }
const STATUS_KEY = 'forsion.providerStatus.v1'
/** 状态点变了(弹窗里测完写进来):已经画着的来源胶囊据此重读。 */
export const STATUS_EVENT = 'forsion:provider-status'

/** 读失败 / 坏数据 = 空(全部灰点)—— 状态点只是提示,不据此做任何写回。 */
export function readProviderStatus(): Record<string, ProviderStatus> {
  try {
    const raw = JSON.parse(localStorage.getItem(STATUS_KEY) || '{}')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, ProviderStatus> = {}
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      const s = v as Partial<ProviderStatus>
      if (s && typeof s.ok === 'boolean' && typeof s.at === 'number') out[id] = { ok: s.ok, at: s.at, ...(typeof s.message === 'string' ? { message: s.message } : {}) }
    }
    return out
  } catch { return {} }
}

export function writeProviderStatus(id: string, status: ProviderStatus | null): Record<string, ProviderStatus> {
  const all = readProviderStatus()
  if (status) all[id] = status
  else delete all[id]
  try { localStorage.setItem(STATUS_KEY, JSON.stringify(all)) } catch { /* 存不了:这次会话里照样显示 */ }
  try { window.dispatchEvent(new CustomEvent(STATUS_EVENT)) } catch { /* 非浏览器环境 */ }
  return all
}
