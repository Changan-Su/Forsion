/** 塞进引擎**左侧属性面板**的那几行。用户的原话:「把笔触切换放到笔工具的二级菜单」
 *  「图形切换放到二级菜单」—— 这里的「二级菜单」= 每个工具各有一份的那个属性面板(改颜色那个),
 *  不是弹出菜单。所以合并按钮不带下拉:换成员一律来这儿。
 *
 *  挂法见 ExcalidrawCanvas 的 useEngineAnchor:往 `.selected-shape-actions`(常规档)或
 *  `.compact-shape-actions`(紧凑档)插一个锚点再 portal 进去。面板每换一次工具就重挂一次,
 *  所以锚点必须由 MutationObserver 补,不能只插一次。
 *
 *  markup 刻意照抄引擎自己的 `fieldset > legend + .buttonList`:常规档直接吃它的排版,
 *  我们只在 amadeus-host.css 里补紧凑档的两列几何。
 */
import PenRow, { setPenCap, type PenState } from './PenRow'
import {
  LINE_LABELS,
  LINE_MEMBERS,
  SHAPE_LABELS,
  SHAPE_MEMBERS,
  type GroupState,
  type LineMember,
  type ShapeMember,
} from './BoardToolbar'
import { ArrowRight, Circle, Diamond, Minus, Square } from 'lucide-react'
import { registerMessages, useI18n } from '../../../i18n'
import type { BoardUi } from './boardUi'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

registerMessages({
  'panelextras.secPen': { zh: '笔', en: 'Pen' },
  'panelextras.secStroke': { zh: '笔触', en: 'Stroke' },
  'panelextras.capRound': { zh: '圆头', en: 'Round cap' },
  'panelextras.capButt': { zh: '方头', en: 'Flat cap' },
  'panelextras.secShape': { zh: '形状', en: 'Shape' },
  'panelextras.secLine': { zh: '线', en: 'Line' },
})

const SHAPE_ICON: Record<ShapeMember, typeof Square> = { rectangle: Square, diamond: Diamond, ellipse: Circle }
const LINE_ICON: Record<LineMember, typeof Square> = { arrow: ArrowRight, line: Minus }

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <fieldset className="amx-panelsec">
      <legend>{title}</legend>
      {children}
    </fieldset>
  )
}

export default function PanelExtras({
  api,
  ui,
  pen,
  group,
}: {
  api: ExcalidrawImperativeAPI | null
  ui: BoardUi
  pen: React.RefObject<PenState>
  group: React.RefObject<GroupState>
}): React.JSX.Element | null {
  // ⚠️ hook 必须在 `if (!api)` 早退之前:本组件原先一个 hook 都没有,切语言时它不会自己重渲染
  //    (连 BoardToolbar 那两张 getter 表也要等父级重渲染才跟上)。订上 useI18n 顺带把这个补齐。
  const { t } = useI18n()
  if (!api) return null
  // 本地的当前工具改叫 tool —— `t` 让给 useI18n。
  const tool = ui.tool

  if (tool === 'freedraw') {
    // 荧光笔专属:端头方/圆。只这一支给 —— 其余六支的手感是插件调了很多版的,别乱加旋钮。
    // 宽度仍然用引擎自带那 5 档(用户明确要保留),所以这里不碰它。
    const hl = pen.current.active === 'highlighter'
    return (
      <>
        <Section title={t('panelextras.secPen')}>
          <PenRow api={api} ui={ui} state={pen} />
        </Section>
        {hl && (
          <Section title={t('panelextras.secStroke')}>
            <div className="amx-panelrow buttonList">
              {([false, true] as const).map((round) => {
                const on = ui.capRound === round
                const capLabel = round ? t('panelextras.capRound') : t('panelextras.capButt')
                return (
                  <label
                    key={String(round)}
                    className={on ? 'active' : ''}
                    title={capLabel}
                    data-on={on || undefined}
                    onClick={() => setPenCap(api, round)}
                  >
                    {/* 图标就是端头本身:strokeLinecap butt=方 / round=圆,一眼认得出 */}
                    <svg width="18" height="18" viewBox="0 0 18 18" aria-label={capLabel}>
                      <line x1="4" y1="9" x2="14" y2="9" stroke="currentColor" strokeWidth="7" strokeLinecap={round ? 'round' : 'butt'} />
                    </svg>
                  </label>
                )
              })}
            </div>
          </Section>
        )}
      </>
    )
  }

  if ((SHAPE_MEMBERS as readonly string[]).includes(tool)) {
    return (
      <Section title={t('panelextras.secShape')}>
        <div className="amx-panelrow buttonList">
          {SHAPE_MEMBERS.map((m) => {
            const Icon = SHAPE_ICON[m]
            const on = tool === m
            return (
              <label
                key={m}
                className={on ? 'active' : ''}
                title={SHAPE_LABELS[m]}
                data-on={on || undefined}
                onClick={() => {
                  group.current.shape = m
                  api.setActiveTool({ type: m })
                }}
              >
                <Icon size={16} aria-label={SHAPE_LABELS[m]} />
              </label>
            )
          })}
        </div>
      </Section>
    )
  }

  if ((LINE_MEMBERS as readonly string[]).includes(tool)) {
    return (
      <Section title={t('panelextras.secLine')}>
        <div className="amx-panelrow buttonList">
          {LINE_MEMBERS.map((m) => {
            const Icon = LINE_ICON[m]
            const on = tool === m
            return (
              <label
                key={m}
                className={on ? 'active' : ''}
                title={LINE_LABELS[m]}
                data-on={on || undefined}
                onClick={() => {
                  group.current.line = m
                  api.setActiveTool({ type: m })
                }}
              >
                <Icon size={16} aria-label={LINE_LABELS[m]} />
              </label>
            )
          })}
        </div>
      </Section>
    )
  }

  return null
}
