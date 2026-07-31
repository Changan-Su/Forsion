/** `![[画板.excalidraw]]` → 可编辑的 Excalidraw 画布(照 DatabaseEmbed 的 `![[x.db]]` 先例)。
 *  文件是 Obsidian Excalidraw 插件(zsviczian)同款的 `.excalidraw.md`,同一个库两边可互开
 *  —— 格式细节见 shared/amadeus/excalidraw/format。 */
import { Suspense, lazy, useEffect, useState } from 'react'
import { useDrawStore, registerDrawingApplier } from '../../store/drawingStore'
import { useTheme } from '../../../stores/themeStore'
import { useI18n } from '../../../i18n'
import { amadeus } from '../../api'
import type { BoardSettings } from '@amadeus-shared/excalidraw/board'

// 必须在 @excalidraw/excalidraw 的模块体执行之前设好这两个全局:
// - ASSET_PATH:它默认去 CDN(esm.sh)现拉字体 —— 本 App 的 CSP 是 default-src 'self',且桌面端要能离线用
//   → 指向自托管副本(build/copy-excalidraw-assets.cjs 把 dist/prod/fonts 拷进 public/excalidraw/)。
//   **别照抄官方文档的 '/'**:打包后渲染器是 file://,'/' 会指到文件系统根;而它内部对 './' 开头的值是拿
//   location.origin 去解析的,file:// 下同样不可靠。用 document.baseURI 拼绝对 URL,dev(http)/prod(file) 通吃。
// - EXPORT_SOURCE:它在模块初始化时就读(`window.EXCALIDRAW_EXPORT_SOURCE || location.origin`),
//   不设的话每个文件的 source 字段都会记上 dev 端口/file origin 这种没意义的值。
// 本模块被 BlockHost 静态 import(应用启动即执行),画布走 lazy → 先后顺序天然成立。
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string
    EXCALIDRAW_EXPORT_SOURCE?: string
  }
}
if (typeof window !== 'undefined') {
  window.EXCALIDRAW_ASSET_PATH = new URL('excalidraw/', document.baseURI).href
  window.EXCALIDRAW_EXPORT_SOURCE = 'Forsion Amadeus'
}

const ExcalidrawCanvas = lazy(() => import('./ExcalidrawCanvas'))

export function ExcalidrawEmbed({ target, pagePath }: { target: string; pagePath: string }): React.JSX.Element {
  const entry = useDrawStore((s) => s.entries[target])
  useEffect(() => {
    void useDrawStore.getState().load(pagePath, target) // 幂等,多处嵌入共用一次载入
  }, [pagePath, target])

  if (!entry || entry.status === 'loading') {
    return <div className="amx-draw amx-draw-state">读取画板…</div>
  }
  if (entry.status === 'missing') {
    return (
      <div className="amx-draw amx-draw-state">
        画板文件缺失:<code>{target}</code>
        <button className="amx-db-linkbtn" onClick={() => void useDrawStore.getState().reload(pagePath, target)}>重试</button>
      </div>
    )
  }
  if (entry.status === 'corrupt' || !entry.scene) {
    return (
      <div className="amx-draw amx-draw-state">
        画板文件读不出场景数据,已进入只读保护。
        {entry.path && (
          <button className="amx-db-linkbtn" onClick={() => void amadeus.revealInFileManager(entry.path!)}>
            在文件管理器中显示
          </button>
        )}
        <button className="amx-db-linkbtn" onClick={() => void useDrawStore.getState().reload(pagePath, target)}>重试</button>
      </div>
    )
  }
  return <Board target={target} settings={entry.settings} />
}

/** 只在 entry 成 ok 后挂载,好把 initialData 一次性定种:<Excalidraw> 挂载后自持编辑态,
 *  initialData 之后再变它也不看。种子必须取 seedFor(最新落盘态,含防抖窗内的 pending)——
 *  取初次载入的旧 scene 就是「白板关掉重开回到旧内容」,旧种子再画一笔还会盖掉磁盘新内容。 */
function Board({ target, settings }: { target: string; settings: BoardSettings }): React.JSX.Element {
  const [seed] = useState(() => useDrawStore.getState().seedFor(target) ?? {})
  // 卸载即冲刷:防抖里的最后一笔立即落盘,scene 种子随之推进,下次挂载才拿得到最新内容。
  useEffect(() => () => { void useDrawStore.getState().flush(target) }, [target])
  const mode = useTheme((s) => s.mode) // 注意:themeStore 的 lang 是**设计语言**(lovable/echo…),不是界面语言
  const { locale } = useI18n()
  return (
    <div className="amx-draw" onPointerDown={(e) => e.stopPropagation()}>
      <Suspense fallback={<div className="amx-draw-state">加载画板编辑器…</div>}>
        <ExcalidrawCanvas
          initialData={seed}
          theme={mode}
          // ⚠️ 画布加载语言包时会伸手改 `document.documentElement` 的 lang 与 dir(它自己的全局约定)。
          // 而本 App 的 i18n(i18n.tsx:1910)也在写 html[lang] —— 必须喂同一个 locale,两边才不打架。
          langCode={locale === 'zh' ? 'zh-CN' : 'en'}
          settings={settings}
          onSettings={(patch) => void useDrawStore.getState().setSettings(target, patch)}
          onSceneChange={(sceneJson) => useDrawStore.getState().save(target, sceneJson)}
          registerApplier={(fn) => registerDrawingApplier(target, fn)}
        />
      </Suspense>
    </div>
  )
}
