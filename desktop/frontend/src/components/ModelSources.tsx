/**
 * 设置 → 模型 → 模型与服务(2026-11-26 方案 C2 + 第一轮 C 的两个弹窗,方案页 docs/ToBeImproved/自定义模型添加与管理方案_2026-11-26/):
 *  - SourceChips:页顶一排「来源」胶囊(Forsion 云端 / 订阅账号 / 每条 API 连接 / 添加连接),带状态点,点开浮层管 Key、检测、删除。
 *    取代原来「提供方」整页;连接名建好后不在这里改(改名 = 另存一条那套语义不再暴露)。
 *  - AddConnectionDialog:服务商胶囊 + Key,粘上自动拉取并检测;下一步交给 AddModelsDialog,选完模型才一起写盘。
 *  - AddModelsDialog:按连接挑模型(缺省「常用」),写回连接的名单。
 * 写盘一律走 window.tangu.saveProvider(整条连接,带原有的全部字段),和旧编辑器同一条路。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ExternalLink, Loader2, LogIn, Plus, RefreshCw, Search, Trash2, X, ChevronRight } from 'lucide-react'
import { OverlayAt } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'
import type { DirectProviderConfig } from '../types'
import type { EngineTarget } from '../services/engine/target'
import { fetchProviderModels, testProviderConnection } from '../services/backendService'
import { PROVIDER_PRESETS, presetProviderId } from './providerPresets'
import { addModels, isCommonModel, LIST_KINDS, modelsIn, mutateProvider, pickKindOf, providerModelCount, readProviderStatus, STATUS_EVENT, writeProviderStatus, type ListKind, type ProviderStatus } from './providerModels'
import { FETCH_ENABLE_LIMIT } from './modelKinds'
import './modelServices.css'

registerMessages({
  'msvc.sources': { zh: '来源', en: 'Sources' },
  'msvc.cloud': { zh: 'Forsion 云端', en: 'Forsion Cloud' },
  'msvc.cloudIn': { zh: '已登录 · {count} 个模型由后台统一配置', en: 'Signed in · {count} models managed by Forsion' },
  'msvc.cloudOut': { zh: '未登录。登录后可以直接用云端的模型，按额度计费。', en: 'Signed out. Sign in to use cloud models, billed by quota.' },
  'msvc.manageAccount': { zh: '管理账号', en: 'Manage account' },
  'msvc.subIn': { zh: '已登录 · 用订阅额度，不计 Forsion 积分', en: 'Signed in · uses your subscription, not Forsion points' },
  'msvc.subOut': { zh: '未登录', en: 'Signed out' },
  'msvc.signIn': { zh: '登录', en: 'Sign in' },
  'msvc.signInAgain': { zh: '重新登录', en: 'Sign in again' },
  'msvc.addConnection': { zh: '添加连接', en: 'Add connection' },
  'msvc.address': { zh: '地址', en: 'Address' },
  'msvc.key': { zh: 'API Key', en: 'API key' },
  'msvc.keySaved': { zh: '已保存 · …{tail}', en: 'Saved · …{tail}' },
  'msvc.keyNone': { zh: '没有 Key（本地端点）', en: 'No key (local endpoint)' },
  'msvc.keyReplace': { zh: '粘贴新的 Key 替换', en: 'Paste a new key to replace' },
  'msvc.models': { zh: '模型', en: 'Models' },
  'msvc.modelCount': { zh: '{n} 个模型 ›', en: '{n} models ›' },
  'msvc.anyModel': { zh: '任意模型名（未登记）', en: 'Any model name (none listed)' },
  'msvc.saveAndTest': { zh: '保存并检测', en: 'Save and test' },
  'msvc.retest': { zh: '重新检测', en: 'Test again' },
  'msvc.delete': { zh: '删除连接', en: 'Delete connection' },
  'msvc.deleteConfirm': { zh: '确认删除', en: 'Confirm delete' },
  'msvc.deleteHint': { zh: '模型菜单里不再出现 {name} 的模型；已有会话保留。', en: '{name} models leave the model menu. Existing chats stay.' },
  'msvc.statusOk': { zh: '已连接 · {when}', en: 'Connected · {when}' },
  'msvc.statusBad': { zh: '连不上：{msg}', en: 'Failed: {msg}' },
  'msvc.statusNone': { zh: '没检测过', en: 'Not tested yet' },
  'msvc.testing': { zh: '检测中…', en: 'Testing…' },
  'msvc.justNow': { zh: '刚刚', en: 'just now' },
  'msvc.minAgo': { zh: '{n} 分钟前', en: '{n} min ago' },
  'msvc.hourAgo': { zh: '{n} 小时前', en: '{n} h ago' },
  'msvc.dayAgo': { zh: '{n} 天前', en: '{n} d ago' },
  'msvc.advanced': { zh: '高级：名称、地址、协议', en: 'Advanced: name, address, protocol' },
  'msvc.pickService': { zh: '选服务商', en: 'Choose a provider' },
  'msvc.custom': { zh: '自定义', en: 'Custom' },
  'msvc.keyFor': { zh: '{name} 的 API Key', en: '{name} API key' },
  'msvc.getKey': { zh: '去 {name} 拿 Key', en: 'Get a key from {name}' },
  'msvc.found': { zh: '已连接 · {n} 个模型可选', en: 'Connected · {n} models available' },
  'msvc.foundNoList': { zh: '已连接 · 这个地址不给模型清单，下一步手动填模型名', en: 'Connected · this endpoint has no model list; enter model names next' },
  'msvc.listOnly': { zh: '拉到 {n} 个模型，但用这个 Key 调用失败：{msg}', en: 'Found {n} models, but a call with this key failed: {msg}' },
  'msvc.next': { zh: '下一步：选模型', en: 'Next: choose models' },
  'msvc.nextAnyway': { zh: '仍然下一步', en: 'Continue anyway' },
  'msvc.cancel': { zh: '取消', en: 'Cancel' },
  'msvc.nameTaken': { zh: '这个名称已经有连接了', en: 'A connection already uses this name' },
  'msvc.addModels': { zh: '添加模型', en: 'Add models' },
  'msvc.searchModels': { zh: '搜索模型…', en: 'Search models…' },
  'msvc.f.common': { zh: '常用', en: 'Popular' },
  'msvc.f.llm': { zh: '对话', en: 'Chat' },
  'msvc.f.image': { zh: '图像', en: 'Image' },
  'msvc.f.voice': { zh: '语音', en: 'Voice' },
  'msvc.f.all': { zh: '全部', en: 'All' },
  'msvc.kind.llm': { zh: '对话', en: 'Chat' },
  'msvc.kind.image': { zh: '图像生成', en: 'Image generation' },
  'msvc.kind.tts': { zh: '朗读', en: 'Read aloud' },
  'msvc.kind.asr': { zh: '语音识别', en: 'Speech recognition' },
  'msvc.kind.off': { zh: '不支持', en: 'Not supported' },
  'msvc.added': { zh: '已添加', en: 'Added' },
  'msvc.kindHint': { zh: '类型按名字认，添加后可在 ⋯ 里改', en: 'Types are guessed from names; change them later under ⋯' },
  'msvc.manual': { zh: '手动填模型名', en: 'Enter a model name' },
  'msvc.manualAdd': { zh: '加入', en: 'Add' },
  'msvc.noService': { zh: '没有想要的服务？添加连接…', en: 'Need another service? Add a connection…' },
  'msvc.picked': { zh: '已选 {n} 个', en: '{n} selected' },
  'msvc.addN': { zh: '添加 {n} 个', en: 'Add {n}' },
  'msvc.saveConnOnly': { zh: '只保存连接', en: 'Save connection only' },
  'msvc.loading': { zh: '正在拉取模型清单…', en: 'Fetching the model list…' },
  'msvc.fetchFailed': { zh: '拉不到模型清单：{msg}。可以手动填模型名。', en: 'Couldn’t fetch the model list: {msg}. You can enter model names.' },
  'msvc.emptyFilter': { zh: '没有符合的模型', en: 'No matching models' },
  'msvc.noConnections': { zh: '还没有自带 Key 的连接。', en: 'No connections with your own key yet.' },
  'msvc.saveFailed': { zh: '保存失败：{msg}', en: 'Couldn’t save: {msg}' },
})

const hostOf = (url: string): string => { try { const u = new URL(url); return `${u.host}${u.pathname.replace(/\/+$/, '')}` } catch { return url } }
const errText = (e: unknown): string => String((e as { message?: string })?.message || e)

export function statusAge(at: number, t: (k: string, v?: Record<string, unknown>) => string, now = Date.now()): string {
  const min = Math.floor((now - at) / 60000)
  if (min < 1) return t('msvc.justNow')
  if (min < 60) return t('msvc.minAgo', { n: min })
  const h = Math.floor(min / 60)
  return h < 24 ? t('msvc.hourAgo', { n: h }) : t('msvc.dayAgo', { n: Math.floor(h / 24) })
}

/** 检测一条连接:拿已登记的第一个对话模型去调一次(没有就只验地址)。结果记进本机状态。 */
async function testConnection(target: EngineTarget, cp: Pick<DirectProviderConfig, 'providerId' | 'baseUrl' | 'apiKey' | 'protocol' | 'modelIds'>, modelId?: string): Promise<ProviderStatus> {
  try {
    const r = await testProviderConnection(target, { baseUrl: cp.baseUrl, apiKey: cp.apiKey || undefined, protocol: cp.protocol, modelId: modelId || cp.modelIds?.[0] })
    const st = { ok: r.success, at: Date.now(), ...(r.success ? {} : { message: r.message }) }
    if (cp.providerId) writeProviderStatus(cp.providerId, st)
    return st
  } catch (e) {
    const st = { ok: false, at: Date.now(), message: errText(e) }
    if (cp.providerId) writeProviderStatus(cp.providerId, st)
    return st
  }
}

