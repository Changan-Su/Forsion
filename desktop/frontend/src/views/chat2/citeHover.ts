/**
 * 正文编号 ↔ 右栏「来源」行的悬停联动(搜索来源编号,借鉴 DeepSeek chat-demo 方案 ②A)。
 * 键 = citeHoverKey(消息 id, 网址键):同一网址在不同回答里各是各的号。状态归 Tangu 界面;
 * 宿主的 Markdown 链接经 CITE_HOVER(CiteBinding 的那几个函数,随 cites 参数交过去)读写,不 import 本文件。
 */
import { create } from 'zustand'
import type { CiteBinding } from '../../../../../tangu-agent/src/contracts/citeSources'

export interface CiteHover { key: string | null; from: 'body' | 'rail' | null }

export const useCiteHover = create<CiteHover>(() => ({ key: null, from: null }))

export function enterCite(key: string, from: 'body' | 'rail'): void { useCiteHover.setState({ key, from }) }

/** 只清自己:鼠标从一个链接直接滑到相邻链接时,后者的 enter 可能先到。 */
export function leaveCite(key: string): void { if (useCiteHover.getState().key === key) useCiteHover.setState({ key: null, from: null }) }

/** 交给宿主的读写口(不含编号表)。 */
export const CITE_HOVER: Omit<CiteBinding, 'index'> = {
  subscribe: (onChange) => useCiteHover.subscribe(onChange),
  hotOf: (key) => { const s = useCiteHover.getState(); return s.key === key ? s.from : null },
  enter: enterCite,
  leave: leaveCite,
}
