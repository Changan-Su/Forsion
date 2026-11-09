// @vitest-environment happy-dom
/**
 * 页内反馈通道(feedbackChannel.ts,2026-11-09):网页主入口 / 手机的反馈入口等 Forsion Extend 把通道交来才注册。
 * 钉住的口径:① 交来 → 挂成 window.tangu.submitFeedback、Ribbon 图标落在商店后面、命令面板有「反馈」、派 forsion:feedback-channel;
 * ② 桌面(桥上本来就有通道,或桥是冻住的)不接,原来那个不动;③ 撤回只认交的那个插件,撤掉后键 / 图标 / 命令都没了;
 * ④ 用户排过下区:插在商店后面,已有位置不动,不在这里跑桌面老存档那条一次性迁移。
 * 负对照:去掉 provideFeedbackChannel 里「桥上已有就不接」那行 → ② 红;installFeedbackIcon(late) 不带 after → ① 的顺序那条红;
 * 撤回不判 provider → ③ 的「别人撤不掉」红;撤回改回 removeRibbonIcon → 「撤回再交来」红。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { rankIds, useCommandStore, useRibbonStore } from '@lcl/engine'
import { useApp } from './stores/appStore'
import { FEEDBACK_CHANNEL_EVENT, installFeedbackCommand, installFeedbackIcon, provideFeedbackChannel, resetFeedbackChannelForTest, type SubmitFeedback } from './feedbackChannel'

type Bridge = { submitFeedback?: SubmitFeedback }
const win = window as unknown as { tangu?: Bridge }
const submit: SubmitFeedback = async () => ({ ok: true, id: 'T-1' })
const base = ['rb-mode', 'rb-market', 'rb-cmd', 'rb-settings'].map((id) => ({ id, side: 'bottom' as const }))
const shown = (): string[] => { const s = useRibbonStore.getState(); return rankIds(s.items.filter((i) => i.side === 'bottom').map((i) => i.id), s.bottomOrder) }
const hasCommand = (): boolean => useCommandStore.getState().commands.some((c) => c.id === 'open-feedback')
let events = 0
window.addEventListener(FEEDBACK_CHANNEL_EVENT, () => { events++ })

beforeEach(() => {
  localStorage.clear()
  resetFeedbackChannelForTest()
  useRibbonStore.setState({ items: base, bottomOrder: [], folders: [] })
  useCommandStore.getState().removeCommand('open-feedback')
  useApp.setState({ feedbackOpen: false })
  win.tangu = {}
  events = 0
})

describe('provideFeedbackChannel', () => {
  it('交来:挂成 submitFeedback,图标落在商店后面,命令面板有「反馈」,派事件', () => {
    expect(provideFeedbackChannel('forsion-extend', submit)).toBe(true)
    expect(win.tangu!.submitFeedback).toBe(submit)
    expect(shown()).toEqual(['rb-mode', 'rb-market', 'rb-feedback', 'rb-cmd', 'rb-settings'])
    expect(hasCommand()).toBe(true)
    expect(events).toBe(1)
  })

  it('桌面自己有通道:不接,原来那个不动,也不重复注册入口', () => {
    const native: SubmitFeedback = async () => ({ ok: true })
    win.tangu = { submitFeedback: native }
    expect(provideFeedbackChannel('forsion-extend', submit)).toBe(false)
    expect(win.tangu.submitFeedback).toBe(native)
    expect(shown()).not.toContain('rb-feedback')
    expect(events).toBe(0)
  })

  it('桥是冻住的(contextBridge)/ 没有桥 / 交的不是函数:不算', () => {
    win.tangu = Object.freeze({}) as Bridge
    expect(provideFeedbackChannel('forsion-extend', submit)).toBe(false)
    expect(shown()).not.toContain('rb-feedback')
    delete win.tangu
    expect(provideFeedbackChannel('forsion-extend', submit)).toBe(false)
    win.tangu = {}
    expect(provideFeedbackChannel('forsion-extend', 'nope' as never)).toBe(false)
    expect(win.tangu.submitFeedback).toBeUndefined()
  })

  it('撤回只认交的那个插件;撤掉后键 / 图标 / 命令都没了,开着的反馈页关掉;之后还能再交', () => {
    provideFeedbackChannel('forsion-extend', submit)
    useApp.setState({ feedbackOpen: true })
    expect(provideFeedbackChannel('third', null)).toBe(false)
    expect(win.tangu!.submitFeedback).toBe(submit)
    expect(provideFeedbackChannel('forsion-extend', null)).toBe(true)
    expect('submitFeedback' in win.tangu!).toBe(false)
    expect(shown()).not.toContain('rb-feedback')
    expect(hasCommand()).toBe(false)
    expect(useApp.getState().feedbackOpen).toBe(false)
    expect(events).toBe(2)
    expect(provideFeedbackChannel('forsion-extend', submit)).toBe(true)
    expect(shown()).toContain('rb-feedback')
    expect(hasCommand()).toBe(true)
  })

  it('没交过的插件撤回:桌面自己的通道不会被删', () => {
    const native: SubmitFeedback = async () => ({ ok: true })
    win.tangu = { submitFeedback: native }
    expect(provideFeedbackChannel('forsion-extend', null)).toBe(false)
    expect(win.tangu.submitFeedback).toBe(native)
  })

  it('用户排过下区:插在商店后面;已有位置不动;收纳夹里的不动', () => {
    useRibbonStore.setState({ bottomOrder: ['rb-settings', 'rb-market', 'rb-cmd'] })
    provideFeedbackChannel('forsion-extend', submit)
    expect(useRibbonStore.getState().bottomOrder).toEqual(['rb-settings', 'rb-market', 'rb-feedback', 'rb-cmd'])

    resetFeedbackChannelForTest(); win.tangu = {}
    useRibbonStore.setState({ items: base, bottomOrder: ['rb-feedback', 'rb-settings', 'rb-market'] })
    provideFeedbackChannel('forsion-extend', submit)
    expect(useRibbonStore.getState().bottomOrder).toEqual(['rb-feedback', 'rb-settings', 'rb-market'])
  })

  // Extend 更新 / 重载 = 撤回再交来(Codex 评审):用户摆的位置和收纳夹不能被这一来一回抹掉
  it('撤回再交来:用户排的位置、收进的收纳夹都还在', () => {
    useRibbonStore.setState({ bottomOrder: ['rb-feedback', 'rb-settings', 'rb-market'] })
    provideFeedbackChannel('forsion-extend', submit)
    provideFeedbackChannel('forsion-extend', null)
    expect(shown()).not.toContain('rb-feedback')
    expect(useRibbonStore.getState().bottomOrder).toEqual(['rb-feedback', 'rb-settings', 'rb-market'])
    provideFeedbackChannel('forsion-extend', submit)
    expect(shown()).toEqual(['rb-feedback', 'rb-settings', 'rb-market', 'rb-mode', 'rb-cmd'])

    resetFeedbackChannelForTest(); win.tangu = {}
    const folder = { id: 'f1', name: '夹', items: ['rb-feedback', 'rb-cmd'] }
    useRibbonStore.setState({ items: base, bottomOrder: ['rb-market', 'f1'], folders: [folder] as never })
    provideFeedbackChannel('forsion-extend', submit)
    provideFeedbackChannel('forsion-extend', null)
    provideFeedbackChannel('forsion-extend', submit)
    expect((useRibbonStore.getState().folders as Array<{ items: string[] }>)[0]!.items).toEqual(['rb-feedback', 'rb-cmd'])
    expect(useRibbonStore.getState().bottomOrder).toEqual(['rb-market', 'f1'])
  })

  it('晚到的那条路不跑桌面老存档的一次性迁移(那条会把反馈挪到商店前面)', () => {
    useRibbonStore.setState({ bottomOrder: ['rb-market', 'rb-cmd'] })
    provideFeedbackChannel('forsion-extend', submit)
    expect(useRibbonStore.getState().bottomOrder).toEqual(['rb-market', 'rb-feedback', 'rb-cmd'])
    expect(localStorage.getItem('forsion_ribbon_feedback_above_market')).toBe('1')
  })
})

describe('启动时注册(桌面)', () => {
  it('图标按注册序落位;老存档只挪一次到商店之前', () => {
    useRibbonStore.setState({ items: base.slice(0, 2), bottomOrder: ['rb-cmd', 'rb-market', 'rb-settings'] })
    installFeedbackIcon()
    installFeedbackCommand()
    expect(useRibbonStore.getState().bottomOrder).toEqual(['rb-cmd', 'rb-feedback', 'rb-market', 'rb-settings'])
    expect(hasCommand()).toBe(true)
    // 幂等:再调不重复挪
    useRibbonStore.setState({ bottomOrder: ['rb-market', 'rb-cmd'] })
    installFeedbackIcon()
    expect(useRibbonStore.getState().bottomOrder).toEqual(['rb-market', 'rb-cmd'])
  })
})
