/** 全库正文任务(`- [ ]`)的只读投影,供待办视图消费。
 *
 *  数据来自主进程 VaultIndex(它本来就持有每篇笔记的清洗全文,且随 watcher 逐文件增量更新)——
 *  所以这里既不读盘也不建第二份索引,一次 IPC 把结果拿回来即可。解析口径单源 @amadeus-shared/mdTasks。
 *
 *  刷新时机(与 dbAggregateStore 同款,都不是热路径):视图挂载 / vault 切换 / structureChange /
 *  换页(离开刚编辑过的笔记)。**只读** —— 勾选不在这里写回,点击跳到笔记里勾(见 TodoListView)。
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import type { MdTask } from '@amadeus-shared/mdTasks'
import { amadeus } from '../api'
import { usePageStore } from './pageStore'

interface State {
  tasks: MdTask[]
  ready: boolean
  load(): Promise<void>
}

let seq = 0
export const useMdTaskStore = create<State>((set) => ({
  tasks: [],
  ready: false,
  async load() {
    if (!amadeus?.listTasks) {
      set({ tasks: [], ready: true }) // 宿主没有这条接缝(web/mobile 壳)→ 静默降级成「只有多维表待办」
      return
    }
    const id = ++seq
    const vault = usePageStore.getState().vaultRoot
    try {
      // 先把编辑中的内容落盘,否则刚打的勾要等下一次自动保存才看得见。
      await usePageStore.getState().flushSave().catch(() => {})
      const tasks = await amadeus.listTasks()
      // 迟到的结果不许污染新库(换 vault 后旧请求可能才回来)。
      if (id === seq && usePageStore.getState().vaultRoot === vault) set({ tasks, ready: true })
    } catch {
      if (id === seq) set({ tasks: [], ready: true })
    }
  },
}))

/** 订阅全库正文任务;挂载 / 换库 / 换页时自动刷新。 */
export function useMdTasks(): MdTask[] {
  const tasks = useMdTaskStore((s) => s.tasks)
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const activePage = usePageStore((s) => s.activePage)
  useEffect(() => {
    const t = setTimeout(() => { void useMdTaskStore.getState().load() }, 250)
    return () => clearTimeout(t)
  }, [vaultRoot, activePage])
  return tasks
}

export const useMdTasksReady = (): boolean => useMdTaskStore((s) => s.ready)

// 结构变更(新建/删除/改名笔记)→ 重拉。模块级订阅一次,与 dbAggregateStore 同款。
amadeus?.onStructureChange?.(() => { void useMdTaskStore.getState().load() })
