/** 底部状态栏(≈ Obsidian status bar):固定在窗口底,订阅 statusRegistry。
 *  hidden/order 由宿主传入(用户在设置里管理);arrangeStatusItems 纯函数单独导出便于测试。 */
import { useStatusStore } from './statusRegistry'
import type { StatusItem } from './types'

/** 应用用户偏好:hidden 里的过滤掉;order 里出现的按其次序,未列出的保持注册序排在其后(稳定排序)。 */
export function arrangeStatusItems(items: StatusItem[], hidden?: string[], order?: string[]): StatusItem[] {
  const shown = hidden?.length ? items.filter((i) => !hidden.includes(i.id)) : [...items]
  if (!order?.length) return shown
  const pos = new Map(order.map((id, i) => [id, i]))
  return shown.sort((a, b) => (pos.get(a.id) ?? order.length) - (pos.get(b.id) ?? order.length))
}

export function StatusBar({ hidden, order }: { hidden?: string[]; order?: string[] } = {}) {
  const items = useStatusStore((s) => s.items)
  const arranged = arrangeStatusItems(items, hidden, order)
  const left = arranged.filter((i) => (i.side ?? 'left') === 'left')
  const right = arranged.filter((i) => i.side === 'right')
  return (
    <div className="sb">
      <div className="sb-group">
        {left.map((i) => {
          const C = i.component
          return (
            <div key={i.id} className="sb-item">
              <C />
            </div>
          )
        })}
      </div>
      <div className="sb-group sb-right">
        {right.map((i) => {
          const C = i.component
          return (
            <div key={i.id} className="sb-item">
              <C />
            </div>
          )
        })}
      </div>
    </div>
  )
}
