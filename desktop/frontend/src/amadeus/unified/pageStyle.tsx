/** 页面排版选项(评审 C-21,拍板 #14)的宿主一半:笔记 ⋯ 菜单的入口集合 + 落到编辑器壳 `.amx-pane` 上的属性。
 *
 *  · 状态在 viewMemory(本机、按库根 + 路径,不写 md;改名 / 移动经 remapNoteViewMemory 跟着走)。
 *  · 入口集合只有一份(pageStyleEntries):桌面顶栏 ⋯ 菜单与移动端 ⋯ sheet 各自只负责画,项目、文案、状态同源。
 *  · 属性只由笔记宿主(amadeusViews 的 EditorScope)给 v4 笔记挂;分享页 / Muse 库 / 收件箱不挂 = 恒按缺省。
 *    PDF 导出克隆的就是这个壳,属性随克隆走 → 导出的字体 / 字号与屏幕一致(纸面本来就窄于 920,全宽不起作用)。
 *  · 只作用于这一篇的正文排版:CSS 限定在 `.unified-body:not(.amx-canvas)`(画布模式不受影响)与标题,不碰界面字号。 */
import { useEffect, useState, type ReactElement } from 'react'
import { ALargeSmall, Check, MoveHorizontal } from 'lucide-react'
import { registerMessages, translate } from '../../i18n'
import {
  DEFAULT_PAGE_STYLE,
  onNotePageStyleChange,
  readNotePageStyle,
  writeNotePageStyle,
  type NotePageFont,
  type NotePageStyle,
} from './viewMemory'

registerMessages({
  'amxpage.font': { zh: '页面字体', en: 'Page font' },
  'amxpage.font.default': { zh: '默认', en: 'Default' },
  'amxpage.font.serif': { zh: '衬线', en: 'Serif' },
  'amxpage.font.mono': { zh: '等宽', en: 'Mono' },
  'amxpage.wide': { zh: '全宽', en: 'Full width' },
  'amxpage.small': { zh: '小字号', en: 'Small text' },
})

export const PAGE_FONTS: readonly NotePageFont[] = ['default', 'serif', 'mono']

export type PageStyleEntry =
  | { kind: 'choice'; id: 'font'; label: string; options: Array<{ id: NotePageFont; label: string; on: boolean; run: () => void }> }
  | { kind: 'toggle'; id: 'wide' | 'small'; label: string; on: boolean; run: () => void }

/** ⋯ 菜单里的排版项(桌面 / 移动同一份):页面字体三选一、全宽、小字号。文案渲染期求值(切语言即跟上)。 */
export function pageStyleEntries(
  style: NotePageStyle,
  set: (patch: Partial<NotePageStyle>) => void,
  tr: (key: string) => string = translate,
): PageStyleEntry[] {
  return [
    {
      kind: 'choice',
      id: 'font',
      label: tr('amxpage.font'),
      options: PAGE_FONTS.map((f) => ({ id: f, label: tr(`amxpage.font.${f}`), on: style.font === f, run: () => set({ font: f }) })),
    },
    { kind: 'toggle', id: 'wide', label: tr('amxpage.wide'), on: style.wide, run: () => set({ wide: !style.wide }) },
    { kind: 'toggle', id: 'small', label: tr('amxpage.small'), on: style.small, run: () => set({ small: !style.small }) },
  ]
}

/** 这一篇在本机的排版选项(随任一标签 / 窗口的改动刷新)。path 为空 = 缺省。 */
export function useNotePageStyle(vaultRoot: string | null | undefined, path: string | null): NotePageStyle {
  const [, bump] = useState(0)
  useEffect(() => onNotePageStyleChange(() => bump((n) => n + 1)), [])
  return path ? readNotePageStyle(vaultRoot, path) : DEFAULT_PAGE_STYLE
}

/** 写这一篇的排版选项(菜单项的 set)。 */
export function setNotePageStyle(vaultRoot: string | null | undefined, path: string, patch: Partial<NotePageStyle>): void {
  writeNotePageStyle(vaultRoot, path, patch)
}

/** 挂到编辑器壳上的属性;缺省值一个都不出(CSS 按属性在场与否判)。 */
export function pageStyleAttrs(style: NotePageStyle): { 'data-page-wide'?: ''; 'data-page-small'?: ''; 'data-page-font'?: 'serif' | 'mono' } {
  return {
    ...(style.wide ? { 'data-page-wide': '' as const } : {}),
    ...(style.small ? { 'data-page-small': '' as const } : {}),
    ...(style.font !== 'default' ? { 'data-page-font': style.font } : {}),
  }
}

const TOGGLE_ICON = { wide: MoveHorizontal, small: ALargeSmall } as const

/** 桌面 ⋯ 菜单(`.ctx-menu`)里的排版段:字体一排三格(每格用该字体写 Aa),两个开关末列打勾。
 *  点了菜单不关 —— 与 Notion 同,边点边看正文变化。 */
export function PageStyleMenuItems({ entries }: { entries: PageStyleEntry[] }): ReactElement {
  return (
    <div className="amx-pagestyle" data-pagestyle-menu="">
      {entries.map((e) => e.kind === 'choice' ? (
        <div key={e.id} className="amx-pagefont" role="group" aria-label={e.label}>
          <div className="ctx-head">{e.label}</div>
          <div className="amx-pagefont-row">
            {e.options.map((o) => (
              <button
                key={o.id}
                type="button"
                role="menuitemradio"
                aria-checked={o.on}
                className={`amx-pagefont-opt${o.on ? ' on' : ''}`}
                data-font={o.id}
                onClick={o.run}
              >
                <span className="amx-pagefont-aa" aria-hidden>Aa</span>
                <span className="amx-pagefont-name">{o.label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <PageStyleToggle key={e.id} entry={e} />
      ))}
    </div>
  )
}

function PageStyleToggle({ entry }: { entry: Extract<PageStyleEntry, { kind: 'toggle' }> }): ReactElement {
  const Icon = TOGGLE_ICON[entry.id]
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={entry.on} data-pagestyle={entry.id} onClick={entry.run}>
      <Icon size={13} />
      <span className="amx-pagestyle-label">{entry.label}</span>
      {entry.on && <Check size={13} className="amx-pagestyle-check" />}
    </button>
  )
}
