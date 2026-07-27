// 浮层逃生舱:把 position:fixed 的浮层(slash 菜单 / 行内工具栏 / 双链建议 / 块菜单)挂到最近的
// `.am-app` 下,而不是留在块自己的 DOM 位置。
//
// 为什么必须这样:CSS 里祖先一旦有 transform / filter / will-change:transform,它就成了后代
// position:fixed 的**包含块** —— 浮层的 left/top 不再是视口坐标,而是相对那个祖先,且被它的
// scale 一起缩放。思维导图画布(.mmv-canvas)正是靠 translate+scale 做平移缩放的,于是卡片里
// 打 '/' 或选中文字,菜单整体跑偏(用户实报)。坐标是 coordsAtPos 给的视口坐标,没有错;错的是
// 包含块。传送到 `.am-app`(视图根,恒无 transform)即回到视口坐标系,同时保住 `.am-app xxx`
// 的主题作用域选择器。笔记编辑器里祖先本就没有 transform → 行为完全不变。
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function OverlayPortal({ children }: { children: ReactNode }) {
  const anchor = useRef<HTMLSpanElement>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setHost((anchor.current?.closest('.am-app') as HTMLElement | null) ?? document.body)
  }, [])
  return (
    <>
      <span ref={anchor} hidden />
      {host && createPortal(children, host)}
    </>
  )
}
