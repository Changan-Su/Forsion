/**
 * 系统还原后回到原处(2026-11-02)。安卓在后台回收内存时会杀掉整个进程或 WebView 的渲染进程,人回来看到的是重载过的页面。
 * 回到上次的 Space 由 spaces.tsx 的 resolveStartupTarget 按 launchRestored 定(各 Space 开着的页本来就随布局存着);这里补三样:
 * 两级导航里人在不在里面那一页(冷启动一律落列表层)、开着的会话、输入框里没发出去的字。
 * 只在系统还原时放回去 —— 用户自己新开照旧进主页、空白新对话。附件不存(base64,太大);长粘贴是纯文本,存。
 * 人一碰屏幕(或按键)就不再替他还原:会话列表 / 落点晚到时,不许把他正在做的事顶掉。
 *
 * ⚠️ 不能只在退到后台那一下存:WebView 的 localStorage 隔几秒才落盘,刚切走就被杀(模拟器 am kill 实测)这一下就丢了。
 * 所以三样东西一变就存(1s 节流),切走时再补一次。
 */
import { listFirstNow, useSpaceStore, useWorkspace } from '@lcl/engine'
import { launchRestored } from '@/spaces'
import { useApp } from '@/stores/appStore'
import { readTanguDrafts } from '@/amadeus/plugins/tanguSeam'

const KEY = 'forsion_restore_v1'

interface Snapshot { activeId: string | null; drafts: Record<string, string>; pastes?: Record<string, string[]>; onMain?: boolean }

/** 还原还在等(会话列表 / 落点)时人动了手:之后的还原步骤一律作罢。 */
let tookOver = false

function save(): void {
  const drafts: Record<string, string> = {}
  const pastes: Record<string, string[]> = {}
  for (const [key, d] of Object.entries(readTanguDrafts()?.read() ?? {})) {
    if (d.text) drafts[key] = d.text
    if (d.pastes.length) pastes[key] = d.pastes
  }
  const snap: Snapshot = { activeId: useApp.getState().activeId, drafts, pastes, onMain: listFirstNow() && !useWorkspace.getState().leftVisible }
  try { localStorage.setItem(KEY, JSON.stringify(snap)) } catch { /* 存不下:照旧只是回不到原处 */ }
}

function read(): Snapshot | null {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null') as Snapshot | null } catch { return null }
}

export function installRestoreSnapshot(): void {
  if (!window.tangu?.mobile) return
  // 先读后挂:挂上之后的第一次存就会盖掉它。
  const snap = launchRestored() ? read() : null

  let timer = 0
  const later = (): void => { if (!timer) timer = window.setTimeout(() => { timer = 0; save() }, 1000) }
  readTanguDrafts()?.subscribe(later)
  useApp.subscribe((s, p) => { if (s.activeId !== p.activeId) later() })
  useWorkspace.subscribe((s, p) => { if (s.leftVisible !== p.leftVisible) later() })
  document.addEventListener('visibilitychange', () => { if (document.hidden) save() })
  window.addEventListener('pagehide', save)

  if (!snap) return
  const takeOver = (): void => { tookOver = true }
  for (const ev of ['pointerdown', 'keydown'] as const) window.addEventListener(ev, takeOver, { capture: true, once: true })
  const drafts = readTanguDrafts()
  for (const key of new Set([...Object.keys(snap.drafts ?? {}), ...Object.keys(snap.pastes ?? {})])) {
    drafts?.fill(key, { text: snap.drafts?.[key] ?? '', pastes: snap.pastes?.[key] ?? [] })
  }
  if (snap.onMain) backIntoMain()
  // 会话:列表是异步拉的,本窗口首次连上时还会兜底选第一条(appStore.connect)—— 那不是人选的,照样换回上次那条;
  // 上次是空白新对话(null)就等兜底选完再换回空白。
  const want = snap.activeId
  const settle = (): boolean => {
    if (tookOver) return true
    const a = useApp.getState()
    if (want === null) {
      if (!a.activeId) return false
      a.setActiveId(null, { revealWorkspace: false })
      return true
    }
    if (!a.sessions.some((s) => s.id === want)) return false
    if (a.activeId !== want) a.setActiveId(want, { revealWorkspace: false })
    return true
  }
  if (settle()) return
  const off = useApp.subscribe(() => { if (settle()) off() })
  // ponytail: 30s 还没拉到(离线 / 会话已删 / 一条会话都没有)就算了。
  window.setTimeout(off, 30_000)
}

/** 回到里面那一页:等宿主冷启动落到列表层(landOnList)之后,收起列表 = 进主区,返回照旧回列表。
 *  落列表层在启动时会连着来不止一下(布局还原、Space 交接各一次,同一拍里),所以看到落下后再等一小会儿才进。 */
function backIntoMain(): void {
  const space = useSpaceStore.getState().activeSpaceId
  const landed = (): boolean => !tookOver && useSpaceStore.getState().activeSpaceId === space && useWorkspace.getState().leftVisible && listFirstNow()
  // ponytail: 250ms 是看台架(两下落点隔 ~1ms)估的余量;晚到的落点再多就要换成宿主报「落定了」。
  const enter = (): void => { window.setTimeout(() => { if (landed()) useWorkspace.getState().toggleSidebar('left') }, 250) }
  if (landed()) { enter(); return }
  const off = useWorkspace.subscribe(() => {
    if (useSpaceStore.getState().activeSpaceId !== space) { off(); return } // 人已经换了 Space:不再替他进里面那页
    if (landed()) { off(); enter() }
  })
  window.setTimeout(off, 10_000) // 落到的 Space 没有列表层(主页 / 日历)就永远等不到,10s 后不再等
}
