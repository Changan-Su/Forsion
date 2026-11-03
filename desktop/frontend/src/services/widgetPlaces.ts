// 小组件的两个笔记库去处:卡片区(Dashboards/卡片区.dashboard.md)与「存到仪表盘」的今天(Dashboards/今天.dashboard.md)。
// 板名跟随界面语言(英文 Cards / Today),找的时候两个名字都认,切语言不会生出第二块。主页的摆放在本机,见 views/homeWidgets.ts。
// 写走 CAS(带 base 的 writeTextFile),对不上就重读重放;读不到一块已存在的板 = 拒绝,绝不当空板覆盖。
import { useEffect, useSyncExternalStore } from 'react'
import { amadeus } from '../amadeus/api'
import { reconcileLocalWrite, usePageStore } from '../amadeus/store/pageStore'
import { textFingerprint } from '@amadeus-shared/writeConflict'
import {
  addWidgetToBoard, moveWidgetOnBoard, readBoardWidgets, removeWidgetFromBoard, setWidgetScope,
  type BoardEdit, type BoardWidget, type WidgetRef,
} from '@amadeus-shared/widgetBoard'
import { currentLocale, translateFor } from '../i18n'

export type BoardKind = 'rail' | 'today'
const NAME_KEY: Record<BoardKind, string> = { rail: 'amadeus.default.cardsBoard', today: 'amadeus.default.todayBoard' }
export const boardPath = (kind: BoardKind, locale: 'zh' | 'en'): string => `Dashboards/${translateFor(locale, NAME_KEY[kind])}.dashboard.md`

/** 当前语言的名字在前;两份都在时取当前语言那份。 */
async function locate(kind: BoardKind): Promise<{ path: string; raw: string | null }> {
  const mine = currentLocale() === 'en' ? 'en' : 'zh'
  const paths = [boardPath(kind, mine), boardPath(kind, mine === 'zh' ? 'en' : 'zh')]
  for (const path of paths) {
    const raw = await amadeus.readTextFile(path).catch(() => null)
    if (raw != null) return { path, raw }
  }
  return { path: paths[0], raw: null } // 可能不存在;建的时候 create:true 会告诉我们它其实在不在
}

// ── 订阅:谁在看哪块板 ──
type BoardState = { status: 'loading' } | { status: 'ok'; path: string; items: BoardWidget[] } | { status: 'unreadable'; error: string }
const states: Record<BoardKind, BoardState> = { rail: { status: 'loading' }, today: { status: 'loading' } }
const subs = new Set<() => void>()
const emit = (): void => { for (const f of subs) f() }
const paths = new Set<string>()

// ⚠️ 库还没装上时 readTextFile 也回 null(和「文件不存在」分不开):这时只能说「还不知道」,
// 不能当没有这块板 —— 重启后落在对话里,卡片区先读到 null 就再也不重读了(真机台架 W7b 实证)。
const vaultOpen = (): boolean => !!usePageStore.getState().vaultRoot

async function refresh(kind: BoardKind): Promise<void> {
  if (!vaultOpen()) { states[kind] = { status: 'loading' }; emit(); return }
  try {
    const { path, raw } = await locate(kind)
    paths.add(path)
    const r = raw == null ? { ok: true as const, items: [] } : readBoardWidgets(raw, path)
    states[kind] = r.ok ? { status: 'ok', path, items: r.items } : { status: 'unreadable', error: r.error }
  } catch (e) {
    states[kind] = { status: 'unreadable', error: String(e) }
  }
  emit()
}

let wired = false
function wire(): void {
  if (wired || !amadeus) return
  wired = true
  amadeus.onExternalChange?.((p) => { if (paths.has(p)) { void refresh('rail'); void refresh('today') } })
  amadeus.onStructureChange?.(() => { void refresh('rail'); void refresh('today') })
  window.addEventListener('focus', () => { void refresh('rail'); void refresh('today') })
  // 库装上 / 换了库:板是相对路径,按新库重读
  usePageStore.subscribe((s, prev) => { if (s.vaultRoot !== prev.vaultRoot) { void refresh('rail'); void refresh('today') } })
}

export function useBoardWidgets(kind: BoardKind): BoardState {
  useEffect(() => { wire(); void refresh(kind) }, [kind])
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f) }, () => states[kind])
}

export function boardItems(kind: BoardKind): BoardWidget[] {
  const s = states[kind]
  return s.status === 'ok' ? s.items : []
}

/** kind = 两块固定板之一;{ path } = 用户挑的一块现有仪表盘(不存在就不建)。 */
async function mutate(target: BoardKind | { path: string }, edit: (raw: string | null, path: string, title: string) => BoardEdit): Promise<void> {
  const kind = typeof target === 'string' ? target : null
  const title = kind ? translateFor(currentLocale() === 'en' ? 'en' : 'zh', NAME_KEY[kind]) : ''
  if (!vaultOpen()) throw new Error('vault is not open')
  for (let attempt = 0; attempt < 4; attempt++) {
    const { path, raw } = kind ? await locate(kind) : { path: (target as { path: string }).path, raw: await amadeus.readTextFile((target as { path: string }).path) }
    const r = edit(raw, path, title)
    if (!r.ok) throw new Error(r.error)
    if (!r.changed) return
    const res = await amadeus.writeTextFile(path, r.text, raw == null ? { create: true, base: textFingerprint('') } : { base: textFingerprint(raw) })
    if (res && res.ok === false) continue // 别处同时改了(或其实已存在)→ 重读重放
    paths.add(path)
    if (raw == null) void usePageStore.getState().refreshStructure().catch(() => {})
    reconcileLocalWrite(path)
    await Promise.all([refresh('rail'), refresh('today')])
    return
  }
  throw new Error('board changed too often, try again')
}

export const placeOnBoard = (kind: BoardKind, ref: WidgetRef): Promise<void> =>
  mutate(kind, (raw, path, title) => addWidgetToBoard(raw, path, title, ref))
export const placeOnDashboard = (path: string, ref: WidgetRef): Promise<void> =>
  mutate({ path }, (raw, p, title) => addWidgetToBoard(raw, p, title, ref))
export const removeFromBoard = (kind: BoardKind, id: string): Promise<void> =>
  mutate(kind, (raw, path) => (raw == null ? { ok: true, text: '', changed: false } : removeWidgetFromBoard(raw, path, id)))
export const moveOnBoard = (kind: BoardKind, id: string, beforeId: string | null): Promise<void> =>
  mutate(kind, (raw, path) => (raw == null ? { ok: true, text: '', changed: false } : moveWidgetOnBoard(raw, path, id, beforeId)))
export const setRailScope = (id: string, scope: WidgetRef['scope']): Promise<void> =>
  mutate('rail', (raw, path) => (raw == null ? { ok: true, text: '', changed: false } : setWidgetScope(raw, path, id, scope)))
