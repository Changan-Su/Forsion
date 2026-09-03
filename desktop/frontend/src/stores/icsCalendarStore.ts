/**
 * 外部日历订阅(.ics):订阅表 + 事件缓存 → 合成**只读** AggDb 源,与 useAgentCalDbs /
 * useOtherVaultCalDbs 同一形态,于是配色、显隐、图例、渲染全部原样复用,零新事件模型。
 *
 * 订阅表与事件缓存都存 localStorage(不进 vault、不进 git):
 *  · 不进 vault —— 订阅是「这台机器上的偏好」,写进笔记会跟着云同步跑到别的设备,
 *    还会把带密钥的私有订阅地址落进 vault 文件里。
 *  · **事件必须一并持久化** —— 本地导入的 .ics 没有 url,永远不会再拉;只存表不存事件的话,
 *    重启后那本日历就永久空白(Codex 评审实证)。远端订阅同理:离线开机也该看得见上次的内容。
 * 拉取走主进程(window.tangu.fetchIcs)绕开 CORS —— 订阅地址一律不发 CORS 头。
 *
 * ponytail: 只读单向。写回外部日历要 CalDAV,是另一个量级的活儿,现在不做。
 */
import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import type { CellValue, DbColumn } from '@amadeus-shared/db/schema'
import type { AggDb } from '../amadeus/store/dbAggregateStore'
import { registerMessages, translate, useI18n } from '../i18n'
import { icsCalendarName, looksLikeIcs, parseIcs, type IcsEvent } from '../views/calendar/ics'

registerMessages({
  'ics.colEvent': { zh: '事件', en: 'Event' },
  'ics.colDate': { zh: '日期', en: 'Date' },
  'ics.importedCalendar': { zh: '导入的日历', en: 'Imported calendar' },
  'ics.externalCalendar': { zh: '外部日历', en: 'External calendar' },
  'ics.errUnsupported': { zh: '当前端不支持订阅外部日历', en: 'This client cannot subscribe to external calendars' },
  'ics.errFetchFailed': { zh: '拉取失败', en: 'Fetch failed' },
  'ics.errNotCalendar': { zh: '返回的不是日历文件(地址可能已失效)', en: 'The response is not a calendar file (the address may no longer be valid)' },
  'ics.untitledEvent': { zh: '(无标题)', en: '(untitled)' },
})

export interface IcsSub {
  id: string
  name: string
  /** 订阅地址;本地导入的快照为空串(永不刷新) */
  url: string
}

/**
 * 合成 AggDb 的固定两列:名称 + 日期。列 id 定死,buildEvents 用 firstDateCol 找日期列。
 * ⚠️ 列名是**展示文案**,必须每次求值:写成模块级常量会把语言冻结在模块加载那一刻,切英文不更新。
 */
export const ICS_NAME_COL = 'name'
export const ICS_DATE_COL = 'date'
const icsColumns = (): DbColumn[] => [
  { id: ICS_NAME_COL, name: translate('ics.colEvent'), type: 'text' },
  { id: ICS_DATE_COL, name: translate('ics.colDate'), type: 'date' },
]

const KEY = 'amadeus.calendar.ics'
const CACHE_KEY = 'amadeus.calendar.ics.cache'
const REFRESH_MS = 30 * 60 * 1000 // 半小时;订阅本来就是低频只读源
/** 本地导入的 .ics 上限:同步解析,太大会把渲染进程冻住。 */
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024

/** 展示名:URL 里可能带密钥(Google/Outlook 的「私密地址」),**绝不整条显示** —— 截图/录屏就泄了。 */
export function displayName(sub: IcsSub): string {
  if (sub.name && sub.name !== sub.url) return sub.name
  if (!sub.url) return translate('ics.importedCalendar')
  try {
    return new URL(sub.url.replace(/^webcal:\/\//i, 'https://')).host
  } catch {
    return translate('ics.externalCalendar')
  }
}

const loadJson = <T,>(key: string, fallback: T): T => {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null')
    return v && typeof v === 'object' ? (v as T) : fallback
  } catch {
    return fallback
  }
}
const save = (key: string, v: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* 配额满:本次会话仍可用 */
  }
}
const loadSubs = (): IcsSub[] => {
  const v = loadJson<IcsSub[]>(KEY, [])
  return Array.isArray(v) ? v.filter((s) => s && typeof s.url === 'string') : []
}

interface IcsState {
  subs: IcsSub[]
  /** 订阅 id → 已解析事件(随 subs 一起持久化) */
  events: Record<string, IcsEvent[]>
  /** 订阅 id → 上次拉取的错误(展示在配置栏);成功则删键 */
  errors: Record<string, string>
  loading: Record<string, boolean>
  add(url: string): IcsSub
  rename(id: string, name: string): void
  remove(id: string): void
  refresh(id: string): Promise<void>
  refreshAll(): Promise<void>
  /** 本地 .ics 文件内容 → 直接当成一个订阅源(url 为空,不会被自动刷新)。 */
  importText(name: string, text: string): IcsSub | null
}

let seq = 0
let lastAll = 0 // refreshAll 的节流水位(模块级:多个组件共用同一份)
const inflight = new Map<string, number>() // 订阅 id → 最新一次请求的序号,用来丢弃后到的旧响应
const newId = (): string => `ics${Date.now().toString(36)}${(seq++).toString(36)}`

