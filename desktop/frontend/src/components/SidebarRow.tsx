/**
 * 侧栏列表行 —— 会话 / 笔记 / 插件列表源**共用的唯一行组件**(2026-08-25 用户拍板:
 * 「注册到工作区 view 不应该重绘 UIUX」)。
 *
 * 它固化的是**结构与几何**,不是内容:
 *   [前导槽 .t2s-lead(图标/状态点/展开箭头)] [标题 .t2s-srow-title(或重命名 input)] [尾随 计数/日期]
 * 缩进走 treeIndent 的 rowPadLeft(depth),各家自己传 depth —— 这正是此前插件列表「大小宽度对不上」
 * 的根因:它自己拼了一套 DOM 和 padding。行为(点击/右键/拖拽/多选)由调用方经 props 透传,
 * 组件不夹带任何领域逻辑。
 */
import type { CSSProperties, DragEvent, MouseEvent, PointerEvent, ReactNode, Ref } from 'react'
import { rowPadLeft } from '@amadeus/lib/treeIndent'

export interface SidebarRowProps {
  /** 附加类(active / sel / dragging 等状态类各家自定,基类 .t2s-srow 由本组件负责)。 */
  className?: string
  /** 缩进层级(0=组头同级,1=组内行);给了 style.paddingLeft 则以后者为准。 */
  depth?: number
  style?: CSSProperties
  title?: string
  /** 前导槽内容:图标 + 可选状态点/展开箭头。缺省不渲染槽(与会话/笔记行不同结构 → 只在确无图标时用)。 */
  lead?: ReactNode
  /** 行主体:通常是标题文本;重命名态传 <input className="t2s-rename">。 */
  children: ReactNode
  /** 标题右侧:计数、日期、状态标签。 */
  trailing?: ReactNode
  onClick?(e: MouseEvent<HTMLDivElement>): void
  onDoubleClick?(e: MouseEvent<HTMLDivElement>): void
  onContextMenu?(e: MouseEvent<HTMLDivElement>): void
  onPointerDown?(e: PointerEvent<HTMLDivElement>): void
  draggable?: boolean
  onDragStart?(e: DragEvent<HTMLDivElement>): void
  onDragOver?(e: DragEvent<HTMLDivElement>): void
  onDragLeave?(e: DragEvent<HTMLDivElement>): void
  onDrop?(e: DragEvent<HTMLDivElement>): void
  onDragEnd?(e: DragEvent<HTMLDivElement>): void
  /** 多选判定要按 DOM 顺序找行(见 views/itemSelect),故选择键要落在行元素上。 */
  selId?: string
  /** 行元素标签。会话/笔记行历来是 <button>(键盘可达);行内含重命名 input 的形态必须用 'div'
   *  —— input 嵌在 button 里是无效 HTML。缺省 'div'。 */
  as?: 'div' | 'button'
  elRef?: Ref<HTMLElement>
}

export function SidebarRow({
  className, depth = 1, style, title, lead, children, trailing, selId, as = 'div', elRef, ...rest
}: SidebarRowProps) {
  const Tag = as as 'div'
  return (
    <Tag
      ref={elRef as Ref<HTMLDivElement>}
      className={`t2s-srow${className ? ` ${className}` : ''}`}
      data-sel-id={selId}
      title={title}
      style={{ paddingLeft: rowPadLeft(depth), ...style }}
      {...rest}
    >
      {lead !== undefined && <span className="t2s-lead">{lead}</span>}
      {children}
      {trailing}
    </Tag>
  )
}
