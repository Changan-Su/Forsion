/**
 * Muse 的开场建议(新对话页 Chat Box 下最多三行;10-25 用户选方案 A)。渲染层这半 = 一份缓存 + 后台刷新 + × / 用过回写。
 *
 * 新对话页一打开就要画、不等网络:先用上次存的(localStorage),再在后台拉一次(同一分钟内不重复拉)。
 * 「没有」是常态:Muse 关着 / 开场建议关着 / 云端引擎(这条路由本地才有,404)/ 请求失败 —— 一律当空,不提示、不重试。
 * × 先从眼前拿掉再回写引擎(写失败也不放回来:用户已经表达了不想看)。
 * 点一行填进输入框时记下「这份草稿来自哪一条」;这份草稿真的按了发送,才回写 used(Muse 据此知道哪句被采纳)。
 */
import { create } from 'zustand'
import type { MuseStarter } from '../../types'
import { getMuseStarters, patchMuseStarter } from '../../services/backendService'
import { homeTarget } from '../../services/engine/targets'
import { onSend } from './freshLayout'

const CACHE_KEY = 'forsion_muse_starters'
const REFRESH_MS = 60_000

const readCache = (): MuseStarter[] => {
  try {
    const v = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]')
    return Array.isArray(v) ? v.filter((s) => s && typeof s.id === 'string' && typeof s.text === 'string' && s.source && typeof s.source.label === 'string') : []
  } catch { return [] }
}
const writeCache = (list: MuseStarter[]): void => {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(list)) } catch { /* 隐私窗口等:只是下次首屏慢一拍 */ }
}

export const useMuseStarters = create<{ list: MuseStarter[] }>(() => ({ list: readCache() }))

let lastFetch = 0
let inflight: Promise<void> | null = null
/** 后台拉一次(同一分钟内只拉一次;force = 忽略节流)。 */
export function refreshMuseStarters(force = false): Promise<void> {
  if (inflight) return inflight
  if (!force && Date.now() - lastFetch < REFRESH_MS) return Promise.resolve()
  lastFetch = Date.now()
  inflight = getMuseStarters(homeTarget())
    .then((list) => { setList(list.slice(0, 3)) })
    .catch(() => { setList([]) })
    .finally(() => { inflight = null })
  return inflight
}

/** 这次启动里 × 掉 / 用掉的:在途的刷新若带着旧快照回来,不许把它们放回眼前(回写引擎可能还没落地)。 */
const gone = new Set<string>()

function setList(next: MuseStarter[]): void {
  const list = next.filter((s) => !gone.has(s.id))
  const cur = useMuseStarters.getState().list
  const same = cur.length === list.length && cur.every((s, i) => s.id === list[i].id && s.text === list[i].text)
  if (!same) useMuseStarters.setState({ list })
  writeCache(list)
}

/** × / 右键「不感兴趣」「别再推这类」。 */
export function dismissStarter(id: string, mute = false): void {
  gone.add(id)
  setList(useMuseStarters.getState().list.filter((s) => s.id !== id))
  for (const [k, v] of filledBy) if (v === id) filledBy.delete(k)
  void patchMuseStarter(homeTarget(), id, 'dismissed', mute).catch(() => {})
}

/** 草稿 key → 填进来的那条 id(只认最后一次点的那条)。 */
const filledBy = new Map<string, string>()
export function noteStarterFilled(draftKey: string, id: string): void { filledBy.set(draftKey, id) }

/** 那份草稿发出去了(引擎受理):回写 used,并从眼前拿掉(它已经变成一条真对话了)。没发出去的不算。 */
export function consumeStarterOnSend(draftKey: string): void {
  const id = filledBy.get(draftKey)
  if (!id) return
  filledBy.delete(draftKey)
  gone.add(id)
  setList(useMuseStarters.getState().list.filter((s) => s.id !== id))
  void patchMuseStarter(homeTarget(), id, 'used').catch(() => {})
}

/** 把一条拆成「前半 · 链接 · 后半」:只认句子里第一处 label(引擎已保证它在句子里;万一不在,整句当正文)。 */
export function splitStarter(s: Pick<MuseStarter, 'text' | 'source'>): { pre: string; link: string; post: string } {
  const at = s.source.label ? s.text.indexOf(s.source.label) : -1
  if (at < 0) return { pre: s.text, link: '', post: '' }
  return { pre: s.text.slice(0, at), link: s.source.label, post: s.text.slice(at + s.source.label.length) }
}

// 常驻监听,不挂在组件上:新对话发出第一句后行列跟着卸载,受理通知(sent)那时才到。只认受理 —— 没发出去的不算采纳。
if (typeof window !== 'undefined') onSend((d) => { if (d.phase === 'sent') consumeStarterOnSend(d.key) })
