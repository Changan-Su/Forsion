/**
 * 插件首启引导的状态与纪律(桌面壳侧;vendored pluginStore 不知道引导这回事):
 *  - 就绪卡只在「注意力在场」的时刻弹:设置页手动启用 / 市场装完 / 点「运行引导」。
 *    启动期自动激活(applyPref)不弹窗,只投一次 Inbox 提醒 + 设置页挂「待引导」徽标。
 *  - 完成态 localStorage `plugin.<id>.__setupDone`;Inbox 提醒一次性 `plugin.<id>.__setupNudged`。
 *  - version 计数器让设置页徽标在完成后即时消失(localStorage 本身无变更通知)。
 */
import { create } from 'zustand'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { useApp } from './appStore'
import { postInboxMessage } from '../services/backendService'
import type { AmadeusPlugin } from '@amadeus/plugins/types'

const doneKey = (id: string): string => `plugin.${id}.__setupDone`
const nudgedKey = (id: string): string => `plugin.${id}.__setupNudged`

export function isSetupDone(id: string): boolean {
  try { return localStorage.getItem(doneKey(id)) === '1' } catch { return false }
}

export function needsOnboarding(p: AmadeusPlugin): boolean {
  return !!p.onboarding && !p.blocked && !isSetupDone(p.id)
}

interface OnboardingState {
  /** 正在展示就绪卡的插件 id;null=关着。 */
  pluginId: string | null
  /** 完成态变更计数(徽标订阅它重渲)。 */
  version: number
  open(id: string): void
  close(): void
  markDone(id: string): void
}

export const usePluginOnboarding = create<OnboardingState>((set) => ({
  pluginId: null,
  version: 0,
  open: (id) => set({ pluginId: id }),
  close: () => set({ pluginId: null }),
  markDone: (id) => {
    try { localStorage.setItem(doneKey(id), '1') } catch { /* ignore */ }
    set((s) => ({ version: s.version + 1, pluginId: s.pluginId === id ? null : s.pluginId }))
  },
}))

/** 手动启用后的入口:启用成功且有待办引导才弹卡。返回是否弹了。 */
export function promptIfPending(id: string): boolean {
  const p = usePluginStore.getState().plugins.find((x) => x.id === id)
  if (!p || !needsOnboarding(p) || !usePluginStore.getState().activeIds.includes(id)) return false
  usePluginOnboarding.getState().open(id)
  return true
}

/** 一次性 Inbox 提醒(启动期发现待引导插件 / 用户跳过就绪卡时)。幂等:发过一次永不再发。 */
export function nudgeOnboardingOnce(p: AmadeusPlugin): void {
  if (!needsOnboarding(p)) return
  try {
    if (localStorage.getItem(nudgedKey(p.id)) === '1') return
    localStorage.setItem(nudgedKey(p.id), '1')
  } catch { return }
  const { cfg, tr } = useApp.getState()
  void postInboxMessage(cfg, {
    title: tr('plugin.onboarding.nudgeTitle', { name: p.name }),
    body: tr('plugin.onboarding.nudgeBody', { name: p.name }),
    sender_id: `plugin:${p.id}`,
  }).catch(() => { /* 后端不在(如纯 web)则安静放弃;徽标仍在 */ })
}