// ── 锚定浮层(同 CapabilityMenu 的定位与关闭规则,内容是表单) ──

function Popover({ anchor, onClose, children, label }: { anchor: HTMLElement; onClose: () => void; children: React.ReactNode; label: string }) {
  const box = useRef<HTMLDivElement | null>(null)
  const rectOf = () => { const r = anchor.getBoundingClientRect(); return { x: r.left, y: r.bottom + 6, top: r.top } }
  const [at, setAt] = useState(rectOf)
  useEffect(() => {
    const down = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose() }
    const move = (e: Event) => {
      if (box.current?.contains(e.target as Node)) return
      if (!anchor.isConnected) { onClose(); return }
      const next = rectOf()
      if (Math.abs(next.x - at.x) > 1 || Math.abs(next.y - at.y) > 1) setAt(next)
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); anchor.focus() } }
    document.addEventListener('pointerdown', down)
    document.addEventListener('scroll', move, true)
    window.addEventListener('resize', move)
    document.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('scroll', move, true); window.removeEventListener('resize', move); document.removeEventListener('keydown', key, true) }
  })
  return createPortal(<div className="ui-popover-backdrop" style={{ pointerEvents: 'none' }}>
    <OverlayAt style={{ pointerEvents: 'auto' }} x={at.x} y={at.y} anchorTop={at.top} innerRef={(el) => { box.current = el }}
      className="ui-popover msvc-pop" role="dialog" aria-label={label}>{children}</OverlayAt>
  </div>, document.body)
}

