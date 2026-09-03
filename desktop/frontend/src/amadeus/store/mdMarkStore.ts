/** 全库正文 `@` 时间标记的只读投影,供待办视图 / 日历 / 提醒消费。
 *
 *  数据来自主进程 VaultIndex(它本来就持有每篇笔记的清洗全文,且随 watcher 逐文件增量更新)——
 *  所以这里既不读盘也不建第二份索引,一次 IPC 把结果拿回来即可。解析口径单源 @amadeus-shared/mdMarks。
 *
 *  刷新时机(与 dbAggregateStore 同款,都不是热路径):视图挂载 / vault 切换 / structureChange /
 *  换页(离开刚编辑过的笔记)/ 提醒轮询。**只读** —— 勾选不在这里写回,点击跳到笔记里勾(见 TodoListView)。
 */
import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { withChecked, withDue, type MdMark } from '@amadeus-shared/mdMarks'
import type { CellValue, DbColumn } from '@amadeus-shared/db/schema'
import { amadeus } from '../api'
import { usePageStore } from './pageStore'
import { notifyApp } from '../../stores/notificationStore'
import { registerMessages, translate, useI18n } from '../../i18n'
import type { AggDb } from './dbAggregateStore'

registerMessages({
  'mdmark.patchFailed': {
    zh: '改不动「{name}」—— 笔记里那一行已经变了',
    en: 'Can’t update “{name}” — that line in the note has changed',
  },
  'mdmark.openNote': { zh: '打开笔记', en: 'Open note' },
  'mdmark.colName': { zh: '事项', en: 'Item' },
  'mdmark.colDate': { zh: '时间', en: 'Time' },
  'mdmark.colNote': { zh: '来源笔记', en: 'Source note' },
  'mdmark.calName': { zh: '笔记', en: 'Notes' },
})

/** 一条标记行的乐观改动(还没落盘 / 正在落盘)。 */
interface MarkPatch { due?: string; checked?: boolean }

interface State {
  marks: MdMark[]
  ready: boolean
  /** 乐观覆盖,key = `路径:行号`。拖动与勾选立刻上屏,不等磁盘往返(拖动是每帧调用的)。 */
  overlay: Record<string, MarkPatch>
  load(): Promise<void>
  /** 改一条标记行:先覆盖上屏,防抖 400ms 后按内容回写那一行 markdown。 */
  patch(m: MdMark, p: MarkPatch): void
}

/** 覆盖表的键。行号在两次 load 之间稳定,而 `raw` 会随回写变(`- [ ]`→`- [x]`),所以不能用 raw。 */
const markKey = (m: Pick<MdMark, 'path' | 'line'>): string => `${m.path}:${m.line}`

const timers = new Map<string, number>()
let inflight = 0

let seq = 0
export const useMdMarkStore = create<State>((set, get) => ({
  marks: [],
  ready: false,
  overlay: {},
  async load() {
    if (!amadeus?.listMarks) {
      set({ marks: [], ready: true }) // 宿主没有这条接缝(web/mobile 壳)→ 静默降级成「只有多维表待办」
      return
    }
    const id = ++seq
    const vault = usePageStore.getState().vaultRoot
    try {
      // 先把编辑中的内容落盘,否则刚打的标记要等下一次自动保存才看得见。
      await usePageStore.getState().flushSave().catch(() => {})
      const marks = await amadeus.listMarks()
      // 迟到的结果不许污染新库(换 vault 后旧请求可能才回来)。
      if (id === seq && usePageStore.getState().vaultRoot === vault) set({ marks, ready: true })
    } catch {
      if (id === seq) set({ marks: [], ready: true })
    }
  },

  patch(m, p) {
    const key = markKey(m)
    set((s) => ({ overlay: { ...s.overlay, [key]: { ...s.overlay[key], ...p } } }))
    const prev = timers.get(key)
    if (prev) clearTimeout(prev)
    // 防抖:日历拖动每帧都会调进来,不能每帧写一次盘。
    timers.set(key, window.setTimeout(() => { timers.delete(key); void flush(key, m) }, 400))
  },
}))

/** 把覆盖表里那条改动真正写回 markdown。失败**只报不猜** —— 退回「去笔记里改」。 */
async function flush(key: string, fallback: MdMark): Promise<void> {
  const st = useMdMarkStore.getState()
  const o = st.overlay[key]
  if (!o || !amadeus?.patchMark) return
  // 用**最近一次 load 的**那一行原文当基准:它才是磁盘上此刻的样子。
  const cur = st.marks.find((x) => markKey(x) === key) ?? fallback
  let next = cur.raw
  if (o.checked !== undefined) next = withChecked(next, o.checked) ?? next
  if (o.due !== undefined) next = withDue(next, o.due) ?? next
  if (next !== cur.raw) {
    inflight++
    try {
      // 先把编辑中的内容落盘:不然我们读到的是旧文本,回写完还会被那发防抖保存整份盖掉。
      await usePageStore.getState().flushSave().catch(() => {})
      const ok = await amadeus.patchMark(cur.path, cur.raw, cur.occ, next).catch(() => false)
      if (!ok) {
        notifyApp({
          event: 'system.generic', level: 'warning',
          text: translate('mdmark.patchFailed', { name: cur.text }),
          action: {
            label: translate('mdmark.openNote'),
            // 动态 import:store 层不静态依赖导航层,免得绕出模块环。
            run: () => { void import('../../amadeusNav').then((n) => n.openNoteAtHeading(cur.path, cur.heading)) },
          },
        })
      }
    } finally {
      inflight--
    }
  }
  await useMdMarkStore.getState().load()
  // ⚠️ 只有「这条没有待发防抖、且没有别的回写在飞」才收覆盖:否则第二笔拖动会被第一笔的
  // load 清掉覆盖 → 事件闪回原位一帧。
  if (!timers.has(key) && inflight === 0) {
    useMdMarkStore.setState((s) => {
      const rest = { ...s.overlay }
      delete rest[key]
      return { overlay: rest }
    })
  }
}

