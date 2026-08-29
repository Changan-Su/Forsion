/**
 * `ctx.tangu` 探针的契约。重点是**变更过滤** —— `useApp` 在流式回答期间每收一个 SSE 增量就
 * set 一次 state,裸转发订阅等于把每个订阅了 ctx.tangu 的插件按帧敲一遍(浮层类插件当场掉帧)。
 * 这是本次唯一没有别的仪器覆盖的宿主逻辑:e2e 里插件用的是台架假探针,绕开了这一层。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useSpaceStore } from '@lcl/engine'
import { installTanguProbe } from './tanguProbe'
import { readTangu } from './amadeus/plugins/tanguSeam'
import { useApp } from './stores/appStore'

describe('ctx.tangu 探针', () => {
  beforeEach(() => {
    installTanguProbe()
    useApp.setState({
      activeId: null, newChatModel: 'm1', sessions: [], archivedSessions: [],
      modelsResp: undefined, usageBySession: {}, ctxInfoBySession: {}, configBySession: {}, newChatCfg: {},
    } as never)
    useSpaceStore.setState({ activeSpaceId: 'tangu' })
  })

  it('activeModel 跟着「输入栏药丸」那条回退链走;目录里查得到就给展示名', () => {
    const p = readTangu()!
    expect(p.activeModel()).toEqual({ id: 'm1', name: 'm1' }) // 目录空 → 回落成 id,不给空串

    useApp.setState({
      modelsResp: { models: [{ id: 'm1', name: 'Claude Opus 5', provider: 'x', source: 'forsion' }] } as never,
    })
    expect(p.activeModel()).toEqual({ id: 'm1', name: 'Claude Opus 5' })

    // 有活动会话时读会话自己的 model_id(而不是新对话那条链)
    useApp.setState({
      activeId: 's1',
      sessions: [{ id: 's1', title: '', model_id: 'm2', created_at: '', updated_at: '' }] as never,
    })
    expect(p.activeModel()?.id).toBe('m2')
  })

  it('activeSpace 直读 activeSpaceId(不是 getActiveSpace —— 它的 ?? spaces[0] 会报错成别的 Space)', () => {
    expect(readTangu()!.activeSpace()).toBe('tangu')
    useSpaceStore.setState({ activeSpaceId: 'amadeus' })
    expect(readTangu()!.activeSpace()).toBe('amadeus')
  })

  it('models 只暴露对话模型,并给空展示名回落 id', () => {
    useApp.setState({
      modelsResp: {
        models: [
          { id: 'legacy', name: '', provider: 'x', source: 'forsion' },
          { id: 'llm', name: 'Chat', provider: 'x', source: 'forsion', modelType: 'llm' },
          { id: 'image', name: 'Image', provider: 'x', source: 'forsion', modelType: 'image_gen' },
          { id: 'asr', name: 'ASR', provider: 'x', source: 'forsion', modelType: 'asr' },
        ],
      } as never,
    })
    expect(readTangu()!.models()).toEqual([
      { id: 'legacy', name: 'legacy' },
      { id: 'llm', name: 'Chat' },
    ])
  })

  it('session:空态会话也给得出来 —— 用量 0 + 新对话的起步档', () => {
    useApp.setState({ newChatCfg: { thinkingLevel: 'high' } as never, desktopConfig: null })
    expect(readTangu()!.session!()).toEqual({ contextWindow: 0, contextTokens: 0, sessionTokens: 0, effort: 'high' })

    // 「不指定」在配置里是空串,不能原样吐出去(插件会拿它当档位名查表)。
    useApp.setState({ newChatCfg: { thinkingLevel: '' } as never })
    expect(readTangu()!.session!().effort).toBeNull()
  })

  it('session:窗口 / 已用 token 与输入框同源;引擎报的窗口盖过目录值', () => {
    useApp.setState({
      activeId: 's1',
      sessions: [{ id: 's1', title: '', model_id: 'm1', created_at: '', updated_at: '' }] as never,
      modelsResp: { models: [{ id: 'm1', name: 'M1', provider: 'x', source: 'forsion', contextWindow: 200000 }] } as never,
      usageBySession: { s1: { ctx: 12000, base: 30000, live: 500 } },
    })
    expect(readTangu()!.session!()).toMatchObject({ contextWindow: 200000, contextTokens: 12000, sessionTokens: 30500 })

    useApp.setState({
      configBySession: { s1: { thinkingLevel: 'xhigh' } } as never,
      ctxInfoBySession: { s1: { ctxWindow: 1000000, thinkingRequested: 'xhigh', thinkingEffective: 'xhigh', modelId: 'm1' } } as never,
    })
    expect(readTangu()!.session!()).toMatchObject({ contextWindow: 1000000, effort: 'xhigh' })
  })

  it('session:刚改完思考档还没跑新 run → 报**新选的档**,不是上一次 run 的旧档', () => {
    useApp.setState({
      activeId: 's1',
      sessions: [{ id: 's1', title: '', model_id: 'm1', created_at: '', updated_at: '' }] as never,
      modelsResp: { models: [{ id: 'm1', name: 'M1', provider: 'x', source: 'forsion', contextWindow: 200000 }] } as never,
      // 上一轮跑的是 medium;setSessionThinking **不作废 ctxInfo**,所以这条会留着
      ctxInfoBySession: { s1: { ctxWindow: 500000, thinkingRequested: 'medium', thinkingEffective: 'medium', modelId: 'm1' } } as never,
      configBySession: { s1: { thinkingLevel: 'max' } } as never, // 用户刚把药丸拨到 max
    })
    const got = readTangu()!.session!()
    expect(got.effort).toBe('max')          // 药丸说 max,面板就得说 max
    expect(got.contextWindow).toBe(500000)  // ⚠️窗口不跟着作废:换档不影响上下文预算
  })

  it('session:引擎把请求档降了档(能力表 clamp)→ 报**生效档**,那才是真跑的', () => {
    useApp.setState({
      activeId: 's1',
      sessions: [{ id: 's1', title: '', model_id: 'm1', created_at: '', updated_at: '' }] as never,
      ctxInfoBySession: { s1: { ctxWindow: 200000, thinkingRequested: 'high', thinkingEffective: 'medium', modelId: 'm1' } } as never,
      configBySession: { s1: { thinkingLevel: 'high' } } as never,
    })
    expect(readTangu()!.session!().effort).toBe('medium')
  })

  it('session:ctxInfo 属于别的模型时整条作废(窗口和思考档出自同一条事件,不能只挡一半)', () => {
    useApp.setState({
      activeId: 's1',
      sessions: [{ id: 's1', title: '', model_id: 'm2', created_at: '', updated_at: '' }] as never,
      configBySession: { s1: { thinkingLevel: 'low' } } as never,
      modelsResp: { models: [{ id: 'm2', name: 'M2', provider: 'x', source: 'forsion', contextWindow: 64000 }] } as never,
      // 切模型后 SSE 重放复活的旧 run 事件:窗口 100 万、思考档 max,两个都是上一把模型的
      ctxInfoBySession: { s1: { ctxWindow: 1000000, thinkingEffective: 'max', modelId: 'm1' } } as never,
    })
    const got = readTangu()!.session!()
    expect(got.contextWindow).toBe(64000)  // 回落到目录值,不是 100 万
    expect(got.effort).toBe('low')          // 回落到会话配置档,不是 max
  })

  it('subscribe 只在 (模型, Space) 真变了时回调 —— 无关的 store 变更一律不响', () => {
    const p = readTangu()!
    let n = 0
    const off = p.subscribe(() => { n++ })

    // ① 与模型/Space 无关的 state 变更(模拟流式回答里每个增量都 set 一次)
    for (let i = 0; i < 5; i++) useApp.setState({ toastMsg: `tick ${i}` } as never)
    expect(n).toBe(0)

    // ② 同一个值重复写入也不响
    useApp.setState({ newChatModel: 'm1' })
    expect(n).toBe(0)

    // ③ 模型真变了 → 响一次
    useApp.setState({ newChatModel: 'm9' })
    expect(n).toBe(1)

    // ④ Space 真变了 → 再响一次
    useSpaceStore.setState({ activeSpaceId: 'inbox' })
    expect(n).toBe(2)

    // ⑤ 退订之后不再响(禁用插件后还在收回调 = 泄漏)
    off()
    useApp.setState({ newChatModel: 'm10' })
    useSpaceStore.setState({ activeSpaceId: 'amadeus' })
    expect(n).toBe(2)
  })
})