// ── 来源胶囊 ──

export interface SourceChipsProps {
  target: EngineTarget
  providers: DirectProviderConfig[]
  onProviders: (list: DirectProviderConfig[]) => void
  cloud: { signedIn: boolean; count: number } | null
  onManageCloud: () => void
  subs: Array<{ id: string; loggedIn: boolean }>
  subBusy: string | null
  onSubLogin: (id: string) => void
  onAddConnection: () => void
  /** 浮层里点「N 个模型」:模型清单只看这条连接。 */
  onShowModels: (providerId: string) => void
  subscriptionIds: string[]
}

type ChipKey = 'cloud' | `sub:${string}` | `conn:${string}`

export function SourceChips(p: SourceChipsProps) {
  const { t } = useI18n()
  const [status, setStatus] = useState<Record<string, ProviderStatus>>(readProviderStatus)
  const [open, setOpen] = useState<{ key: ChipKey; el: HTMLElement } | null>(null)
  useEffect(() => {
    const reread = () => setStatus(readProviderStatus())
    window.addEventListener(STATUS_EVENT, reread)
    return () => window.removeEventListener(STATUS_EVENT, reread)
  }, [])
  const toggle = (key: ChipKey) => (e: React.MouseEvent<HTMLButtonElement>) => {
    const el = e.currentTarget
    setOpen((cur) => (cur?.key === key ? null : { key, el }))
  }
  // 订阅账号(OAuth 登录的提供方)也会以直连连接的形式出现在 providers 里:胶囊只画一份 —— 登录着画成订阅;
  // 没登录而同名的是一条 API Key 连接(如 xAI 预设缺省叫 xai)时画成连接,否则它的 Key / 地址 / 删除就没处管了(评审 P2)
  const subIn = new Set(p.subs.filter((s) => s.loggedIn).map((s) => s.id))
  const conns = p.providers.filter((cp) => subIn.has(cp.providerId) ? false : !p.subscriptionIds.includes(cp.providerId) || !!cp.apiKey)
  const connIds = new Set(conns.map((cp) => cp.providerId))
  const subs = p.subs.filter((s) => !connIds.has(s.id))
  const dot = (st: ProviderStatus | undefined) => <span className={`msvc-dot${st ? (st.ok ? ' is-ok' : ' is-bad') : ''}`} aria-hidden="true" />
  return <div className="msvc-sources" data-setting-anchor="model-sources">
    <span className="msvc-sources-label">{t('msvc.sources')}</span>
    {p.cloud && <button type="button" className="msvc-chip" aria-expanded={open?.key === 'cloud'} onClick={toggle('cloud')}>
      <span className={`msvc-dot${p.cloud.signedIn ? ' is-ok' : ''}`} aria-hidden="true" />{t('msvc.cloud')}</button>}
    {subs.map((s) => <button key={s.id} type="button" className="msvc-chip" aria-expanded={open?.key === `sub:${s.id}`} onClick={toggle(`sub:${s.id}`)}>
      <span className={`msvc-dot${s.loggedIn ? ' is-ok' : ''}`} aria-hidden="true" />{s.id}</button>)}
    {conns.map((cp) => <button key={cp.providerId} type="button" className="msvc-chip" data-provider={cp.providerId} aria-expanded={open?.key === `conn:${cp.providerId}`} onClick={toggle(`conn:${cp.providerId}`)}>
      {dot(status[cp.providerId])}{cp.providerId}</button>)}
    <button type="button" className="msvc-chip msvc-chip-add" onClick={() => { setOpen(null); p.onAddConnection() }}><Plus size={12} aria-hidden="true" />{t('msvc.addConnection')}</button>
    {open && <Popover anchor={open.el} onClose={() => setOpen(null)} label={open.key === 'cloud' ? t('msvc.cloud') : open.key.slice(open.key.indexOf(':') + 1)}>
      {open.key === 'cloud' && p.cloud && <div className="msvc-pop-body">
        <div className="msvc-pop-head"><span className={`msvc-dot${p.cloud.signedIn ? ' is-ok' : ''}`} />{t('msvc.cloud')}</div>
        <p className="msvc-pop-note">{p.cloud.signedIn ? t('msvc.cloudIn', { count: p.cloud.count }) : t('msvc.cloudOut')}</p>
        <div className="msvc-pop-foot"><button type="button" className="btn ghost sm" onClick={() => { setOpen(null); p.onManageCloud() }}>{t('msvc.manageAccount')}</button></div>
      </div>}
      {open.key.startsWith('sub:') && (() => {
        const s = p.subs.find((x) => `sub:${x.id}` === open.key)
        if (!s) return null
        return <div className="msvc-pop-body">
          <div className="msvc-pop-head"><span className={`msvc-dot${s.loggedIn ? ' is-ok' : ''}`} />{s.id}</div>
          <p className="msvc-pop-note">{s.loggedIn ? t('msvc.subIn') : t('msvc.subOut')}</p>
          <div className="msvc-pop-foot"><button type="button" className="btn ghost sm" disabled={p.subBusy === s.id} onClick={() => p.onSubLogin(s.id)}>
            {p.subBusy === s.id ? <Loader2 size={12} className="spin" /> : <LogIn size={12} />}{t(s.loggedIn ? 'msvc.signInAgain' : 'msvc.signIn')}</button></div>
        </div>
      })()}
      {open.key.startsWith('conn:') && (() => {
        const cp = p.providers.find((x) => `conn:${x.providerId}` === open.key)
        return cp ? <ConnectionPanel key={cp.providerId} cp={cp} target={p.target} status={status[cp.providerId]}
          onStatus={(st) => setStatus((cur) => ({ ...cur, [cp.providerId]: st }))}
          onSaved={(list) => p.onProviders(list)}
          onDeleted={(list) => { setOpen(null); writeProviderStatus(cp.providerId, null); setStatus(readProviderStatus()); p.onProviders(list) }}
          onShowModels={() => { setOpen(null); p.onShowModels(cp.providerId) }} /> : null
      })()}
    </Popover>}
  </div>
}

