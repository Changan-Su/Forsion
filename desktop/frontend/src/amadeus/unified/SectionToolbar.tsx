// 版块工具条(方向 B):选区落在版块里时浮在版块右上方。挂载点 / 命令见 sections.ts。
// 只订阅 sections.ts 的小 store —— 版块换了、样式或栏数变了才重渲,打字不触发。
// 所有按钮 mousedown 先 preventDefault:焦点和选区留在编辑器里(工具条在 .ProseMirror 里面,
// CSS 用 :focus-within 判「编辑器正在用」,焦点被按钮抢走工具条会当场消失)。
import { useEffect, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { EditorView } from '@milkdown/kit/prose/view'
import { AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, AlignVerticalJustifyStart, Check, ChevronDown, Ellipsis, LayoutGrid } from 'lucide-react'
import { registerMessages, useI18n } from '../../i18n'
import { BLOCK_BG_COLORS } from '../blocks/markdown/colorPaletteValues'
import { SECTION_MAX_COLUMNS, sectionView, type SectionAlign, type SectionPad } from './columns'
import { removeSection, setSectionColumns, setSectionStyle, type SectionToolbarStore } from './sections'

registerMessages({
  'amxsec.toolbar': { zh: '版块', en: 'Section' },
  'amxsec.bg': { zh: '底色', en: 'Background' },
  'amxsec.bgTheme': { zh: '跟随主题', en: 'Follow theme' },
  'amxsec.columns': { zh: '栏数', en: 'Columns' },
  'amxsec.colN': { zh: '{n} 栏', en: '{n} columns' },
  'amxsec.spacing': { zh: '留白', en: 'Spacing' },
  'amxsec.pad.s': { zh: '小', en: 'S' },
  'amxsec.pad.m': { zh: '中', en: 'M' },
  'amxsec.pad.l': { zh: '大', en: 'L' },
  'amxsec.padTitle.s': { zh: '留白：小', en: 'Spacing: small' },
  'amxsec.padTitle.m': { zh: '留白：中', en: 'Spacing: medium' },
  'amxsec.padTitle.l': { zh: '留白：大', en: 'Spacing: large' },
  'amxsec.cards': { zh: '卡片', en: 'Cards' },
  'amxsec.align': { zh: '垂直对齐', en: 'Vertical alignment' },
  'amxsec.align.t': { zh: '顶部对齐', en: 'Align top' },
  'amxsec.align.m': { zh: '居中对齐', en: 'Align middle' },
  'amxsec.align.b': { zh: '底部对齐', en: 'Align bottom' },
  'amxsec.stack': { zh: '窄屏叠放', en: 'Stack on narrow screens' },
  'amxsec.more': { zh: '更多', en: 'More' },
  'amxsec.remove': { zh: '取消版块', en: 'Remove section' },
})

const PADS: SectionPad[] = ['s', 'm', 'l']
const ALIGNS: Array<{ v: SectionAlign; icon: typeof AlignVerticalJustifyStart }> = [
  { v: 't', icon: AlignVerticalJustifyStart },
  { v: 'm', icon: AlignVerticalJustifyCenter },
  { v: 'b', icon: AlignVerticalJustifyEnd },
]

export function SectionToolbar({ store }: { store: SectionToolbarStore }) {
  const { t } = useI18n()
  const s = useSyncExternalStore(store.subscribe, store.get)
  const [open, setOpen] = useState<null | 'bg' | 'more'>(null)
  // 换了一个版块(或工具条挂点重建)就把弹出的小面板收起
  useEffect(() => setOpen(null), [s?.el, s?.rowPos])
  if (!s) return null
  const v = sectionView(s.section)
  /** 现取 store 里的最新行位(别闭包 s:点击时文档可能已变)。 */
  const act = (fn: (view: EditorView, rowPos: number) => unknown, close = true) => (e: ReactMouseEvent) => {
    e.preventDefault()
    const cur = store.get()
    if (cur) fn(cur.view, cur.rowPos)
    if (close) setOpen(null)
  }
  const toggle = (which: 'bg' | 'more') => (e: ReactMouseEvent) => { e.preventDefault(); setOpen((o) => (o === which ? null : which)) }
  const bgSwatch = v.bg ? BLOCK_BG_COLORS.find((c) => c.v === v.bg)?.swatch : undefined

  return createPortal(
    <div className="amx-sec-tb" role="toolbar" aria-label={t('amxsec.toolbar')} onMouseDown={(e) => e.preventDefault()}>
      <div className="amx-sec-tb-group">
        <button type="button" className="amx-sec-tb-btn" data-act="bg" aria-haspopup="true" aria-expanded={open === 'bg'} title={t('amxsec.bg')} onMouseDown={toggle('bg')}>
          <i className="amx-sec-swatch" data-sec-bg={v.bg || 'theme'} style={bgSwatch ? { background: bgSwatch } : undefined} />
          <ChevronDown size={12} />
        </button>
      </div>
      <div className="amx-sec-tb-group" role="group" aria-label={t('amxsec.columns')}>
        {Array.from({ length: SECTION_MAX_COLUMNS }, (_, i) => i + 1).map((n) => (
          <button key={n} type="button" className="amx-sec-tb-btn amx-sec-tb-seg" data-act={`cols-${n}`} aria-pressed={s.cols === n}
            title={t('amxsec.colN', { n })} onMouseDown={act((view, pos) => setSectionColumns(view, pos, n))}>{n}</button>
        ))}
      </div>
      <div className="amx-sec-tb-group" role="group" aria-label={t('amxsec.spacing')}>
        {PADS.map((p) => (
          <button key={p} type="button" className="amx-sec-tb-btn amx-sec-tb-seg" data-act={`pad-${p}`} aria-pressed={v.pad === p}
            title={t(`amxsec.padTitle.${p}`)} onMouseDown={act((view, pos) => setSectionStyle(view, pos, { pad: p }))}>{t(`amxsec.pad.${p}`)}</button>
        ))}
      </div>
      <div className="amx-sec-tb-group" role="group" aria-label={t('amxsec.align')}>
        {ALIGNS.map(({ v: a, icon: Icon }) => (
          <button key={a} type="button" className="amx-sec-tb-btn amx-sec-tb-seg" data-act={`valign-${a}`} aria-pressed={v.valign === a}
            title={t(`amxsec.align.${a}`)} aria-label={t(`amxsec.align.${a}`)} onMouseDown={act((view, pos) => setSectionStyle(view, pos, { valign: a }))}>
            <Icon size={14} />
          </button>
        ))}
      </div>
      <div className="amx-sec-tb-group">
        <button type="button" className="amx-sec-tb-btn" data-act="cards" aria-pressed={v.cards} title={t('amxsec.cards')}
          onMouseDown={act((view, pos) => setSectionStyle(view, pos, { cards: !v.cards }))}>
          <LayoutGrid size={14} /><span>{t('amxsec.cards')}</span>
        </button>
        <button type="button" className="amx-sec-tb-btn" data-act="more" aria-haspopup="menu" aria-expanded={open === 'more'} title={t('amxsec.more')} aria-label={t('amxsec.more')} onMouseDown={toggle('more')}>
          <Ellipsis size={14} />
        </button>
      </div>
      {open === 'bg' && (
        <div className="amx-sec-pop amx-sec-pop-bg" role="dialog" aria-label={t('amxsec.bg')}>
          <button type="button" className="amx-sec-pop-row" data-act="bg-theme" onMouseDown={act((view, pos) => setSectionStyle(view, pos, { bg: '' }))}>
            <i className="amx-sec-swatch" data-sec-bg="theme" /><span>{t('amxsec.bgTheme')}</span>{!v.bg && <Check size={14} />}
          </button>
          <div className="amx-sec-pop-grid">
            {BLOCK_BG_COLORS.map((c) => (
              <button key={c.v} type="button" data-act={`bg-${c.v}`} title={t(c.nameKey)} aria-label={t(c.nameKey)} aria-pressed={v.bg === c.v}
                onMouseDown={act((view, pos) => setSectionStyle(view, pos, { bg: c.v }))}>
                <i style={{ background: c.swatch }} />{v.bg === c.v && <Check size={12} />}
              </button>
            ))}
          </div>
        </div>
      )}
      {open === 'more' && (
        <div className="amx-sec-pop amx-sec-pop-more" role="menu" aria-label={t('amxsec.more')}>
          <button type="button" role="menuitemcheckbox" aria-checked={v.stack} className="amx-sec-pop-row" data-act="stack"
            onMouseDown={act((view, pos) => setSectionStyle(view, pos, { stack: !v.stack }))}>
            <span>{t('amxsec.stack')}</span>{v.stack && <Check size={14} />}
          </button>
          <button type="button" role="menuitem" className="amx-sec-pop-row" data-act="remove" onMouseDown={act((view, pos) => { removeSection(view, pos); view.focus() })}>
            <span>{t('amxsec.remove')}</span>
          </button>
        </div>
      )}
    </div>,
    s.el,
  )
}
