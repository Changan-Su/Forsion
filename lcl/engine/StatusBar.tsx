/** 底部状态栏(≈ Obsidian status bar):固定在窗口底,订阅 statusRegistry。 */
import { useStatusStore } from './statusRegistry'

export function StatusBar() {
  const items = useStatusStore((s) => s.items)
  const left = items.filter((i) => (i.side ?? 'left') === 'left')
  const right = items.filter((i) => i.side === 'right')
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
