/**
 * 安卓 Space 快捷方式(2026-08-20)。三件事,原生那半在 SpaceShortcutsPlugin.java:
 *
 *  ① **长按 app 图标 = Space 列表**:把已注册的 Space 发布成动态快捷方式,点一条直接进那个 Space。
 *     顺序 = 最近用过的排前面(用户拍板)——系统对条数有硬上限(通常 4~5),排序决定谁留在名单里。
 *  ② **固定到桌面**:长按左抽屉底部的 Space 标签 → 走引擎的 pin 接缝 → 系统弹自己的确认框。
 *     (安卓也允许把 ① 那张列表里的一条直接拖到桌面,两条路都通。)
 *  ③ **接住点击**:冷启读 App.getLaunchUrl(),热启听 appUrlOpen,`tangu://space?id=…` → setActiveSpace。
 *
 * ⚠️ 冷启走的是**热路径** setActiveSpace(存出当前布局 → 换 id → 还原目标 Space 的命名布局),
 *    不是 setActiveSpaceCold。代价是启动时会闪一下上一个 Space。不这么做的话就得在模块装载前
 *    改写 `forsion_tangu_active_space` —— 那正是 spaceRegistry 里 BOOT_ACTIVE_SPACE_ID 注释
 *    钉着的那条坑(上一程的布局会被归档到别人名下)。
 *    ponytail: 要消掉这一闪,得让启动序列在 installEngine 之前 await 一次 getLaunchUrl,
 *    再用 setActiveSpaceCold + adoptSpaceLayoutCold 走冷路径;等有人真嫌闪再说。
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import { App } from '@capacitor/app'
import { useSpaceStore, setActiveSpace, setSpacePinHandler, label } from '@lcl/engine'

interface SpaceShortcutsPlugin {
  setSpaces(o: { spaces: Array<{ id: string; label: string }> }): Promise<{ published: number; max: number }>
  pin(o: { id: string; label: string }): Promise<{ requested: boolean }>
}
const Native = registerPlugin<SpaceShortcutsPlugin>('SpaceShortcuts')

/** 「最近用过」名册。只影响长按菜单的排序,丢了也不影响功能,故不进 Preferences。 */
const MRU_KEY = 'forsion_space_mru'
function readMru(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(MRU_KEY) || '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}
function bumpMru(id: string): void {
  if (!id) return
  try { localStorage.setItem(MRU_KEY, JSON.stringify([id, ...readMru().filter((x) => x !== id)].slice(0, 12))) } catch { /* ignore */ }
}

let timer: number | null = null
/** 发布(防抖):Space 是一个个 registerSpace 进来的,启动瞬间会连打好几发。 */
function publishSoon(): void {
  if (timer !== null) window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    timer = null
    const spaces = useSpaceStore.getState().spaces
    const mru = readMru()
    // 不在名册里的排最后,彼此保持注册序(Array.sort 稳定)。
    const rank = (id: string): number => { const i = mru.indexOf(id); return i < 0 ? Number.MAX_SAFE_INTEGER : i }
    const ordered = [...spaces].sort((a, b) => rank(a.id) - rank(b.id))
    void Native.setSpaces({
      spaces: ordered.map((s) => ({ id: s.id, label: label(s.name) })),
    }).catch(() => { /* 老系统 / 权限受限:静默 */ })
  }, 300)
}

/** 同一条 URL 在 3 秒内只认一次:冷启时 getLaunchUrl 与 appUrlOpen 会为同一个 intent 各响一发。
 *  时间窗而不是永久去重 —— 用户连点两次同一个桌面图标,第二次也该真的切回去。 */
let last = { url: '', t: 0 }
function applyUrl(url: string | null | undefined): void {
  if (!url || !/^tangu:\/\/space\b/i.test(url)) return
  const now = Date.now()
  if (url === last.url && now - last.t < 3000) return
  last = { url, t: now }
  try {
    const id = new URL(url).searchParams.get('id')
    if (id) setActiveSpace(id) // 未注册的 id 在 store 里本来就是 no-op,不用自己再判一次
  } catch { /* 畸形 URL:忽略 */ }
}

let installed = false
export function installSpaceShortcuts(): void {
  if (installed || !Capacitor.isNativePlatform()) return
  installed = true

  publishSoon()
  useSpaceStore.subscribe((s, prev) => {
    if (s.activeSpaceId !== prev.activeSpaceId) bumpMru(s.activeSpaceId)
    // 名单变了(含用户 L0 Space 异步注册进来)或用过的顺序变了 → 重发。
    if (s.spaces !== prev.spaces || s.activeSpaceId !== prev.activeSpaceId) publishSoon()
  })
  bumpMru(useSpaceStore.getState().activeSpaceId)

  void App.getLaunchUrl().then((r) => applyUrl(r?.url)).catch(() => { /* ignore */ })
  void App.addListener('appUrlOpen', ({ url }) => applyUrl(url))

  // 长按左抽屉底部的 Space 标签 → 系统的「添加到桌面」确认框。UI 一个都不用自己画。
  setSpacePinHandler((id, name) => { void Native.pin({ id, label: name }).catch(() => { /* ignore */ }) })
}