function ConnectionPanel({ cp, target, status, onStatus, onSaved, onDeleted, onShowModels }: {
  cp: DirectProviderConfig; target: EngineTarget; status?: ProviderStatus
  onStatus: (st: ProviderStatus) => void; onSaved: (list: DirectProviderConfig[]) => void; onDeleted: (list: DirectProviderConfig[]) => void; onShowModels: () => void
}) {
  const { t } = useI18n()
  const [key, setKey] = useState('')
  const [adv, setAdv] = useState(false)
  const [url, setUrl] = useState(cp.baseUrl)
  const [protocol, setProtocol] = useState(cp.protocol || 'openai')
  const [busy, setBusy] = useState<'save' | 'test' | 'delete' | null>(null)
  const [confirmDel, setConfirmDel] = useState(false)
  const [msg, setMsg] = useState('')
  const n = providerModelCount(cp)
  // 导入的 openai-responses 等连接不画协议选择,原样留住
  const protocolEditable = !cp.protocol || cp.protocol === 'openai' || cp.protocol === 'anthropic-messages'
  const dirty = !!key.trim() || url.trim().replace(/\/+$/, '') !== cp.baseUrl || (protocolEditable && protocol !== (cp.protocol || 'openai'))
  const run = async (save: boolean) => {
    setBusy(save ? 'save' : 'test'); setMsg('')
    try {
      let next = cp
      if (save && dirty) {
        const patch = { baseUrl: url.trim().replace(/\/+$/, ''), ...(key.trim() ? { apiKey: key.trim() } : {}), ...(protocolEditable ? { protocol: protocol as 'openai' | 'anthropic-messages' } : {}) }
        const list = await mutateProvider(cp.providerId, (cur) => ({ ...cur, ...patch }))
        next = list.find((x) => x.providerId === cp.providerId) ?? { ...cp, ...patch }
        setKey('')
        onSaved(list)
      }
      onStatus(await testConnection(target, next))
    } catch (e) { setMsg(t('msvc.saveFailed', { msg: errText(e) })) } finally { setBusy(null) }
  }
  const del = async () => {
    if (!confirmDel) { setConfirmDel(true); return }
    setBusy('delete')
    try { onDeleted(await window.tangu!.deleteProvider!(cp.providerId)) } catch (e) { setMsg(t('msvc.saveFailed', { msg: errText(e) })); setBusy(null) }
  }
  const statusLine = busy === 'test' || busy === 'save'
    ? <span className="msvc-stat"><Loader2 size={12} className="spin" />{t('msvc.testing')}</span>
    : status ? <span className={`msvc-stat ${status.ok ? 'is-ok' : 'is-bad'}`} title={status.message}>{status.ok ? t('msvc.statusOk', { when: statusAge(status.at, t) }) : t('msvc.statusBad', { msg: (status.message || '').slice(0, 60) })}</span>
      : <span className="msvc-stat">{t('msvc.statusNone')}</span>
  return <div className="msvc-pop-body" data-connection={cp.providerId}>
    <div className="msvc-pop-head"><span className={`msvc-dot${status ? (status.ok ? ' is-ok' : ' is-bad') : ''}`} />{cp.providerId}</div>
    <div className="msvc-pop-status">{statusLine}</div>
    <div className="msvc-pop-row"><span>{t('msvc.address')}</span><span className="msvc-pop-v" title={cp.baseUrl}>{hostOf(cp.baseUrl)}</span></div>
    <div className="msvc-pop-row"><span>{t('msvc.key')}</span>
      <input type="password" autoComplete="off" value={key} placeholder={cp.apiKey ? t('msvc.keySaved', { tail: cp.apiKey.slice(-4) }) : t('msvc.keyNone')} aria-label={t('msvc.keyReplace')} onChange={(e) => setKey(e.target.value)} /></div>
    <div className="msvc-pop-row"><span>{t('msvc.models')}</span>
      {n ? <button type="button" className="msvc-link" onClick={onShowModels}>{t('msvc.modelCount', { n })}</button> : <span className="msvc-pop-v">{t('msvc.anyModel')}</span>}</div>
    <button type="button" className="msvc-adv" aria-expanded={adv} onClick={() => setAdv((a) => !a)}><ChevronRight size={13} data-motion="chevron" data-open={adv} aria-hidden="true" />{t('msvc.advanced')}</button>
    {adv && <div className="msvc-adv-fields">
      <label><span>{t('msvc.address')}</span><input value={url} onChange={(e) => setUrl(e.target.value)} /></label>
      {protocolEditable && <label><span>{t('prov.protocol')}</span><select value={protocol} onChange={(e) => setProtocol(e.target.value as 'openai' | 'anthropic-messages')}>
        <option value="openai">{t('prov.protocol.openai')}</option><option value="anthropic-messages">{t('prov.protocol.anthropic-messages')}</option></select></label>}
    </div>}
    {msg && <p className="msvc-pop-note is-bad" role="alert">{msg}</p>}
    {confirmDel && <p className="msvc-pop-note">{t('msvc.deleteHint', { name: cp.providerId })}</p>}
    <div className="msvc-pop-foot">
      {dirty
        ? <button type="button" className="btn primary sm" disabled={!!busy || !url.trim()} onClick={() => void run(true)}>{busy === 'save' && <Loader2 size={12} className="spin" />}{t('msvc.saveAndTest')}</button>
        : <button type="button" className="btn ghost sm" disabled={!!busy} onClick={() => void run(false)}><RefreshCw size={12} className={busy === 'test' ? 'spin' : ''} />{t('msvc.retest')}</button>}
      <span className="grow" />
      <button type="button" className={`btn ghost sm${confirmDel ? ' msvc-danger' : ''}`} disabled={!!busy} onClick={() => void del()} onBlur={() => setConfirmDel(false)}>
        {busy === 'delete' ? <Loader2 size={12} className="spin" /> : <Trash2 size={12} />}{t(confirmDel ? 'msvc.deleteConfirm' : 'msvc.delete')}</button>
    </div>
  </div>
}

