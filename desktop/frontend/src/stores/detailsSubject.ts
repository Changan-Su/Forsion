import { create } from 'zustand'
import { activeMainPanel, useWorkspace } from '@lcl/engine'
import { useApp } from './appStore'

/** 一次性落到某几条记录的令牌(对话里的留痕 / 更新卡点「查看」):at 变了才跳。texts = 那几条的原文(活动流里整串截过 300 字,按包含比);
 *  项目 → 「设置 › 项目记忆」,part: 'compacted' 落在「被合并的原句」;Agent → 「成长 › 进化」。一条都对不上就落在整块。 */
export interface RecordJump { at: number; texts: string[]; part?: 'compacted' }

/** evolution = 一次性跳到 Agent 详情「成长 › 进化」的令牌(对话里的工作笔记更新卡点「查看」);records 再往下落到具体那几条。 */
export type DetailsSubject = ({ kind: 'project'; path: string } | { kind: 'agent'; slug: string }) & { human?: import('../services/humanCollaboration').HumanJump; evolution?: number; records?: RecordJump }

/** 侧栏「查看详情」:右栏 Tangu 详情临时显示这个项目 / Agent,不切当前会话。
 *  `from` = 设下时右栏跟随的主会话;主会话一变(切会话 / 新对话 / 换到钉住别的会话的主标签)就清掉,右栏回到跟随。
 *  清除放在 store 订阅里而不是视图 effect:右栏关着时视图挂载晚于设值,挂载期的 effect 会把刚设的 subject 清掉。 */
export const useDetailsSubject = create<{ subject: (DetailsSubject & { from: string | null }) | null }>(() => ({ subject: null }))

/** 右栏跟随的主会话(同 AgentProfileView 的 useMainSessionId,非 hook 版):主标签钉住了会话就是它,否则是当前会话。 */
export function mainSessionIdNow(): string | null {
  const ws = useWorkspace.getState()
  const panels = ws.api?.panels || []
  const main = ws.api ? activeMainPanel(ws.api) : panels.find((p) => p.id === ws.focusedChatLeafId && p.params?.__loc === 'main')
  const params = main?.params as { followActive?: boolean; sessionId?: unknown } | undefined
  return params?.followActive === false && typeof params.sessionId === 'string' ? params.sessionId : useApp.getState().activeId
}

const expire = (): void => {
  const sub = useDetailsSubject.getState().subject
  if (sub && sub.from !== mainSessionIdNow()) useDetailsSubject.setState({ subject: null })
}
// 第一次「查看详情」时才订阅(subject 只能经 showDetails 设下):模块导入不带副作用,mock 了 store 的测试照常能 import
let watching = false

export function showDetails(subject: DetailsSubject): void {
  if (!watching) { watching = true; useApp.subscribe(expire); useWorkspace.subscribe(expire) }
  useDetailsSubject.setState({ subject: { ...subject, from: mainSessionIdNow() } })
  revealRight(5)
}

/** 展开右栏并激活详情视图。收起补间(~200ms)期间 rightVisible 已是 false、面板却还在:这时 toggle 会被判成「还开着」再收一次
 *  (lcl 已知局限),所以等它收完再展开。收起态的视图在 stash 里:先 toggle 恢复那一份再激活,直接 openView 会另开一份。 */
function revealRight(retries: number): void {
  const ws = useWorkspace.getState()
  const closing = !ws.rightVisible && !!ws.api?.panels.some((p) => p.params?.__loc === 'right')
  if (closing && retries > 0) { setTimeout(() => revealRight(retries - 1), 120); return }
  if (!ws.rightVisible) ws.toggleSidebar('right')
  useWorkspace.getState().openView('tangu-details', {}, 'right')
}

let revealedAt = 0
/** 这枚令牌还没落过(at 是 Date.now(),单调):切走再切回、视图重挂,都不重放上一次的落点。 */
export const freshJump = (jump?: RecordJump): jump is RecordJump => !!jump && jump.at > revealedAt

/** 详情页里落到 rows 中文字对得上 texts 的那几行:滚到第一行、短暂高亮;一行都对不上就滚到 fallback(整块只滚不亮)。调用即用掉令牌。
 *  滚动放到下一帧:同一次提交里父组件切标签时会把滚动条归零(AgentProfile 的 navigate),先滚就白滚了。
 *  不用 scrollIntoView:它会连带滚动 overflow:hidden 的祖先(右栏整体错位),只滚最近的可滚动容器。 */
export function revealRecords(jump: RecordJump, rows: Iterable<HTMLElement>, fallback: HTMLElement | null): void {
  revealedAt = Math.max(revealedAt, jump.at)
  const norm = (x: string): string => x.replace(/\s+/g, ' ').trim()
  // 引擎把几条按 ' | ' 拼起来整串截 300 字(localHistorian 的 logActivity):到了截断线,末条可能只剩开头几个字,太短就不拿来比,免得亮一片
  const capped = jump.texts.join(' | ').length >= 290
  const want = jump.texts.map(norm).filter((x, i, all) => x && !(capped && i === all.length - 1 && x.length < 8))
  const hit = want.length ? [...rows].filter((el) => want.some((w) => norm(el.textContent || '').includes(w))) : []
  const target = hit[0] || fallback
  if (!target) return
  requestAnimationFrame(() => {
    if (!target.isConnected) return
    let sc = target.parentElement
    while (sc && !(/(auto|scroll)/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight)) sc = sc.parentElement
    if (sc) {
      const top = sc.scrollTop + target.getBoundingClientRect().top - sc.getBoundingClientRect().top - Math.max(16, (sc.clientHeight - target.offsetHeight) / 2)
      sc.scrollTo({ top: Math.max(0, top), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    }
    for (const el of hit) {
      el.removeAttribute('data-record-flash'); void el.offsetWidth // 连点两次「查看」也要重新亮一遍
      el.setAttribute('data-record-flash', '')
      setTimeout(() => el.removeAttribute('data-record-flash'), 1800)
    }
  })
}
