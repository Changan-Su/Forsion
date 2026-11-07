/** 工具岛:「拿着一件工具干活」的视图(PDF 批注、白板一类)换工具用的那颗胶囊。皮同 Mini 窗顶栏的胶囊
 *  (.mini-card-cap),选中态是一枚滑过去的底块,按钮右下角的小字母是快捷键(只画,不绑键)。
 *  这里只画按钮条;停在哪(顶部居中 / 窄了停底部)、条下那一排、四角的小岛用 toolIsland.css 的布局类摆,
 *  插件走 ctx.ui.mountToolIsland(宿主那半在 amadeus/plugins/toolIslandSurface.tsx)。
 *  选中受控:点按钮只调 onPick,换不换 active 由调用方定。 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { tooltipProps } from './Tooltip'
import './toolIsland.css'

export interface ToolIslandTool {
  id: string
  icon: ReactNode
  title: string
  /** 快捷键,画在按钮右下角。 */
  key?: string
}
export type ToolIslandItem = ToolIslandTool | 'separator'

export function ToolIsland({ tools, active, onPick }: { tools: ToolIslandItem[]; active?: string; onPick(id: string): void }): React.ReactElement {
  const bar = useRef<HTMLDivElement>(null)
  const thumb = useRef<HTMLSpanElement>(null)
  const placed = useRef(false)
  const activeRef = useRef(active)
  activeRef.current = active
  // 每次渲染都量:按钮间有分隔线,位置不能按序号算。第一次落位(含隐藏后再出现)直接到位,之后才滑。
  // 视图藏在背景标签里时(Dockview 把它摘出文档、React 树还在)量出来是 0:不落位,等条有了尺寸再量。
  const measure = useCallback(() => {
    const b = bar.current, t = thumb.current
    if (!b || !t) return
    const btn = [...b.querySelectorAll<HTMLElement>('[data-tool]')].find((el) => el.dataset.tool === activeRef.current)
    if (!btn) { t.hidden = true; placed.current = false; return }
    if (!btn.offsetWidth) { placed.current = false; return }
    t.hidden = false
    if (!placed.current) t.style.transition = 'none'
    t.style.transform = `translateX(${btn.offsetLeft}px)`
    t.style.width = `${btn.offsetWidth}px`
    if (!placed.current) { void t.offsetWidth; t.style.transition = ''; placed.current = true }
  }, [])
  useLayoutEffect(measure)
  useEffect(() => {
    const b = bar.current
    if (!b || typeof ResizeObserver !== 'function') return
    const ro = new ResizeObserver(() => { if (!placed.current) measure() })
    ro.observe(b)
    return () => ro.disconnect()
  }, [measure])
  return (
    <div ref={bar} className="lcl-isle-cap lcl-isle" role="toolbar">
      <span ref={thumb} className="lcl-isle-thumb" aria-hidden="true" />
      {tools.map((t, i) => {
        if (t === 'separator') return <span key={`sep:${i}`} className="lcl-isle-sep" role="separator" />
        const tip = tooltipProps(t.title)
        const on = t.id === active
        return (
          <button
            key={`tool:${t.id}`}
            type="button"
            className="lcl-isle-btn"
            data-tool={t.id}
            data-on={on || undefined}
            aria-label={t.title}
            aria-pressed={on}
            aria-keyshortcuts={t.key}
            {...tip}
            // 鼠标点不抢焦点:焦点留在视图里,视图自己的快捷键(和按住空格)照样有人听;键盘用户 Tab 进来的焦点不受影响
            onMouseDown={(e) => { e.preventDefault(); tip.onMouseDown(e) }}
            onClick={() => onPick(t.id)}
          >
            {t.icon}
            {t.key ? <i aria-hidden="true">{t.key}</i> : null}
          </button>
        )
      })}
    </div>
  )
}