// ── 弹窗外壳 ──

function Dialog({ title, size, onClose, children, foot, busy }: { title: string; size: 'sm' | 'md'; onClose: () => void; children: React.ReactNode; foot: React.ReactNode; busy?: boolean }) {
  const { t } = useI18n()
  return createPortal(
    <div className="u-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className={`modal modal-${size} msvc-dialog`} role="dialog" aria-modal="true" aria-label={title}
        onKeyDown={(e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose() } }}>
        <div className="modal-head"><span className="grow">{title}</span>
          <button type="button" className="icon-btn" aria-label={t('msvc.cancel')} onClick={onClose} disabled={busy}><X size={15} /></button></div>
        <div className="msvc-dialog-body">{children}</div>
        <div className="msvc-dialog-foot">{foot}</div>
      </div>
    </div>, document.body)
}

// ── 添加连接 ──

/** fetched:undefined = 还没拉过(检测没跑完就点了下一步,添加模型弹窗自己拉);null = 拉失败。 */
export interface ConnectionDraft { cp: DirectProviderConfig; fetched?: string[] | null; fetchError?: string }

export function AddConnectionDialog({ target, providers, onClose, onNext }: {
  target: EngineTarget; providers: DirectProviderConfig[]; onClose: () => void; onNext: (draft: ConnectionDraft) => void
}) {
  const { t } = useI18n()
  const [preset, setPreset] = useState('openai')
  const chosen = PROVIDER_PRESETS.find((x) => x.id === preset)
  const custom = !chosen
  const [adv, setAdv] = useState(false)
  const [pidInput, setPidInput] = useState<string | null>(null)
  const [urlInput, setUrlInput] = useState<string | null>(null)
  const [protoInput, setProtoInput] = useState<'openai' | 'anthropic-messages' | null>(null)
  const [key, setKey] = useState('')
  const pid = (pidInput ?? (chosen ? presetProviderId(chosen.id, providers) : '')).trim()
  const url = (urlInput ?? chosen?.baseUrl ?? '').trim().replace(/\/+$/, '')
  const protocol = protoInput ?? chosen?.protocol ?? 'openai'
  const name = chosen ? chosen.name || t(`prov.preset.${chosen.id}`) : ''
  const taken = providers.some((x) => x.providerId === pid)
  // 检测:拉清单 + 拿一个模型试调。按 (url, key, protocol) 记一份,改了就作废
  const [probe, setProbe] = useState<{ sig: string; state: 'busy' | 'ok' | 'bad'; fetched: string[] | null; message?: string } | null>(null)
  const sig = `${url}\n${key}\n${protocol}`
  const seq = useRef(0)
  const check = async () => {
    if (!url) return
    const my = ++seq.current
    setProbe({ sig, state: 'busy', fetched: null })
    let fetched: string[] | null = null, fetchError = ''
    try { fetched = (await fetchProviderModels(target, { baseUrl: url, apiKey: key || undefined, protocol })).map((m) => m.id) } catch (e) { fetchError = errText(e) }
    if (my !== seq.current) return
    const tryModel = fetched?.find(isCommonModel) || fetched?.find((id) => pickKindOf(id) === 'llm')
    const st = await testConnection(target, { providerId: '', baseUrl: url, apiKey: key || undefined, protocol }, tryModel)
    if (my !== seq.current) return
    setProbe({ sig, state: st.ok ? 'ok' : 'bad', fetched, message: st.ok ? undefined : (st.message || fetchError) })
  }
  // 粘上 Key 停一会儿自动检测(本地端点没有 Key:自定义里填好地址后点「检测」或直接下一步)
  useEffect(() => {
    if (!key.trim() || !url) return
    const timer = window.setTimeout(() => void check(), 700)
    // 输入变了 / 弹窗关了:在途的那次作废,不再接着发试调(评审 P3)
    return () => { window.clearTimeout(timer); seq.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])
  const current = probe?.sig === sig ? probe : null
  const openKey = (href: string) => { if (window.tangu?.openExternal) void window.tangu.openExternal(href); else window.open(href, '_blank', 'noopener') }
  const next = () => {
    const cp: DirectProviderConfig = { providerId: pid, baseUrl: url, ...(key.trim() ? { apiKey: key.trim() } : {}), ...(protocol !== 'openai' ? { protocol } : {}) }
    if (current?.state === 'ok' || current?.state === 'bad') writeProviderStatus(pid, { ok: current.state === 'ok', at: Date.now(), ...(current.message ? { message: current.message } : {}) })
    onNext({ cp, fetched: current && current.state !== 'busy' ? current.fetched : undefined })
  }
  const canNext = !!pid && !!url && !taken && current?.state !== 'busy' && (custom || !!key.trim())
  const statusLine = !current ? null
    : current.state === 'busy' ? <span className="msvc-stat"><Loader2 size={12} className="spin" />{t('msvc.testing')}</span>
      : current.state === 'ok' ? <span className="msvc-stat is-ok"><Check size={13} />{current.fetched?.length ? t('msvc.found', { n: current.fetched.length }) : t('msvc.foundNoList')}</span>
        : <span className="msvc-stat is-bad" title={current.message}>{current.fetched?.length ? t('msvc.listOnly', { n: current.fetched.length, msg: (current.message || '').slice(0, 80) }) : t('msvc.statusBad', { msg: (current.message || '').slice(0, 80) })}</span>
  const field = (label: string, input: React.ReactNode) => <label className="msvc-field"><span>{label}</span>{input}</label>
  const fields = <>
    {field(t('prov.name'), <input value={pid} placeholder={t('settings.customProvider.idPlaceholder')} onChange={(e) => setPidInput(e.target.value.trim())} />)}
    {taken && <p className="msvc-pop-note is-bad">{t('msvc.nameTaken')}</p>}
    {field('Base URL', <input value={urlInput ?? chosen?.baseUrl ?? ''} placeholder={t('settings.customProvider.baseUrlPlaceholder')} onChange={(e) => setUrlInput(e.target.value)} />)}
    {field(t('prov.protocol'), <select value={protocol} onChange={(e) => setProtoInput(e.target.value as 'openai' | 'anthropic-messages')}>
      <option value="openai">{t('prov.protocol.openai')}</option><option value="anthropic-messages">{t('prov.protocol.anthropic-messages')}</option></select>)}
  </>
  return <Dialog title={t('msvc.addConnection')} size="sm" onClose={onClose} foot={<>
    <span className="grow" />
    <button type="button" className="btn ghost sm" onClick={onClose}>{t('msvc.cancel')}</button>
    {custom && !current && <button type="button" className="btn ghost sm" disabled={!url} onClick={() => void check()}><RefreshCw size={12} />{t('msvc.retest')}</button>}
    <button type="button" className="btn primary sm" disabled={!canNext} onClick={next}>{t(current?.state === 'bad' ? 'msvc.nextAnyway' : 'msvc.next')}</button>
  </>}>
    <span className="msvc-label">{t('msvc.pickService')}</span>
    <div className="msvc-pick" role="group" aria-label={t('msvc.pickService')}>
      {PROVIDER_PRESETS.map((x) => <button key={x.id} type="button" className="msvc-chip" aria-pressed={preset === x.id}
        onClick={() => { if (x.id !== preset) setKey(''); setPreset(x.id); setPidInput(null); setUrlInput(null); setProtoInput(null) }}>{x.name || t(`prov.preset.${x.id}`)}</button>)}
      <button type="button" className="msvc-chip" aria-pressed={custom} onClick={() => { if (preset) setKey(''); setPreset(''); setPidInput(null); setUrlInput(null); setProtoInput(null); setAdv(true) }}>{t('msvc.custom')}</button>
    </div>
    {field(custom ? t('msvc.key') : t('msvc.keyFor', { name }), <input type="password" autoComplete="off" value={key} placeholder={custom ? '' : 'sk-…'} onChange={(e) => setKey(e.target.value)} autoFocus />)}
    <div className="msvc-inline">{statusLine}<span className="grow" />
      {chosen?.keyUrl && <button type="button" className="msvc-link" onClick={() => openKey(chosen.keyUrl!)}>{t('msvc.getKey', { name })}<ExternalLink size={11} aria-hidden="true" /></button>}</div>
    {custom ? fields : <>
      <button type="button" className="msvc-adv" aria-expanded={adv} onClick={() => setAdv((a) => !a)}><ChevronRight size={13} data-motion="chevron" data-open={adv} aria-hidden="true" />{t('msvc.advanced')}</button>
      {adv && <div className="msvc-adv-fields">{fields}</div>}
    </>}
  </Dialog>
}

// ── 添加模型 ──

type Filter = 'common' | 'llm' | 'image' | 'voice' | 'all'
const inFilter = (id: string, f: Filter): boolean => {
  const k = pickKindOf(id)
  return f === 'all' ? true : f === 'common' ? k !== 'off' && isCommonModel(id) : f === 'voice' ? k === 'tts' || k === 'asr' : k === f
}

export function AddModelsDialog({ target, providers, draft, initialProviderId, onClose, onSaved, onAddConnection }: {
  target: EngineTarget
  providers: DirectProviderConfig[]
  /** 刚在「添加连接」里填好、还没写盘的连接:选完模型和它一起保存。 */
  draft?: ConnectionDraft | null
  initialProviderId?: string | null
  onClose: () => void
  onSaved: (list: DirectProviderConfig[]) => void
  onAddConnection: () => void
}) {
  const { t } = useI18n()
  const sources = useMemo(() => (draft ? [draft.cp, ...providers.filter((x) => x.providerId !== draft.cp.providerId)] : providers), [draft, providers])
  const [src, setSrc] = useState(() => draft?.cp.providerId || initialProviderId || sources[0]?.providerId || '')
  const cp = sources.find((x) => x.providerId === src)
  const [lists, setLists] = useState<Record<string, { state: 'busy' | 'ok' | 'bad'; ids: string[]; message?: string }>>(() =>
    draft && draft.fetched !== undefined ? { [draft.cp.providerId]: { state: draft.fetched ? 'ok' : 'bad', ids: draft.fetched || [], message: draft.fetchError } } : {})
  const [picks, setPicks] = useState<Record<string, string[]>>({})
  const [filter, setFilter] = useState<Filter | null>(null)
  const [query, setQuery] = useState('')
  const [manual, setManual] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!cp || lists[cp.providerId]) return
    const id = cp.providerId
    setLists((cur) => ({ ...cur, [id]: { state: 'busy', ids: [] } }))
    fetchProviderModels(target, { baseUrl: cp.baseUrl, apiKey: cp.apiKey || undefined, protocol: cp.protocol })
      .then((ms) => setLists((cur) => ({ ...cur, [id]: { state: 'ok', ids: ms.map((m) => m.id) } })))
      .catch((e) => setLists((cur) => ({ ...cur, [id]: { state: 'bad', ids: [], message: errText(e) } })))
  }, [cp, lists, target])
  const list = cp ? lists[cp.providerId] : undefined
  const existing = useMemo(() => new Set(cp ? LIST_KINDS.flatMap((k) => modelsIn(cp, k)) : []), [cp])
  // 已登记、但上游清单里没有的(手填过的)也列出来,显示「已添加」
  const all = useMemo(() => [...new Set([...(list?.ids || []), ...(cp ? (picks[cp.providerId] || []) : []), ...existing])], [list, cp, picks, existing])
  const effective: Filter = filter ?? (all.length > FETCH_ENABLE_LIMIT ? 'common' : 'all')
  const q = query.trim().toLowerCase()
  const shown = all.filter((id) => inFilter(id, q ? 'all' : effective) && id.toLowerCase().includes(q))
  const mine = cp ? picks[cp.providerId] || [] : []
  const total = Object.values(picks).reduce((n, ids) => n + ids.length, 0)
  const toggle = (id: string) => { if (!cp) return; const cur = picks[cp.providerId] || []; setPicks({ ...picks, [cp.providerId]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] }) }
  const addManual = () => {
    const id = manual.trim()
    if (!id || !cp) return
    if (!existing.has(id) && !mine.includes(id)) setPicks({ ...picks, [cp.providerId]: [...mine, id] })
    setManual(''); setQuery('')
  }
  const save = async () => {
    setBusy(true); setError('')
    try {
      let latest: DirectProviderConfig[] | null = null
      const ids = new Set(Object.keys(picks).filter((k) => picks[k].length))
      if (draft) ids.add(draft.cp.providerId)
      for (const id of ids) {
        const add = (picks[id] || []).map((m) => ({ id: m, ...(pickKindOf(m) === 'off' ? { kind: 'llm' as ListKind } : {}) }))
        latest = await mutateProvider(id, (cur) => addModels(cur, add), draft?.cp.providerId === id ? draft.cp : undefined)
      }
      if (latest) onSaved(latest)
      onClose()
    } catch (e) { setError(t('msvc.saveFailed', { msg: errText(e) })); setBusy(false) }
  }
  const kindLabel = (id: string) => { const k = pickKindOf(id); return t(`msvc.kind.${k}`) }
  const draftOnly = !!draft && total === 0
  return <Dialog title={t('msvc.addModels')} size="md" onClose={onClose} busy={busy} foot={<>
    <span className="msvc-sub grow">{t('msvc.picked', { n: total })}</span>
    <button type="button" className="btn ghost sm" disabled={busy} onClick={onClose}>{t('msvc.cancel')}</button>
    <button type="button" className="btn primary sm" disabled={busy || (!total && !draft)} onClick={() => void save()}>
      {busy && <Loader2 size={12} className="spin" />}{draftOnly ? t('msvc.saveConnOnly') : t('msvc.addN', { n: total })}</button>
  </>}>
    {!sources.length ? <p className="msvc-sub">{t('msvc.noConnections')}</p> : <>
      <div className="msvc-toolbar">
        <label className="msvc-search"><Search size={12} aria-hidden="true" /><input value={query} placeholder={t('msvc.searchModels')} aria-label={t('msvc.searchModels')} onChange={(e) => setQuery(e.target.value)} /></label>
      </div>
      <div className="msvc-toolbar">
        <div className="seg seg-sm" role="group" aria-label={t('msvc.sources')}>{sources.map((x) => <button key={x.providerId} type="button" aria-pressed={x.providerId === src} className={x.providerId === src ? 'active' : ''}
          onClick={() => { setSrc(x.providerId); setFilter(null) }}>{x.providerId}{lists[x.providerId]?.state === 'ok' ? <span className="model-lib-count">{lists[x.providerId].ids.length}</span> : null}</button>)}</div>
      </div>
      <div className="msvc-toolbar">
        <div className="seg seg-sm" role="group">{(['common', 'llm', 'image', 'voice', 'all'] as Filter[]).map((f) => <button key={f} type="button" aria-pressed={f === effective} className={f === effective ? 'active' : ''} onClick={() => setFilter(f)}>{t(`msvc.f.${f}`)}</button>)}</div>
        <span className="grow" /><span className="msvc-sub">{t('msvc.kindHint')}</span>
      </div>
      <div className="msvc-models" role="list">
        {list?.state === 'busy' && <p className="msvc-sub msvc-models-note"><Loader2 size={12} className="spin" /> {t('msvc.loading')}</p>}
        {list?.state === 'bad' && !all.length && <p className="msvc-sub msvc-models-note">{t('msvc.fetchFailed', { msg: (list.message || '').slice(0, 120) })}</p>}
        {list?.state !== 'busy' && all.length > 0 && !shown.length && <p className="msvc-sub msvc-models-note">{t('msvc.emptyFilter')}</p>}
        {shown.map((id) => {
          const added = existing.has(id)
          const off = pickKindOf(id) === 'off' && !mine.includes(id)
          const on = added || mine.includes(id)
          return <label key={id} role="listitem" className={`msvc-model${added || off ? ' is-disabled' : ''}`}>
            <input type="checkbox" checked={on} disabled={added || off} onChange={() => toggle(id)} />
            <span className="msvc-model-name" title={id}>{id}</span>
            {added ? <span className="msvc-sub">{t('msvc.added')}</span> : <span className="model-tag">{kindLabel(id)}</span>}
          </label>
        })}
      </div>
      <form className="msvc-toolbar" onSubmit={(e) => { e.preventDefault(); addManual() }}>
        <label className="msvc-search"><Plus size={12} aria-hidden="true" /><input value={manual} placeholder={t('msvc.manual')} aria-label={t('msvc.manual')} onChange={(e) => setManual(e.target.value)} /></label>
        <button type="submit" className="btn ghost sm" disabled={!manual.trim()}>{t('msvc.manualAdd')}</button>
      </form>
    </>}
    <button type="button" className="msvc-link msvc-more" onClick={onAddConnection}>{t('msvc.noService')}</button>
    {error && <p className="msvc-pop-note is-bad" role="alert">{error}</p>}
  </Dialog>
}
