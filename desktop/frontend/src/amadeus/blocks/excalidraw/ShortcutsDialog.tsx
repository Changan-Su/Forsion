/** 白板「快捷键」(走查续七 7.4):替掉引擎自带的帮助框(上游文档 / YouTube / 提交问题外链 + Cmd / Option 键名)。
 *  只有一张表,键位取自引擎帮助框的键表(这一版 fork 的真键位),挑常用的;键名 mac 写符号(boardText.formatShortcut)。
 *  挂在引擎根外面(portal 到 body),只用应用 token。打开时焦点进对话框:引擎的键盘处理挂在画布容器上,
 *  焦点离开画布,⌫ 之类就不会落到底下选中的元素上。 */
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { registerMessages, useI18n } from '../../../i18n'
import { useEscape } from '../../components/Dialogs'
import { formatShortcut } from './boardText'
import './shortcutsDialog.css'

registerMessages({
  'boardkeys.title': { zh: '快捷键', en: 'Keyboard shortcuts' },
  'boardkeys.tools': { zh: '工具', en: 'Tools' },
  'boardkeys.view': { zh: '视图', en: 'View' },
  'boardkeys.edit': { zh: '编辑', en: 'Edit' },
  'boardkeys.selection': { zh: '选择', en: 'Selection' },
  'boardkeys.hand': { zh: '抓手（平移画布）', en: 'Hand (pan canvas)' },
  'boardkeys.rectangle': { zh: '矩形', en: 'Rectangle' },
  'boardkeys.diamond': { zh: '菱形', en: 'Diamond' },
  'boardkeys.ellipse': { zh: '椭圆', en: 'Ellipse' },
  'boardkeys.arrow': { zh: '箭头', en: 'Arrow' },
  'boardkeys.line': { zh: '线条', en: 'Line' },
  'boardkeys.freedraw': { zh: '自由书写', en: 'Draw' },
  'boardkeys.text': { zh: '文字', en: 'Text' },
  'boardkeys.eraser': { zh: '橡皮', en: 'Eraser' },
  'boardkeys.frame': { zh: '框架', en: 'Frame' },
  'boardkeys.laser': { zh: '激光笔', en: 'Laser pointer' },
  'boardkeys.lock': { zh: '保持工具', en: 'Keep tool active' },
  'boardkeys.zoomIn': { zh: '放大', en: 'Zoom in' },
  'boardkeys.zoomOut': { zh: '缩小', en: 'Zoom out' },
  'boardkeys.resetZoom': { zh: '重置缩放', en: 'Reset zoom' },
  'boardkeys.fit': { zh: '适配全图', en: 'Zoom to fit' },
  'boardkeys.fitSelection': { zh: '缩放到选中', en: 'Zoom to selection' },
  'boardkeys.grid': { zh: '网格', en: 'Grid' },
  'boardkeys.snap': { zh: '吸附至对象', en: 'Snap to objects' },
  'boardkeys.zen': { zh: '禅模式', en: 'Zen mode' },
  'boardkeys.viewMode': { zh: '查看模式', en: 'View mode' },
  'boardkeys.find': { zh: '在画布上查找', en: 'Find on canvas' },
  'boardkeys.pan': { zh: '平移画布', en: 'Pan canvas' },
  'boardkeys.drag': { zh: '拖动', en: 'Drag' },
  'boardkeys.undo': { zh: '撤销', en: 'Undo' },
  'boardkeys.redo': { zh: '重做', en: 'Redo' },
  'boardkeys.cut': { zh: '剪切', en: 'Cut' },
  'boardkeys.paste': { zh: '粘贴', en: 'Paste' },
  'boardkeys.delete': { zh: '删除', en: 'Delete' },
  'boardkeys.selectAll': { zh: '全选', en: 'Select all' },
  'boardkeys.pasteStyles': { zh: '粘贴样式', en: 'Paste styles' },
  'boardkeys.group': { zh: '编组', en: 'Group' },
  'boardkeys.ungroup': { zh: '取消编组', en: 'Ungroup' },
  'boardkeys.forward': { zh: '上移一层', en: 'Bring forward' },
  'boardkeys.backward': { zh: '下移一层', en: 'Send backward' },
  'boardkeys.lockElement': { zh: '锁定 / 解锁', en: 'Lock / unlock' },
  'boardkeys.editText': { zh: '编辑文字', en: 'Edit text' },
})

