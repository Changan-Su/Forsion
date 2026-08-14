/** 页内查找(Cmd/Ctrl+F):跨块高亮 + 全局上一条/下一条。
 *  页面 = 一块一 Milkdown,所以由共享 findStore 协调:每块的装饰插件把自己的命中数上报(等值守卫防环),
 *  全局激活序号经 flatOrder 的块序折算成「本块第几个」;MilkdownInner 订阅 store 变化派发空事务重绘。
 *  大小写不敏感;命中按编辑器可见文本算(markdown 语法字符不参与)。 */
import { create } from 'zustand'
import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { usePageStore } from '../../store/pageStore'

interface FindState {
  open: boolean
  query: string
  /** 全局命中序号(0 基,跨块拼接序)。 */
  active: number
  /** blockId → 命中数(装饰插件上报;块删除的残留在 total 求和时被 flatOrder 过滤)。 */
  counts: Record<string, number>
  openBar(): void
  close(): void
  setQuery(q: string): void
  step(dir: 1 | -1): void
  report(blockId: string, count: number): void
}

export const useFindStore = create<FindState>((set, get) => ({
  open: false,
  query: '',
  active: 0,
  counts: {},
  openBar: () => set({ open: true }),
  close: () => set({ open: false, query: '', active: 0, counts: {} }),
  setQuery: (query) => set({ query, active: 0 }),
  step: (dir) => {
    const total = findTotal()
    if (!total) return
    set({ active: (get().active + dir + total) % total })
  },
  report: (blockId, count) => {
    if ((get().counts[blockId] ?? 0) === count) return // 等值守卫:装饰每次重算都会上报
    set((s) => ({ counts: { ...s.counts, [blockId]: count } }))
  },
}))

/** v4 统一实例的上报 id:整篇只有一个编辑器,且它**不在 pageStore 的块序里**(flatOrder 恒空)
 *  —— 求和会得 0,全局序号折算也无从谈起。故这一格自成一路:总数即它自己,active 直接就是本地序号。
 *  ⚠️ 统一页卸载时必须 close() 清掉这一格,否则 v3 页面会一直走这条捷径(见 UnifiedPage)。 */
export const UNIFIED_FIND_ID = '__unified__'

/** 总命中 = 按块序求和(flatOrder 过滤掉已删块的残留计数);统一实例走单格捷径。 */
export function findTotal(): number {
  const { counts } = useFindStore.getState()
  if (counts[UNIFIED_FIND_ID] != null) return counts[UNIFIED_FIND_ID]
  return usePageStore
    .getState()
    .flatOrder()
    .reduce((a, id) => a + (counts[id] ?? 0), 0)
}

/** 全局 active → 某块的本地命中序号;不在本块返回 -1。 */
function localActive(blockId: string): number {
  const { active, counts } = useFindStore.getState()
  if (blockId === UNIFIED_FIND_ID) return active < (counts[blockId] ?? 0) ? active : -1
  let before = 0
  for (const id of usePageStore.getState().flatOrder()) {
    const c = counts[id] ?? 0
    if (id === blockId) {
      const local = active - before
      return local >= 0 && local < c ? local : -1
    }
    before += c
  }
  return -1
}

/** blockId 缺省(整篇宿主 PlainMarkdownEditor)→ 插件休眠。 */
export function findPlugin(blockId?: string) {
  return $prose(
    () =>
      new Plugin({
        props: {
          decorations(state) {
            if (!blockId) return null
            const { open, query } = useFindStore.getState()
            const q = query.trim().toLowerCase()
            if (!open || !q) {
              useFindStore.getState().report(blockId, 0)
              return null
            }
            const decos: Decoration[] = []
            let count = 0
            const activeIdx = localActive(blockId)
            state.doc.descendants((node, pos) => {
              if (!node.isTextblock) return true
              const text = node.textContent.toLowerCase()
              let at = text.indexOf(q)
              while (at !== -1) {
                const from = pos + 1 + at
                const cls = count === activeIdx ? 'amx-find-hit amx-find-active' : 'amx-find-hit'
                decos.push(Decoration.inline(from, from + q.length, { class: cls }))
                count++
                at = text.indexOf(q, at + q.length)
              }
              return false
            })
            useFindStore.getState().report(blockId, count)
            return decos.length ? DecorationSet.create(state.doc, decos) : null
          },
        },
      }),
  )
}
