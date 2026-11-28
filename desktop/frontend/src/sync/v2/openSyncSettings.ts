/**
 * 「同步设置…」的唯一入口(智库同步第 2 步,契约 §3.10「入口改道」、U-1 第 6 条):
 *   完整模式 → 设置窗口的同步页,可带 focus 定位到那个库那一行(右键时还带上点的那一项,页面替它算关联闭包、勾好)。
 *   其余     → 今天的去处:蓬洲云的同步页(Extend 在),或设置 › 同步(老的 RemoteSyncSection)。
 * 设置是独立的浮窗(另一个渲染进程),focus 经浮窗的 params 传过去(FloatingRoot → SettingsModal → SyncSettings);
 * 窗内设置(没有浮窗的宿主)走模块里的一次性交接。
 */
import { openPenzorSync, penzorSyncReady } from '../../services/syncSetup'
import { useApp } from '../../stores/appStore'
import { isDesktopExtendOff, isFullSync, isLegacySync } from './mode'
import type { ScopeItemKind } from './types'

export interface SyncFocus {
  /** 本机库根(绝对路径);缺 = 不定位 */
  root?: string
  /** 库内相对路径:右键点的那一项(页面把它和它的关联项加进范围、出汇总卡) */
  path?: string
  kind?: ScopeItemKind
  /** 'start' = 首登卡片点了「开始同步」:这个库直接走打开同步的流程(出汇总卡) */
  intent?: 'add' | 'start'
}

let pending: SyncFocus | null = null
/** 窗内设置挂载时取一次(取完清掉)。 */
export function takePendingSyncFocus(): SyncFocus | null {
  const f = pending
  pending = null
  return f
}

/** 浮窗 params 里的 syncFocus → SyncFocus(别的窗口传来的,逐个字段核类型)。 */
export function parseSyncFocus(v: unknown): SyncFocus | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const kind = o.kind === 'folder' || o.kind === 'file' || o.kind === 'page' ? o.kind : undefined
  const intent = o.intent === 'add' || o.intent === 'start' ? o.intent : undefined
  return {
    ...(typeof o.root === 'string' && o.root ? { root: o.root } : {}),
    ...(typeof o.path === 'string' && o.path ? { path: o.path } : {}),
    ...(kind ? { kind } : {}),
    ...(intent ? { intent } : {}),
  }
}

export function openSyncSettings(focus?: SyncFocus): void {
  if (!isFullSync()) {
    // 旧同步明确在管才去蓬洲云的同步页;停用 / 读不出 / 还没问出来 → 设置 › 同步(那里写清楚是怎么回事)
    if (isLegacySync() && !isDesktopExtendOff() && penzorSyncReady()) openPenzorSync()
    else useApp.getState().openSettings('sync')
    return
  }
  const app = useApp.getState()
  if (window.tangu?.openFloatingPanel) {
    // 每次换一个 nonce:设置开着、用户翻到别的页时再点,也要回到同步页那一行(同 appStore.openSettings)
    void window.tangu.openFloatingPanel({
      id: 'settings', title: app.tr('settings.title'), builtin: 'settings',
      params: { tab: 'sync', skillKey: null, nonce: Date.now() + Math.random(), ...(focus ? { syncFocus: focus } : {}) },
    })
    return
  }
  pending = focus ?? null
  app.openSettings('sync')
}
