/**
 * 「引用刚才在用的窗口」命令:默认热键是同时按下左右两个 ⌘(mac)/ 两个 Ctrl(其它),设置 → 快捷键里能改、能关。
 * 取紧挨在 Forsion 后面的那扇窗口(没有带标题的窗口就退成那个应用),落到用户正在用的地方(10-14 用户定,同 ChatGPT):
 *   ① 光标在笔记里 → 写到光标处;② 光标在某张输入卡里 → 挂进它的「已选择」;③ 屏上有输入卡 → 挂进那张;
 *   ④ 都没有 → 开新会话(同 ⌘N;主区不放对话的 Space 里开在右侧对话面板),挂进新会话的输入卡。②③④ 之后光标都落在那张卡的输入框里,接着就能打字。
 * 只在有 `window.tangu.appRefs` 的宿主上注册;开机就注册(bootstrapEngine),不等第一张输入卡出现 ——
 * 否则停在没有输入卡的 Space 上启动时,全局那条订阅永远不会被要。
 * 两条路:Forsion 自己在前台时由窗口内的命令接(下面的 hotkey);别的应用在前台时由本机助手监听按键,经主进程把
 * 那一刻最前面的窗口送过来(electron/appRefHotkey.ts;助手太旧 / 没在跑时只剩前一条)。同一次按键只会走其中一条。
 */
import { addCommand, effectiveHotkey, MOD_PAIR, useCommandStore, useShortcuts } from '@lcl/engine'
import { appRefToken, normalizeAppRef, type AppRef } from '../../../../shared/appRefs'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'cmd.refFrontWindow': { zh: '引用刚才在用的窗口', en: 'Reference the window you were just using' },
})

/** Composer2 在自己的输入卡上听这个事件(detail = AppRef)。 */
export const APPREF_EVENT = 'forsion:appref-add'
export const APPREF_TARGET_ATTR = 'data-appref-target'

/** given = 主进程送来的那扇窗口(全局快捷键:这时最前面已经是 Forsion 自己,不能再去问「最前面是谁」)。
 *  booting = 主窗是被这次按键打开的(页面刚起来):先等它自己把对话视图摆出来,没有再开新会话。 */
export async function captureFrontWindow(given?: AppRef, booting = false): Promise<void> {
  const active = document.activeElement as HTMLElement | null
  const ref = given ?? await window.tangu?.appRefs?.frontmost().catch(() => null)
  if (!ref) return
  if (active?.isContentEditable && active.closest('.am-app')) {
    active.focus()
    document.execCommand('insertText', false, appRefToken(ref) + ' ')
    return
  }
  const target = cards().find((el) => el.contains(active)) ?? await cardOrNewSession(booting)
  target?.dispatchEvent(new CustomEvent(APPREF_EVENT, { detail: ref }))
}

const cards = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`[${APPREF_TARGET_ATTR}]`)]
const visibleCard = (): HTMLElement | undefined => cards().find((el) => el.getClientRects().length > 0)

/** ③ 屏上有输入卡就用它;④ 没有就开新会话(就是 ⌘N 那条命令),等它的输入卡挂上(最多约 4 秒)。
 *  主区不放对话的 Space(Amadeus 之类)里 ⌘N 那条摆不出对话,隔一秒再把右侧的对话面板打开 —— 它跟着
 *  当前会话走,这时已经是刚开的新会话。⌘N 每秒补跑(页面刚起来时工作区可能还没就绪,重复跑无害);
 *  对话面板只开一次:那条命令在面板已显示时是「收起」。同时到的几条共用一次等待,不各开各关。 */
let finding: Promise<HTMLElement | undefined> | null = null
const cardOrNewSession = (booting: boolean): Promise<HTMLElement | undefined> =>
  finding ??= findOrOpen(booting).finally(() => { finding = null })

async function findOrOpen(booting: boolean): Promise<HTMLElement | undefined> {
  const run = useCommandStore.getState().run
  let panel = false
  for (let i = 0; i < 40; i++) {
    const hit = visibleCard()
    if (hit) return hit
    const tick = i % 10 === (booting ? 9 : 0)
    if (tick) run('new-chat')
    if (tick && !panel && i >= (booting ? 19 : 10)) { panel = true; run('show-chat-panel') }
    await new Promise((r) => setTimeout(r, 100))
  }
  return undefined
}

let installed = false
export function ensureAppRefCommand(): void {
  if (installed || !window.tangu?.appRefs) return
  installed = true
  const cmd = { id: 'chat.reference-front-window', title: () => translate('cmd.refFrontWindow'), hotkey: MOD_PAIR, run: () => { void captureFrontWindow() } }
  addCommand(cmd)
  const api = window.tangu.appRefs
  api.onHotkey?.((raw) => { const ref = normalizeAppRef(raw); if (ref) void captureFrontWindow(ref) })
  // 主窗关着时按下的那一条(主进程替它存着):这个页面就是被它打开的
  void api.takePendingHotkey?.().then((raw) => { const ref = normalizeAppRef(raw); if (ref) void captureFrontWindow(ref, true) }, () => {})
  // 全局监听只在快捷键还是「双 ⌘」时要:用户在设置里改成别的键 / 解绑了,就让主进程断开那条订阅
  const sync = (): void => api.setGlobalHotkey?.(effectiveHotkey(cmd) === MOD_PAIR)
  sync()
  useShortcuts.subscribe(sync)
}
