/** 白板属性面板的形态偏好。两档是引擎(zsviczian fork)自己的口径:
 *  full = 左侧竖条属性岛(上游原样) / compact = 贴左边缘的折叠竖条,分组折进弹层。
 *
 *  ⚠️ 引擎还有第三档 `tray`(贴工具栏的托盘),2026-08-14 **按用户要求下线**:它没有左上槽,
 *     自定义笔排/工具栏得为它单独排一套竖版几何,收益不值。存过 'tray' 的老用户不在 MODES 里,
 *     读的时候自然回落到默认(compact)—— 不需要专门写迁移。
 *
 *  这是**显示偏好**不是文档内容 → 全局一份,localStorage;多个白板同时开着要一起变,
 *  所以走 useSyncExternalStore 而不是各自的 useState。
 *  单独成文件是为了断开环:forkRuntime(引擎装载,带 top-level await)要读它,而画布要 import 引擎。
 */
export type BoardUiMode = 'full' | 'compact'

const KEY = 'amx.boardUiMode'
const subs = new Set<() => void>()
const MODES: BoardUiMode[] = ['full', 'compact']

/** 内存态优先:localStorage 写不进去(隐私模式/配额满)时,开关本次会话内仍然生效 —— 只落在 storage 上
 *  的话,通知发出去 React 回读的还是旧值,表现就是「选了没反应」。 */
let mem: BoardUiMode | null = null

export const getBoardUiMode = (): BoardUiMode => {
  if (mem) return mem
  try {
    const v = localStorage.getItem(KEY) as BoardUiMode | null
    if (v && MODES.includes(v)) return v
    // 07-30~08-13 的老开关(布尔「紧凑面板」)。勾过的人别在换引擎那天被静默打回常规。
    if (localStorage.getItem('amx.boardCompact') === '1') return 'compact'
  } catch {
    /* 读不到就用默认 */
  }
  return 'compact' // 出厂档:属性面板收成窄条,把宽度让给画布
}

export const setBoardUiMode = (v: BoardUiMode): void => {
  mem = v
  try {
    localStorage.setItem(KEY, v)
  } catch {
    /* 存不下就只活在本次会话 */
  }
  for (const f of subs) f()
}

export const subscribeBoardUiMode = (f: () => void): (() => void) => {
  subs.add(f)
  return () => subs.delete(f)
}

// 多窗口(desktop 支持开多个窗口)/多标签页:`storage` 只在**别的** document 里触发,正好用来
// 把本窗口的内存态作废、回落去读新值。少了这条,窗口 A 改完窗口 B 一直用旧值(而且它自己的 mem
// 会把 storage 里的新值遮住,连刷新 store 都救不回来,只能整页重载)。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return
    mem = null
    for (const f of subs) f()
  })
}
