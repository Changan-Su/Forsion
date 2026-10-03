import { create } from 'zustand'
import { normalizeSpaceAppearance, normalizeSpaceAppearanceUpdate, SPACE_APPEARANCE_PREFIX, type SpaceAppearance, type SpaceAppearanceUpdate } from '../../../shared/spaceAppearance'

/** 每个 Space 最后一次已知更新的时间戳(存储值里的 `at`)。旧消息靠它拒收。 */
const stamps: Record<string, number> = {}
const stampOf = (raw: unknown): number => {
  const at = (raw as { at?: unknown } | null)?.at
  return typeof at === 'number' && Number.isSafeInteger(at) && at > 0 ? at : 0
}

function readAll(): Record<string, SpaceAppearance> {
  const out: Record<string, SpaceAppearance> = {}
  for (const id of Object.keys(stamps)) delete stamps[id]
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(SPACE_APPEARANCE_PREFIX)) continue
      try {
        const raw = JSON.parse(localStorage.getItem(key) || '{}')
        const id = key.slice(SPACE_APPEARANCE_PREFIX.length)
        out[id] = normalizeSpaceAppearance(raw)
        stamps[id] = stampOf(raw)
      } catch { /* ignore one corrupt entry */ }
    }
  } catch { /* no storage */ }
  return out
}

export const useSpaceAppearance = create<{ byId: Record<string, SpaceAppearance> }>(() => ({ byId: readAll() }))

/** 重放别处(IPC / storage 事件)的更新:**只进内存,绝不落盘** —— 发方已经写进同源存储,收方再写一遍会把
 *  晚到的旧消息盖到较新的保存上。比已知更旧的更新直接拒收(两条通道到达顺序不定)。 */
export function receiveSpaceAppearance(raw: SpaceAppearanceUpdate): boolean {
  const update = normalizeSpaceAppearanceUpdate(raw)
  if (!update) return false
  const { id, appearance } = update
  const at = update.at ?? 0
  if (at < (stamps[id] ?? 0)) return false
  stamps[id] = at
  useSpaceAppearance.setState((s) => ({ byId: { ...s.byId, [id]: appearance } }))
  return true
}

/** 本窗用户动作:落盘(一次只写一个 Space)+ 广播。恢复继承也写一条只带时间戳的空记录,不删键 ——
 *  删了就没处记「这次重置比那条旧消息新」。
 *  ponytail: 时间戳取本机墙钟(同机各窗口同一个钟,并保证比已知的大);要跨设备同步再换成主进程发号。 */
export function setSpaceAppearance(id: string, appearance: SpaceAppearance): boolean {
  const update = normalizeSpaceAppearanceUpdate({ id, appearance })
  if (!update) return false
  const at = Math.max(Date.now(), (stamps[id] ?? 0) + 1)
  try { localStorage.setItem(SPACE_APPEARANCE_PREFIX + id, JSON.stringify({ ...update.appearance, at })) } catch { return false }
  receiveSpaceAppearance({ ...update, at })
  try { window.tangu?.broadcastUi?.({ spaceAppearance: { ...update, at } }) } catch { /* browser */ }
  return true
}

// Browser tabs and Electron windows share storage; IPC carries the exact value when
// Chromium's storage propagation arrives after the settings window's notification.
if (typeof window !== 'undefined') window.addEventListener?.('storage', (event) => {
  if (event.key === null) { useSpaceAppearance.setState({ byId: readAll() }); return }
  if (!event.key.startsWith(SPACE_APPEARANCE_PREFIX)) return
  const id = event.key.slice(SPACE_APPEARANCE_PREFIX.length)
  // 键被外部删掉(本代码从不删键):以存储为准,回到继承全局。
  if (event.newValue === null) { delete stamps[id]; useSpaceAppearance.setState((s) => ({ byId: { ...s.byId, [id]: {} } })); return }
  try { const raw = JSON.parse(event.newValue); receiveSpaceAppearance({ id, appearance: raw, at: stampOf(raw) }) } catch { /* corrupt entry */ }
})
