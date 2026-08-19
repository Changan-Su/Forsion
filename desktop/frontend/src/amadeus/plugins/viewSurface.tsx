/** 插件文件视图的「per-view 页表面」(2026-08-14 scope 化):每个打开的插件文件 tab 拿一份
 *  绑定自己 pageStore 作用域的块表面 —— 画布/导图与编辑器面板并存编辑,互不抢页。
 *  由 AmadeusPluginFileView 在 ft.mount 前创建、随 `file.surface` 递给插件;视图卸载/插件禁用
 *  由宿主统一 dispose(插件忘了清理也收得干净)。
 *
 *  ⚠️ 不变式(下一个文件类型消费者别踩):这份表面只服务 **v3 标记制页面**。插件文件类型天生
 *  钉死在 v3(升级器 upgradeV3Source 按扩展名+外来 fm 键双重拒绝),首次 loadPage 会把素文件
 *  importForeign 成 v3 —— 这正是画布/导图的既定生命周期。但把一份**普通** v4/素 md 喂给
 *  loadPage = 首次防抖保存把它改写成 v3 格式 = 毁档。所以 loadPage 只认本文件类型注册的后缀。 */
import { PageScopeCtx, disposePageStoreScope, pageStoreFor } from '../store/pageStore'
import { PageView } from '../components/PageView'
import { NoteCover } from '../chrome/pageChrome'
import { Breadcrumb, NoteTitle } from '../../amadeusViews'
import { AmadeusPropertiesPanel } from '../../amadeusProperties'
import { isCoarsePointer } from '../../touch'
import { createBlockSurface, mountHostReact } from './blockSurface'
import { isValidPluginExt } from './pluginStore'
import type { PluginPageSurface } from './types'

/** 文档模式要的是「与普通笔记**完全无差**的身体」(2026-08-14 用户验收拍板):封面横幅 + emoji
 *  图标 + 标题 + 属性面板 + 真 PageView,与 amadeusViews v3 编辑器同一套三件套逐字复用。
 *  此前刻意裁掉标题/属性的两层顾虑已在宿主根治:
 *  - 改名:renamePage 入口 + 树上改名双双保全复合后缀(`.canvas.md` 改不丢类型);
 *  - 属性面板:按 FileTypeContribution.fmKeys 隐藏插件数据键,且模型持全量不可能抹键(P0 契约)。
 *  包裹类名与编辑器面板一致(.amadeus-root.am-app.amx-pane),否则拿不到主题 token 与 amx-doc 版式。 */
function PluginNoteSurface({ scope }: { scope: string }) {
  return (
    <PageScopeCtx.Provider value={scope}>
      <div className="amadeus-root am-app amx-pane plugin-note-surface">
        {/* 普通编辑器面板在笔记面之上还有一条 sticky 顶栏(.amx-toolbar):没有它,封面/标题/
            「添加图标/封面」整面贴到 tab 顶沿,比普通笔记高一截(实报)。这里同类名复用同一套
            sticky/背景/padding,面包屑也走 scope 化 activePage;右侧动作钮(置顶/分享/源码切换…)
            是编辑器视图的内联 chrome,语义未接线,刻意不搬 —— 插件自己的模式切换钮悬浮在同一条带右侧。
            移动端与普通笔记同口径隐藏(amadeusViews 2051 行同款门)。 */}
        {!isCoarsePointer() && <div className="amx-toolbar"><Breadcrumb /></div>}
        <NoteCover />
        <div className="amx-doc"><NoteTitle /><AmadeusPropertiesPanel /></div>
        <PageView bare />
      </div>
    </PageScopeCtx.Provider>
  )
}

export function createPluginViewSurface(
  pluginId: string,
  scope: string,
  extensions: readonly string[],
): { surface: PluginPageSurface; dispose: () => void } {
  const store = pageStoreFor(scope)
  const { api, revoke } = createBlockSurface(pluginId, { store, scope })
  let alive = true
  const noteMounts = new Set<() => void>()

  // 畸形后缀(裸 '.md'/'md'/空串)不参与匹配:endsWith('') 恒真、endsWith('md') 命中一切笔记,
  // 会把文件头那条毁档防线整个打开。注册端(registerFileType)已拒,这里是纵深兜底。
  const usable = extensions.map((e) => String(e ?? '')).filter(isValidPluginExt)
  const claims = (p: string): boolean => usable.some((e) => p.toLowerCase().endsWith(e.toLowerCase()))

  const surface: PluginPageSurface = {
    ...api,
    loadPage(path) {
      if (!alive) return
      const p = String(path ?? '')
      // 见文件头不变式:超出本类型后缀的路径一律拒 —— loadPage 会把普通笔记拽进 v3 存储管线改写掉。
      if (!claims(p)) {
        console.warn(`[amadeus] 插件 ${pluginId} 的视图表面拒绝加载「${p}」(不属于该文件类型的后缀)`)
        return
      }
      void store.getState().loadPage(p)
    },
    getActivePage: () => store.getState().activePage,
    mountNoteView(el) {
      if (!alive || !(el instanceof HTMLElement)) return () => {}
      const disposeRoot = mountHostReact(el, <PluginNoteSurface scope={scope} />)
      const dispose = (): void => {
        noteMounts.delete(dispose)
        disposeRoot()
      }
      noteMounts.add(dispose)
      return dispose
    },
  }

  const dispose = (): void => {
    if (!alive) return
    alive = false
    for (const d of [...noteMounts]) {
      try { d() } catch { /* ignore */ }
    }
    noteMounts.clear()
    revoke()
    // 先收表面再回收作用域:disposePageStoreScope 内部先 flushSave 再摘表,未落盘的改动带不走。
    disposePageStoreScope(scope)
  }

  return { surface, dispose }
}