/** 订阅全库标记(**已叠加乐观覆盖**);挂载 / 换库 / 换页时自动刷新。 */
export function useMdMarks(): MdMark[] {
  const marks = useMdMarkStore((s) => s.marks)
  const overlay = useMdMarkStore((s) => s.overlay)
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const activePage = usePageStore((s) => s.activePage)
  useEffect(() => {
    const t = setTimeout(() => { void useMdMarkStore.getState().load() }, 250)
    return () => clearTimeout(t)
  }, [vaultRoot, activePage])
  return useMemo(() => {
    const keys = Object.keys(overlay)
    if (!keys.length) return marks
    return marks.map((m) => {
      const o = overlay[markKey(m)]
      return o ? { ...m, due: o.due ?? m.due, checked: o.checked ?? m.checked } : m
    })
  }, [marks, overlay])
}

/** 就地改一条标记(待办勾选 / 日历改期)。宿主没有回写接缝(web/mobile)时返回 false,调用方退回跳转。 */
export function patchMark(m: MdMark, p: { due?: string; checked?: boolean }): boolean {
  if (!amadeus?.patchMark) return false
  useMdMarkStore.getState().patch(m, p)
  return true
}

export const useMdMarksReady = (): boolean => useMdMarkStore((s) => s.ready)

// 结构变更(新建/删除/改名笔记)→ 重拉。模块级订阅一次,与 dbAggregateStore 同款。
// ⚠️ 别再弄丢这一行:只靠 hook 的 vaultRoot/activePage 依赖,改的是**别的**笔记时投影不会更新,
// 删掉/改名后的旧待办还会一直挂在列表里跳向失效路径(2026-08-31 更名时漏带,Codex 评审揪出)。
amadeus?.onStructureChange?.(() => { void useMdMarkStore.getState().load() })

const MD_CAL_PATH = 'mdnote://vault-notes'
/** ⚠️ 列名是**展示文案**,必须每次求值:写成模块级常量会把语言冻结在模块加载那一刻,切英文不更新。
 *  列 id 定死(buildEvents 用 firstDateCol 找日期列),只有 name 是本地化的。 */
const mdCalColumns = (): DbColumn[] => [
  { id: 'name', name: translate('mdmark.colName'), type: 'text' },
  { id: 'date', name: translate('mdmark.colDate'), type: 'calendarDate' },
  { id: 'note', name: translate('mdmark.colNote'), type: 'text' },
]

/** 笔记正文标记合成的日历源(与 useAgentCalDbs / useOtherVaultCalDbs / useIcsCalDbs 同族)。
 *  只收**非勾选框**的行 —— 带勾选框的归待办列表(用户口径:「只有时间 → 只添加日程;是 checkbox → 进 todo」)。
 *  一张合成表而不是每篇笔记一张:图例里一行「笔记」,不然几十篇笔记刷屏。
 *
 *  **可编辑投影**:`readonly` 仍为真(删除/复制/当默认库照旧关着),但给了 `writeCell` ——
 *  日历上拖动/改期会回写笔记里那个 `@` 串。真源始终只有 markdown 一份,不存在两边不一致。 */
export function useMdCalDbs(): AggDb[] {
  const marks = useMdMarks()
  const { locale } = useI18n() // 库名/列名都是本地化文案 → 必须进 memo 依赖,否则切语言不刷新
  return useMemo(() => {
    const events = marks.filter((m) => !m.isTask)
    if (!events.length) return []
    const byRow = new Map(events.map((m) => [markKey(m), m]))
    const rows = events.map((m) => ({
      rowId: markKey(m),
      name: m.text,
      cells: { name: m.text, date: m.due, note: m.title } as Record<string, CellValue>,
    }))
    return [{
      path: MD_CAL_PATH,
      name: translate('mdmark.calName'),
      isNoteView: false,
      readonly: true,
      columns: mdCalColumns(),
      rows,
      writeCell: amadeus?.patchMark
        ? (rowId, colId, value) => {
            const m = byRow.get(rowId)
            if (!m || colId !== 'date' || typeof value !== 'string' || !value) return
            useMdMarkStore.getState().patch(m, { due: value })
          }
        : undefined,
      openRow: (rowId) => {
        const m = byRow.get(rowId)
        if (m) void import('../../amadeusNav').then((n) => n.openNoteAtHeading(m.path, m.heading))
      },
    }]
  }, [marks, locale])
}
