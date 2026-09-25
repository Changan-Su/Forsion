/** 底部状态栏(≈ Obsidian status bar):固定在窗口底,订阅 statusRegistry。
 *  hidden/order 由宿主传入(用户在设置里管理);arrangeStatusItems 纯函数单独导出便于测试。 */
import { Fragment } from 'react'
import { useStatusStore } from './statusRegistry'
import type { StatusItem } from './types'

/** 应用用户偏好:hidden 里的过滤掉;order 里出现的按其次序,未列出的保持注册序排在其后(稳定排序)。
 *  trailing:**无自定义顺序时**被它判真的项(宿主传「插件项」)挪到末尾 —— 注册序由装载时序决定,
 *  插件项会夹在内置项中间;用户一旦自己排过序就完全按用户的来。 */
export function arrangeStatusItems(items: StatusItem[], hidden?: string[], order?: string[], trailing?: (i: StatusItem) => boolean): StatusItem[] {
  const shown = hidden?.length ? items.filter((i) => !hidden.includes(i.id)) : [...items]
  if (!order?.length) return trailing ? [...shown.filter((i) => !trailing(i)), ...shown.filter(trailing)] : shown
  const pos = new Map(order.map((id, i) => [id, i]))
  return shown.sort((a, b) => (pos.get(a.id) ?? order.length) - (pos.get(b.id) ?? order.length))
}

/** 一侧的渲染:trailing 与非 trailing 相邻处插一条分隔(两边都没有可见项时由 CSS 藏掉,见 engine.css .sb-sep)。 */
export function StatusSide({ list, trailing }: { list: StatusItem[]; trailing?: (i: StatusItem) => boolean }) {
  return (
    <>
      {list.map((i, k) => {
        const C = i.component
        const sep = !!trailing && k > 0 && trailing(list[k - 1]) !== trailing(i)
        return (
          <Fragment key={i.id}>
            {sep && <span className="sb-sep" aria-hidden="true" />}
            <div className="sb-item" data-sb-id={i.id}>
              <C />
            </div>
          </Fragment>
        )
      })}
    </>
  )
}

export function StatusBar({ hidden, order, trailing, label }: {
  hidden?: string[]
  order?: string[]
  /** 见 arrangeStatusItems;同时决定分隔线画在哪。 */
  trailing?: (i: StatusItem) => boolean
  /** 整条的可访问名(宿主传本地化文案)。 */
  label?: string
} = {}) {
  const items = useStatusStore((s) => s.items)
  const arranged = arrangeStatusItems(items, hidden, order, order?.length ? undefined : trailing)
  const left = arranged.filter((i) => (i.side ?? 'left') === 'left')
  const right = arranged.filter((i) => i.side === 'right')
  const sepBy = order?.length ? undefined : trailing
  return (
    <div className="sb" role="group" aria-label={label}>
      <div className="sb-group">
        <StatusSide list={left} trailing={sepBy} />
      </div>
      <div className="sb-group sb-right">
        <StatusSide list={right} trailing={sepBy} />
      </div>
    </div>
  )
}
