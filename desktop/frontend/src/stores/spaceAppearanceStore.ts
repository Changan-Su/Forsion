import { create } from 'zustand'
import { normalizeSpaceAppearance, normalizeSpaceAppearanceUpdate, SPACE_APPEARANCE_PREFIX, type SpaceAppearance, type SpaceAppearanceUpdate } from '../../../shared/spaceAppearance'

function readOne(id: string): SpaceAppearance {
  try { return normalizeSpaceAppearance(JSON.parse(localStorage.getItem(SPACE_APPEARANCE_PREFIX + id) || '{}')) } catch { return {} }
}

function readAll(): Record<string, SpaceAppearance> {
  const out: Record<string, SpaceAppearance> = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(SPACE_APPEARANCE_PREFIX)) out[key.slice(SPACE_APPEARANCE_PREFIX.length)] = readOne(key.slice(SPACE_APPEARANCE_PREFIX.length))
    }
  } catch { /* no storage */ }
  return out
}

export const useSpaceAppearance = create<{ byId: Record<string, SpaceAppearance> }>(() => ({ byId: readAll() }))

/** 同源存储是唯一真源:内存只从它读。浏览器把各窗口的写入串行化,所以「最后保存的」就是存储里现在那份 ——
 *  不按消息载荷更新内存,晚到的旧消息就没有东西可盖。 */
function syncFromStorage(id: string): void {
  const next = readOne(id)
  const cur = useSpaceAppearance.getState().byId[id]
  if (JSON.stringify(cur ?? {}) === JSON.stringify(next)) return
  useSpaceAppearance.setState((s) => ({ byId: { ...s.byId, [id]: next } }))
}

/** 别的窗口发来的通知(IPC):**只当「这个 Space 变了」的信号**,不用它的值、也绝不落盘(发方已写进同源存储)。
 *  IPC 可能比存储传播先到,所以除了当场读一次,稍后再读一次;storage 事件到了也会再读。 */
export function receiveSpaceAppearance(raw: SpaceAppearanceUpdate): boolean {
  const update = normalizeSpaceAppearanceUpdate(raw)
  if (!update) return false
  syncFromStorage(update.id)
  setTimeout(() => syncFromStorage(update.id), 250)
  return true
}

/** 本窗用户动作:落盘(一次只写一个 Space,别的 Space 的并发编辑不受影响)→ 内存 → 广播。 */
export function setSpaceAppearance(id: string, appearance: SpaceAppearance): boolean {
  const update = normalizeSpaceAppearanceUpdate({ id, appearance })
  if (!update) return false
  try {
    const key = SPACE_APPEARANCE_PREFIX + id
    if (Object.keys(update.appearance).length) localStorage.setItem(key, JSON.stringify(update.appearance))
    else localStorage.removeItem(key)
  } catch { return false }
  syncFromStorage(id)
  try { window.tangu?.broadcastUi?.({ spaceAppearance: update }) } catch { /* browser */ }
  return true
}

// 浏览器标签页 / Electron 各窗口共用存储:别处写了哪个键,就把哪个 Space 重新读一遍。
if (typeof window !== 'undefined') window.addEventListener?.('storage', (event) => {
  if (event.key === null) { useSpaceAppearance.setState({ byId: readAll() }); return }
  if (event.key.startsWith(SPACE_APPEARANCE_PREFIX)) syncFromStorage(event.key.slice(SPACE_APPEARANCE_PREFIX.length))
})
