// Amadeus Space 的壳级 UI 状态:全局浮层(快速切换/模板选择)+ 编辑器模式。
// 编辑器模式原是 AmadeusEditorView 的组件内 state,上提到 store 供命令面板切换。
import { create } from 'zustand'
import { captureFromDom, setModeCursor } from '@amadeus/lib/modeCursor'
import { activePageScope } from '@amadeus/store/pageStore'

/** 模板插入上下文。两条路由二选一(发起方是谁就带谁的坐标):
 *  - v3 块编辑器:`afterId` 插到这个块之后;`emptyBlock` = 光标块为空 → 首个模板块直接填入它。
 *  - v4/unified:`v4Path` = 目标笔记路径 —— 那篇没有块 id,整份模板按 markdown 插在光标处。 */
export interface TemplateCtx { afterId?: string; emptyBlock?: boolean; v4Path?: string }

// (「文档 | 画布」胶囊曾在这里占一格 `canvasSeg`:UnifiedPage 发布、顶栏按 path 比对后渲染。
//  2026-08-18 拆掉 —— 那个「单个全局槽 + 路径比对」协议有三条各自都能让胶囊消失的路,用户实报过
//  两次。现在由 UnifiedPage 自己 portal 进本 pane 顶栏的插槽,理由与被排除的假设见 CanvasModeSeg 顶注。)

export type EditorMode = 'wysiwyg' | 'source'

// ── 源码 / 可视模式按 leaf 记(评审 C-08)───────────────────────────────────────────────────────
// 此前是一个全局单值:分屏里在一个面板点 `</>`,另一个面板也被切走、编辑器被动重建(滚动归零、撤销栈丢失)。
// Obsidian 按窗格各记各的。键 = leaf id(PageScopeCtx 的值;dockview 布局持久化会原样还原 leaf id),
// 所以记忆也落本机 localStorage:重启后每个标签回到它上次的模式。只存「源码」的那些(缺省 = 可视),封顶防无限长。
const MODES_KEY = 'amx.editorModes'
const MODES_CAP = 60

function loadModes(): Record<string, 'source'> {
  try {
    const raw = JSON.parse(localStorage.getItem(MODES_KEY) ?? '{}') as Record<string, unknown>
    const out: Record<string, 'source'> = {}
    for (const [k, v] of Object.entries(raw)) if (v === 'source') out[k] = 'source'
    return out
  } catch {
    return {}
  }
}
function saveModes(modes: Record<string, 'source'>): void {
  try { localStorage.setItem(MODES_KEY, JSON.stringify(modes)) } catch { /* 无痕 / 配额满:本次会话照样按 leaf 生效 */ }
}

/** 某个 leaf 此刻的模式(没有 leaf 的实例传 null → 跟随活动面板)。 */
export function editorModeOf(s: { modes: Record<string, 'source'> }, scope: string | null | undefined): EditorMode {
  return s.modes[scope ?? activePageScope()] === 'source' ? 'source' : 'wysiwyg'
}

interface UiOverlayState {
  overlay: 'switcher' | 'template' | null
  templateCtx: TemplateCtx | null
  /** 按 leaf 的源码/可视模式(见上)。读用 editorModeOf。 */
  modes: Record<string, 'source'>
  open(o: 'switcher'): void
  openTemplate(ctx: TemplateCtx): void
  close(): void
  /** 切一个 leaf 的模式;缺省 = 活动面板(命令面板那条路)。 */
  toggleEditorMode(scope?: string | null): void
  setEditorMode(scope: string | null | undefined, mode: EditorMode): void
}

export const useUiOverlay = create<UiOverlayState>((set, get) => ({
  overlay: null,
  templateCtx: null,
  modes: loadModes(),
  open: (o) => set({ overlay: o, templateCtx: null }),
  openTemplate: (ctx) => set({ overlay: 'template', templateCtx: ctx }),
  close: () => set({ overlay: null, templateCtx: null }),
  toggleEditorMode: (scope) => {
    const key = scope ?? activePageScope()
    get().setEditorMode(key, editorModeOf(get(), key) === 'source' ? 'wysiwyg' : 'source')
  },
  // 切换前把光标位置抓下来交给对面(见 lib/modeCursor)。抓取必须在这里做:
  // 这是所有入口(工具条按钮 + 命令面板 + 移动端胶囊)的唯一咽喉,且此刻 DOM 选区还在 —— 等 React
  // 卸载了 PageView 再想抓就什么都没有了。源码侧的光标由 SourceEditor 自己在卸载前登记。
  setEditorMode: (scope, mode) => {
    const key = scope ?? activePageScope()
    const cur = editorModeOf(get(), key)
    if (cur === mode) return
    if (cur === 'wysiwyg') setModeCursor(captureFromDom(), key)
    const modes = { ...get().modes }
    delete modes[key]
    if (mode === 'source') modes[key] = 'source' // 重新插入 = 排到最近,封顶时先丢最老的
    const keys = Object.keys(modes)
    for (const k of keys.slice(0, Math.max(0, keys.length - MODES_CAP))) delete modes[k]
    saveModes(modes)
    set({ modes })
  },
}))
