// Amadeus Space 的壳级 UI 状态:全局浮层(快速切换/模板选择)+ 编辑器模式。
// 编辑器模式原是 AmadeusEditorView 的组件内 state,上提到 store 供命令面板切换。
import { create } from 'zustand'
import { captureFromDom, setModeCursor } from '@amadeus/lib/modeCursor'
import { activePageScope } from '@amadeus/store/pageStore'

/** 模板插入上下文:插到哪个块之后;光标块为空则首个模板块直接填入它。 */
export interface TemplateCtx { afterId: string; emptyBlock: boolean }

// (「文档 | 画布」胶囊曾在这里占一格 `canvasSeg`:UnifiedPage 发布、顶栏按 path 比对后渲染。
//  2026-08-18 拆掉 —— 那个「单个全局槽 + 路径比对」协议有三条各自都能让胶囊消失的路,用户实报过
//  两次。现在由 UnifiedPage 自己 portal 进本 pane 顶栏的插槽,理由与被排除的假设见 CanvasModeSeg 顶注。)

interface UiOverlayState {
  overlay: 'switcher' | 'template' | null
  templateCtx: TemplateCtx | null
  editorMode: 'wysiwyg' | 'source'
  open(o: 'switcher'): void
  openTemplate(ctx: TemplateCtx): void
  close(): void
  toggleEditorMode(): void
}

export const useUiOverlay = create<UiOverlayState>((set) => ({
  overlay: null,
  templateCtx: null,
  editorMode: 'wysiwyg',
  open: (o) => set({ overlay: o, templateCtx: null }),
  openTemplate: (ctx) => set({ overlay: 'template', templateCtx: ctx }),
  close: () => set({ overlay: null, templateCtx: null }),
  // 切换前把光标位置抓下来交给对面(见 lib/modeCursor)。抓取必须在这里做:
  // 这是两个入口(工具条按钮 + 命令面板)的唯一咽喉,且此刻 DOM 选区还在 —— 等 React
  // 卸载了 PageView 再想抓就什么都没有了。源码侧的光标由 SourceEditor 自己在卸载前登记。
  toggleEditorMode: () =>
    set((s) => {
      if (s.editorMode === 'wysiwyg') setModeCursor(captureFromDom(), activePageScope())
      return { editorMode: s.editorMode === 'source' ? 'wysiwyg' : 'source' }
    }),
}))
