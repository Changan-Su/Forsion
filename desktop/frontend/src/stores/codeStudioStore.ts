/** Coding Space 的跨组件状态。
 *  项目:`~/Forsion/Project/<项目>`,每个项目一个子文件夹(= 会话 cwd + 预览根)。activeProject 为空 → 主区显示项目选择器。
 *  工作台:Code|Preview 模式(持久化)、当前编辑文件(绝对路径)、预览入口(相对项目根的 html)、重载脉冲。
 *  activeProject 不持久化(每次启动回到选择器,符合「空态项目列表」);选/建项目即绑定一个会话(cwd=项目)。 */
import { create } from 'zustand'
import { useApp } from './appStore'

export type StudioMode = 'code' | 'preview'
const MODE_KEY = 'coding.studio.mode'
const loadMode = (): StudioMode => (localStorage.getItem(MODE_KEY) === 'code' ? 'code' : 'preview')

interface CodeStudioState {
  /** 项目根 `~/Forsion/Project`(启动时经 IPC 解析)。 */
  projectsRoot: string | null
  setProjectsRoot(p: string | null): void
  /** 当前项目绝对路径(= 预览根 + 会话 cwd);null = 显示项目选择器。 */
  activeProject: string | null
  /** 选/建一个项目:设为当前 + 绑定会话(有则激活,无则起 Coding 新对话草稿)。 */
  openProject(path: string, name: string): void
  /** 让左侧对话跟随某项目:已对齐则不动;否则激活该项目最近会话 / 起绑定该项目的新对话草稿。
   *  供 openProject 与「切回 Coding Space 时活动会话漂移」的重绑用。 */
  bindChatToProject(path: string, name: string): void
  /** 回到项目选择器。 */
  closeProject(): void
  /** 无项目时左侧对话回「新对话」待机:coding agent 草稿、不挂项目、不显示别处漂来的旧会话。 */
  idleChat(): void

  mode: StudioMode
  setMode(m: StudioMode): void
  /** 当前在 Code 面板编辑的文件(绝对路径;null=未选)。 */
  activeFile: string | null
  setActiveFile(path: string | null): void
  /** 预览入口(相对项目根,如 'index.html')。 */
  entry: string | null
  setEntry(rel: string | null): void
  /** iframe 重载脉冲(agent 写盘 / 保存 / 切项目后 +1)。 */
  reloadNonce: number
  reload(): void
  /** 文件树点开某文件:选中 + 切到 Code 模式。 */
  openFile(path: string): void
}

export const useCodeStudio = create<CodeStudioState>((set, get) => ({
  projectsRoot: null,
  setProjectsRoot: (projectsRoot) => set({ projectsRoot }),
  activeProject: null,
  openProject: (path, name) => {
    // 切项目 → 清掉上个项目的入口/选中文件,回预览模式,刷新。
    set({ activeProject: path, entry: null, activeFile: null, mode: 'preview' })
    useApp.getState().setActiveWorkspaceKey(path) // 右栏文件树/会话聚焦该项目
    get().bindChatToProject(path, name)
    get().reload()
  },
  bindChatToProject: (path, name) => {
    const app = useApp.getState()
    const cur = app.sessions.find((s) => s.id === app.activeId)
    if (cur && cur.project_path === path) return // 左侧对话已在本项目 → 不动
    const existing = app.sessions
      .filter((s) => s.project_path === path)
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))[0]
    if (existing) {
      app.setActiveId(existing.id) // 该项目最近的会话
    } else {
      // 无会话 → 起一个绑定该项目的 Coding 新对话草稿(首次发送即在此建 host 会话)。
      app.selectNewChatAgent('coding')
      app.setNewChatWs({ key: path, name, kind: 'local', path })
      app.setActiveId(null)
    }
  },
  closeProject: () => set({ activeProject: null }),
  idleChat: () => {
    const app = useApp.getState()
    app.selectNewChatAgent('coding')
    app.setNewChatWs(null)
    app.setActiveId(null)
  },

  mode: loadMode(),
  setMode: (mode) => {
    try { localStorage.setItem(MODE_KEY, mode) } catch { /* private mode */ }
    set({ mode })
  },
  activeFile: null,
  setActiveFile: (activeFile) => set({ activeFile }),
  entry: null,
  setEntry: (entry) => set({ entry }),
  reloadNonce: 0,
  reload: () => set((s) => ({ reloadNonce: s.reloadNonce + 1 })),
  openFile: (path) => set({ activeFile: path, mode: 'code' }),
}))
