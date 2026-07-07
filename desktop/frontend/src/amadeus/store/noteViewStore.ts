/** 「笔记视图」(Bases 式)渲染端 store:一张视图的行 = source.folder 直属笔记(实时)。
 *  行不存 .db —— props(path/title/frontmatter)从主进程 listPageProps 拉;单元格读写直落笔记 frontmatter。
 *  外部改动(Properties 面板/其他编辑器/外部增删)经 watcher 回灌;自写走原子账本不回声。
 *  写穿:setProp 乐观改本地 + per(note,key) 500ms 防抖(照 dbStore 先例)。 */
import { create } from 'zustand'
import type { PageProps } from '@amadeus-shared/ipc'
import { cellToFmValue } from '@amadeus-shared/db/pageFrontmatter'
import type { CellValue, ColumnType } from '@amadeus-shared/db/schema'
import { amadeus } from '../api'

export interface FolderView {
  status: 'loading' | 'ok' | 'error'
  props: PageProps[]
}

interface NoteViewState {
  folders: Record<string, FolderView>
  /** 幂等加载:已 ok 的 folder 跳过。 */
  load(folder: string): Promise<void>
  refresh(folder: string): Promise<void>
  /** 改一格属性:乐观更新本地 + 防抖写笔记 frontmatter。 */
  setProp(folder: string, notePath: string, key: string, value: CellValue | undefined, type: ColumnType): void
  /** 列改名 = 跨该文件夹所有笔记重写 frontmatter 键(旧键删、新键置)。 */
  renameProp(folder: string, oldKey: string, newKey: string): Promise<void>
  /** 新行 = 在文件夹里建一篇「未命名」笔记;返回其 vault 相对路径。 */
  addNote(folder: string): Promise<string>
  /** 删行 = 删对应笔记文件(调用方负责二次确认)。 */
  deleteNote(folder: string, notePath: string): Promise<void>
  /** 改 Page Name = 重命名笔记文件。 */
  renameNote(folder: string, notePath: string, newTitle: string): Promise<void>
}

const writeTimers = new Map<string, ReturnType<typeof setTimeout>>()
const WRITE_DELAY = 500
const loaded = new Set<string>() // 已载入的 folder(watcher 回灌范围)

export const useNoteViewStore = create<NoteViewState>((set, get) => ({
  folders: {},

  async load(folder) {
    if (get().folders[folder]?.status === 'ok') return
    await get().refresh(folder)
  },

  async refresh(folder) {
    set((s) => ({
      folders: { ...s.folders, [folder]: { status: s.folders[folder]?.status ?? 'loading', props: s.folders[folder]?.props ?? [] } },
    }))
    try {
      const props = await amadeus.listPageProps(folder)
      loaded.add(folder)
      set((s) => ({ folders: { ...s.folders, [folder]: { status: 'ok', props } } }))
    } catch {
      set((s) => ({ folders: { ...s.folders, [folder]: { status: 'error', props: s.folders[folder]?.props ?? [] } } }))
    }
  },

  setProp(folder, notePath, key, value, type) {
    const fmVal = cellToFmValue(value, type)
    set((s) => {
      const fv = s.folders[folder]
      if (!fv) return s
      const props = fv.props.map((p) => {
        if (p.path !== notePath) return p
        const fm = { ...p.fm }
        if (fmVal === undefined) delete fm[key]
        else fm[key] = fmVal
        return { ...p, fm }
      })
      return { folders: { ...s.folders, [folder]: { ...fv, props } } }
    })
    const tk = `${notePath}::${key}`
    const t = writeTimers.get(tk)
    if (t) clearTimeout(t)
    writeTimers.set(tk, setTimeout(() => {
      writeTimers.delete(tk)
      void amadeus.setPageFrontmatter(notePath, { [key]: fmVal })
    }, WRITE_DELAY))
  },

  async renameProp(folder, oldKey, newKey) {
    const fv = get().folders[folder]
    if (!fv) return
    await Promise.all(
      fv.props.map((p) => (oldKey in p.fm ? amadeus.setPageFrontmatter(p.path, { [oldKey]: undefined, [newKey]: p.fm[oldKey] }) : Promise.resolve())),
    )
    await get().refresh(folder)
  },

  async addNote(folder) {
    const titles = new Set((get().folders[folder]?.props ?? []).map((p) => p.title.toLowerCase()))
    let name = '未命名'
    let i = 1
    while (titles.has(name.toLowerCase())) name = `未命名 ${++i}`
    const notePath = folder ? `${folder}/${name}.md` : `${name}.md`
    await amadeus.newPage(notePath)
    await get().refresh(folder)
    return notePath
  },

  async deleteNote(folder, notePath) {
    await amadeus.deletePage(notePath)
    await get().refresh(folder)
  },

  async renameNote(folder, notePath, newTitle) {
    if (!newTitle.trim()) return
    try {
      await amadeus.renamePageFile(notePath, newTitle.trim())
    } catch {
      /* 撞名/非法名:忽略,refresh 会还原显示 */
    }
    await get().refresh(folder)
  },
}))

// watcher 回灌:内容改 → 刷新含该笔记的已载 folder;结构改(无 path)→ 刷新全部已载 folder。
if (typeof window !== 'undefined' && window.amadeus) {
  amadeus.onExternalChange?.((p) => {
    for (const folder of loaded) {
      const inFolder = folder === '' ? !p.includes('/') : p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes('/')
      if (inFolder) void useNoteViewStore.getState().refresh(folder)
    }
  })
  amadeus.onStructureChange?.(() => {
    for (const folder of loaded) void useNoteViewStore.getState().refresh(folder)
  })
}