export const useIcsCalendars = create<IcsState>((set, get) => ({
  subs: loadSubs(),
  events: loadJson<Record<string, IcsEvent[]>>(CACHE_KEY, {}),
  errors: {},
  loading: {},

  add(url) {
    const u = url.trim()
    const sub: IcsSub = { id: newId(), name: u, url: u } // 名字先占位;首拉拿到 X-WR-CALNAME 会替换
    const subs = [...get().subs, sub]
    save(KEY, subs)
    set({ subs })
    void get().refresh(sub.id)
    return sub
  },

  rename(id, name) {
    const subs = get().subs.map((s) => (s.id === id ? { ...s, name: name.trim() || s.name } : s))
    save(KEY, subs)
    set({ subs })
  },

  remove(id) {
    const subs = get().subs.filter((s) => s.id !== id)
    const { [id]: _e, ...events } = get().events
    const { [id]: _r, ...errors } = get().errors
    save(KEY, subs)
    save(CACHE_KEY, events)
    set({ subs, events, errors })
  },

  async refresh(id) {
    const sub = get().subs.find((s) => s.id === id)
    if (!sub || !sub.url) return // 本地导入的快照没有 url,不刷新
    const fetchIcs = window.tangu?.fetchIcs
    if (!fetchIcs) {
      set((s) => ({ errors: { ...s.errors, [id]: translate('ics.errUnsupported') } }))
      return
    }
    const ticket = (inflight.get(id) ?? 0) + 1 // 自动刷新与手点刷新可能同时在飞:后发的说了算
    inflight.set(id, ticket)
    set((s) => ({ loading: { ...s.loading, [id]: true } }))
    const res = await fetchIcs(sub.url).catch((e: unknown) => ({ ok: false, error: String(e) }))
    if (inflight.get(id) !== ticket) return // 已有更新的请求发出/回来了,这条作废
    set((s) => {
      const loading = { ...s.loading, [id]: false }
      const fail = (msg: string): Partial<IcsState> => ({ loading, errors: { ...s.errors, [id]: msg } })
      if (!res.ok || !('text' in res) || !res.text) return fail(res.error || translate('ics.errFetchFailed'))
      // 订阅地址失效后常见的是「200 + 登录页 HTML」。当成功处理会把已有事件清空 —— 宁可留旧数据。
      if (!looksLikeIcs(res.text)) return fail(translate('ics.errNotCalendar'))
      const { [id]: _drop, ...errors } = s.errors
      // 名字还是占位的地址 → 用日历自己报的 X-WR-CALNAME(用户手动改过就不动)
      const calName = icsCalendarName(res.text)
      const subs = calName ? s.subs.map((x) => (x.id === id && x.name === x.url ? { ...x, name: calName } : x)) : s.subs
      if (subs !== s.subs) save(KEY, subs)
      const events = { ...s.events, [id]: parseIcs(res.text) }
      save(CACHE_KEY, events)
      return { loading, errors, subs, events }
    })
  },

  async refreshAll() {
    // 节流:Calendar 主区与右侧配置栏各自 useIcsCalDbs(),切标签还会重挂 —— 不拦就是每次挂载多拉一轮。
    const now = Date.now()
    if (now - lastAll < REFRESH_MS) return
    lastAll = now
    await Promise.all(get().subs.map((s) => get().refresh(s.id)))
  },

  importText(name, text) {
    if (!looksLikeIcs(text)) return null
    // 无名时**存空串**而不是落一句本地化文案:落盘的名字会把语言冻在导入那一刻,
    // 留空则由 displayName() 每次按当前语言给回退名(url 也为空,不会被当成占位地址)。
    const sub: IcsSub = { id: newId(), name: name.trim(), url: '' }
    const subs = [...get().subs, sub]
    const events = { ...get().events, [sub.id]: parseIcs(text) }
    save(KEY, subs)
    save(CACHE_KEY, events)
    set({ subs, events })
    return sub
  },
}))

/** 事件 → 只读 AggDb(path=`ics://<id>`,colorForDb/isHidden 按 path 字符串键,天然可用)。 */
export function icsToAggDb(sub: IcsSub, events: IcsEvent[]): AggDb {
  // rowId 必须唯一:日历的事件键是 `${db.path}::${rowId}`,撞键会让两条事件互相顶掉(选中/编辑卡全乱)。
  // 真实导出里 UID 重复并不罕见(合并过的日历、被截断的导出),而且加过后缀的名字**本身也可能撞**
  // (源数据里正好有个 `a#2`),所以要一直加到不重复为止。
  const seen = new Set<string>()
  return {
    path: `ics://${sub.id}`,
    name: displayName(sub),
    isNoteView: false,
    readonly: true,
    columns: icsColumns(),
    rows: events.map((e, i) => {
      const base = e.uid || `e${i}`
      let rowId = base
      for (let k = 0; seen.has(rowId); k++) rowId = `${base}#${i}.${k}`
      seen.add(rowId)
      return {
        rowId,
        name: e.summary || translate('ics.untitledEvent'),
        cells: {
          [ICS_NAME_COL]: e.summary as CellValue,
          [ICS_DATE_COL]: (e.end ? `${e.start}/${e.end}` : e.start) as CellValue,
        },
      }
    }),
  }
}

/** 订阅源的只读日历库。挂载即拉一轮(有节流),之后每半小时一次。 */
export function useIcsCalDbs(): AggDb[] {
  const subs = useIcsCalendars((s) => s.subs)
  const events = useIcsCalendars((s) => s.events)
  const { locale } = useI18n() // 列名/回退名/(无标题)都是本地化文案 → 必须进 memo 依赖,否则切语言不刷新
  useEffect(() => {
    void useIcsCalendars.getState().refreshAll()
    const t = window.setInterval(() => void useIcsCalendars.getState().refreshAll(), REFRESH_MS)
    return () => window.clearInterval(t)
  }, [])
  return useMemo(() => subs.map((s) => icsToAggDb(s, events[s.id] ?? [])), [subs, events, locale])
}
