// Sidebar panel contributed by the built-in "outline" plugin: lists the active page's
// headings (in document order) and scrolls to them on click.
// 取标题/跳转两条路由(v3 块 + v4 unified)统一在 lib/activeNote,与右栏那个大纲视图同源。

import { useNoteOutline } from '../../lib/activeNote'
import { registerMessages, useI18n } from '../../../i18n'

registerMessages({
  'outlinepanel.empty': { zh: '没有标题', en: 'No headings' },
})

export function OutlinePanel() {
  const { t } = useI18n()
  const heads = useNoteOutline()
  if (heads.length === 0) return <div className="panel-empty">{t('outlinepanel.empty')}</div>

  return (
    <div className="outline">
      {heads.map((h) => (
        <button
          key={h.key}
          className="outline-item"
          data-level={h.level}
          style={{ paddingLeft: 8 + (h.level - 1) * 12 }}
          onClick={h.go}
          title={h.text}
        >
          {h.text}
        </button>
      ))}
    </div>
  )
}
