/**
 * 正文编号 ↔ 右栏「来源」行的悬停联动(搜索来源编号,借鉴 DeepSeek chat-demo 方案 ②A)。
 * 键 = 消息 id + 网址键(citeSources.citeKey):同一网址在不同回答里各是各的号。
 * from:悬停的是正文链接还是右栏那行 —— 右栏悬停时正文链接才垫底色,正文自己悬停只亮编号。
 */
import { create } from 'zustand'

export interface CiteHover { key: string | null; from: 'body' | 'rail' | null }

export const useCiteHover = create<CiteHover>(() => ({ key: null, from: null }))

export const citeHoverKey = (msgId: string, key: string): string => `${msgId}\u0000${key}`

export function enterCite(key: string, from: 'body' | 'rail'): void { useCiteHover.setState({ key, from }) }

/** 只清自己:鼠标从一个链接直接滑到相邻链接时,后者的 enter 可能先到。 */
export function leaveCite(key: string): void { if (useCiteHover.getState().key === key) useCiteHover.setState({ key: null, from: null }) }
