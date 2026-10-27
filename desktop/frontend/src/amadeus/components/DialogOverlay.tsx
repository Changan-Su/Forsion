// 确认框 / 表单框的遮罩(.dialog-overlay > .dialog)。和 <div className="dialog-overlay"> 一样用,只多一件事:关掉(卸载)时
// 留一份替身放完 80ms 退场(lcl useExitGhost;样式在 amadeus/styles.css,走查续八 8.4)。
import { useRef, type HTMLAttributes } from 'react'
import { useExitGhost } from '@lcl/engine'

export function DialogOverlay({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null)
  useExitGhost(ref)
  return <div ref={ref} className={className ? `dialog-overlay ${className}` : 'dialog-overlay'} {...rest} />
}