type Row = [label: string, ...keys: string[]]
const GROUPS: Array<[title: string, rows: Row[]]> = [
  ['boardkeys.tools', [
    // 数字键跟着自建工具条的排序走(toolbarOrder,用户能拖),这里只列字母键。
    ['boardkeys.selection', 'V'], ['boardkeys.hand', 'H'], ['boardkeys.rectangle', 'R'], ['boardkeys.diamond', 'D'],
    ['boardkeys.ellipse', 'O'], ['boardkeys.arrow', 'A'], ['boardkeys.line', 'L'], ['boardkeys.freedraw', 'P'],
    ['boardkeys.text', 'T'], ['boardkeys.eraser', 'E'], ['boardkeys.frame', 'F'],
    ['boardkeys.laser', 'K'], ['boardkeys.lock', 'Q'],
  ]],
  ['boardkeys.view', [
    ['boardkeys.zoomIn', 'Mod++'], ['boardkeys.zoomOut', 'Mod+-'], ['boardkeys.resetZoom', 'Mod+0'], ['boardkeys.fit', 'Shift+1'],
    ['boardkeys.fitSelection', 'Shift+2'], ['boardkeys.grid', "Mod+'"], ['boardkeys.snap', 'Alt+S'], ['boardkeys.zen', 'Alt+Z'],
    ['boardkeys.viewMode', 'Alt+R'], ['boardkeys.find', 'Mod+F'], ['boardkeys.pan', 'Space+@drag'],
  ]],
  ['boardkeys.edit', [
    ['boardkeys.undo', 'Mod+Z'], ['boardkeys.redo', 'Mod+Shift+Z'], ['boardkeys.cut', 'Mod+X'], ['boardkeys.copy', 'Mod+C'],
    ['boardkeys.paste', 'Mod+V'], ['boardkeys.duplicate', 'Mod+D'], ['boardkeys.delete', 'Delete'], ['boardkeys.selectAll', 'Mod+A'],
    ['boardkeys.copyStyles', 'Mod+Alt+C'], ['boardkeys.pasteStyles', 'Mod+Alt+V'], ['boardkeys.group', 'Mod+G'], ['boardkeys.ungroup', 'Mod+Shift+G'],
    ['boardkeys.forward', 'Mod+]'], ['boardkeys.backward', 'Mod+['], ['boardkeys.lockElement', 'Mod+Shift+L'], ['boardkeys.editText', 'Enter'],
  ]],
]

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  useEscape(onClose)
  const keyText = (spec: string): string => formatShortcut(spec.replace('@drag', t('boardkeys.drag')))
  return createPortal(
    <div className="am-app tangu-lovable" style={{ display: 'contents' }}>
      <div className="dialog-overlay amx-keys-overlay" onMouseDown={onClose}>
        <div className="dialog amx-keys" role="dialog" aria-modal="true" aria-label={t('boardkeys.title')} data-board-shortcuts onMouseDown={(e) => e.stopPropagation()}>
          <div className="amx-keys-head">
            <div className="dialog-title">{t('boardkeys.title')}</div>
            <button type="button" className="amx-keys-close" autoFocus aria-label={t('common.close')} title={t('common.close')} onClick={onClose}><X size={16} /></button>
          </div>
          <div className="amx-keys-groups">
            {GROUPS.map(([title, rows]) => (
              <section key={title} className="amx-keys-group">
                <h3>{t(title)}</h3>
                {rows.map(([label, ...keys]) => (
                  <div key={label} className="amx-keys-row">
                    <span>{t(label)}</span>
                    <span className="amx-keys-caps">{keys.map((k) => <kbd key={k}>{keyText(k)}</kbd>)}</span>
                  </div>
                ))}
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
