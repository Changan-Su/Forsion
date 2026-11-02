/** 独立白板视图:树上点 .excalidraw.md 在应用内打开 Excalidraw 画布(多实例,params.drawingPath
 *  认领文件并随布局持久化)。target=pagePath=完整 vault 相对路径 —— 与 AmadeusDbView 同一约定,
 *  resolveAttachment 页相对落空会回退按 vault 根解析;与笔记内嵌 `![[X.excalidraw]]` 共享 drawingStore。 */
import { useEffect } from 'react'
import { PenTool } from 'lucide-react'
import type { ViewProps } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'
import { openNote } from '../amadeusNav'
import { useVisualTheme as useTheme } from '../stores/themeStore'
import { ExcalidrawEmbed } from '@amadeus/blocks/excalidraw/ExcalidrawEmbed'
import { useVaultRelParam } from './vaultRelParam'

registerMessages({
  'drawview.openInBoard': { zh: '在白板中打开', en: 'Open in whiteboard' },
})

const drawBase = (p: string): string => (p.split(/[\\/]/).pop() || p).replace(/\.excalidraw(\.md)?$/i, '')

export function AmadeusDrawingView({ leaf }: ViewProps) {
  const drawingPath = useVaultRelParam(leaf, 'drawingPath')
  const mode = useTheme((s) => s.mode)
  const { t } = useI18n()
  // Desk 磁贴(走查续七 7.7 A):只读预览,只画图;要改就「在白板中打开」或双击,进主区那块白板。
  const preview = leaf.params.preview === true
  // navigateLeaf 会把标题重置为 displayName,挂载/参数变化后设回文件名(AmadeusDbView 同款)。
  useEffect(() => {
    if (drawingPath) leaf.setTitle(drawBase(drawingPath))
  }, [drawingPath]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!drawingPath) return <div className="amx-draw-state">未指定白板文件。</div>
  return (
    /* 编辑器同款契约域(.am-app+bridge 取色,镜像 mode/flat);.amx-drawview 让画布铺满 leaf */
    <div className="am-app tangu-lovable amx-pane amx-drawview" data-mode={mode}>
      <ExcalidrawEmbed target={drawingPath} pagePath={drawingPath} preview={preview} />
      {preview && <>
        {/* 盖一层:磁贴里不选、不拖、滚轮不平移画布(滚的是外面的对话) */}
        <div className="amx-drawpreview-shield" onDoubleClick={() => void openNote(drawingPath)} />
        <button type="button" className="amx-drawpreview-open" onClick={() => void openNote(drawingPath)}><PenTool size={14} />{t('drawview.openInBoard')}</button>
      </>}
    </div>
  )
}
