// @vitest-environment happy-dom
// 过程行句子(ctx.registerToolLabel,2026-11-13):插件给自家引擎半身的工具写整句,宿主整句照用。
//  ① 认领同结果卡片:只认本捆绑包引擎半身名下的工具;名单没拉到 / 别家的工具不认 → 照旧「插件名 · 工具」;
//  ② describe 抛错 / 返回空 → 照旧写法;
//  ③ 运行中折叠头显示当前这步 running 的句子;做完后折叠头仍是汇总、展开每行 done 的句子;
//  ④ 切语言重新求值;earlier = 同一条回答里更早的本插件调用(最多 40 条);停用即摘。
// 负对照(已实跑红):toolLabelOf 里去掉 claimToolLabel 的 pluginOwnsTool 那半 → ①「别家的工具不认」红;
// ToolGroup 的 labelOf 不传 context(只看这一组)→ ④「earlier 来自整条回答」红。
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolEvent } from '../types'
import type { ToolLabelCall } from '../amadeus/plugins/types'

const { usePluginStore } = await import('../amadeus/plugins/pluginStore')
const { useEngineTools, toolLabelOf, claimToolLabel, __resetToolCards } = await import('../amadeus/plugins/toolResultCards')
const { ToolGroup, describeTool, toolVerb } = await import('./ToolGroup')
const { LocaleProvider, setLocaleGlobal } = await import('../i18n')
type Ctx = import('../amadeus/plugins/types').PluginContext
type Plugin = import('../amadeus/plugins/types').AmadeusPlugin

const bundle = (enginePlugins: string[]) => ({ agents: [], enginePlugins, skills: [], spaces: [] })

function ctxOf(id: string, over: Partial<Plugin> = {}): Ctx {
  let ref: Ctx | null = null
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
  usePluginStore.getState().init([{ id, name: id, version: '0', setup: (c) => { ref = c }, ...over }])
  return ref!
}

const call = (id: string, name: string, args: unknown, over: Partial<ToolEvent> = {}): ToolEvent =>
  ({ id, name, arguments: JSON.stringify(args), done: true, result: `result ${id}`, ...over })

/** 一个像 CU 那样的 describe:中英各一句,App 名从 earlier 里最近一条结果拿。 */
function cuDescribe(c: ToolLabelCall) {
  const app = [...c.earlier].reverse().map((e) => /in (\w+)/.exec(e.result ?? '')?.[1]).find(Boolean)
  const where = app ? ` in ${app}` : ''
  if (c.tool !== 'act_ui') return undefined
  if (c.locale === 'en') return { text: `${c.phase === 'running' ? 'Clicking' : 'Clicked'} “Send”${where}`, icon: { appBundleId: 'com.example.chatter' } }
  const zhWhere = app ? `${c.phase === 'running' ? '正在 ' : '已在 '}${app} 中` : c.phase === 'running' ? '正在' : '已'
  return { text: `${zhWhere}点击「发送」`, icon: { appBundleId: 'com.example.chatter' } }
}

beforeEach(() => {
  __resetToolCards()
  setLocaleGlobal('zh')
})

describe('① 登记与认领', () => {
  it('收下形状对的(单个名字 / 名单,去空白去重);缺 tool / describe 的拒收;停用即摘', () => {
    // 单独的 id:停用会记下来,别连累后面用 'cu' 的用例
    const ctx = ctxOf('cu-reg', { bundle: bundle(['computer-use']) })
    const describe = () => ({ text: 'x' })
    ctx.registerToolLabel!({ tool: ' act_ui ', describe })
    ctx.registerToolLabel!({ tool: ['observe_ui', 'observe_ui', ''], describe })
    ctx.registerToolLabel!({ tool: '', describe })
    ctx.registerToolLabel!({ tool: 'x' } as never)
    expect(usePluginStore.getState().toolLabels.map((o) => [o.pluginId, o.item.tools])).toEqual([
      ['cu-reg', ['act_ui']], ['cu-reg', ['observe_ui']],
    ])
    usePluginStore.getState().disable('cu-reg')
    expect(usePluginStore.getState().toolLabels).toEqual([])
    ctx.registerToolLabel!({ tool: 'act_ui', describe }) // 停用后迟到的注册
    expect(usePluginStore.getState().toolLabels).toEqual([])
  })

  it('只认自家引擎半身名下的工具;名单没拉到不认', () => {
    const plugins = [{ id: 'cu', bundle: bundle(['computer-use']) }, { id: 'other', bundle: bundle(['other-engine']) }]
    const l = (pluginId: string, tools: string[]) => ({ pluginId, item: { tools, describe: () => ({ text: 'x' }) } })
    const engine = { 'computer-use': ['act_ui'], 'other-engine': ['make_table'] }
    expect(claimToolLabel([l('cu', ['act_ui'])], plugins, engine, 'act_ui')?.pluginId).toBe('cu')
    expect(claimToolLabel([l('cu', ['make_table'])], plugins, engine, 'make_table'), '别家的工具').toBeUndefined()
    expect(claimToolLabel([l('cu', ['write_file'])], plugins, engine, 'write_file'), '核心工具').toBeUndefined()
    expect(claimToolLabel([l('cu', ['act_ui'])], plugins, {}, 'act_ui'), '名单没拉到').toBeUndefined()
    expect(claimToolLabel([l('other', ['act_ui']), l('cu', ['act_ui'])], plugins, engine, 'act_ui')?.pluginId).toBe('cu')
  })
})

describe('② describe 的结果', () => {
  const plugins = [{ id: 'cu', bundle: bundle(['computer-use']) }]
  const engine = { 'computer-use': ['act_ui', 'observe_ui'] }
  const one = (describe: (c: ToolLabelCall) => unknown) => [{ pluginId: 'cu', item: { tools: ['act_ui', 'observe_ui'], describe: describe as never } }]
  const ev = call('a', 'act_ui', { stateId: 's1' })

  it('抛错 / 返回空 / text 不是字符串 → undefined;text 去空白截 200 字;图标只收像 bundle id 的串', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(toolLabelOf(one(() => { throw new Error('bug') }), plugins, engine, 'zh', ev, 'done')).toBeUndefined()
    expect(toolLabelOf(one(() => { throw new Error('bug') }), plugins, engine, 'zh', ev, 'running')).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1) // 每次渲染都调,同一个工具只报一次
    warn.mockRestore()
    expect(toolLabelOf(one(() => undefined), plugins, engine, 'zh', ev, 'done')).toBeUndefined()
    expect(toolLabelOf(one(() => ({ text: '   ' })), plugins, engine, 'zh', ev, 'done')).toBeUndefined()
    expect(toolLabelOf(one(() => ({ text: 42 })), plugins, engine, 'zh', ev, 'done')).toBeUndefined()
    expect(toolLabelOf(one(() => ({ text: `  a\n b ${'x'.repeat(300)}` })), plugins, engine, 'zh', ev, 'done')!.text).toHaveLength(200)
    expect(toolLabelOf(one(() => ({ text: 'ok', icon: { appBundleId: '../evil path' } })), plugins, engine, 'zh', ev, 'done')).toEqual({ text: 'ok' })
    expect(toolLabelOf(one(() => ({ text: 'ok', icon: { appBundleId: 'com.example.chatter' } })), plugins, engine, 'zh', ev, 'done')).toEqual({ text: 'ok', appBundleId: 'com.example.chatter' })
  })

  it('call 的内容:解析后的参数、结果、phase、locale;earlier 只含同一条回答里更早的本插件调用,从早到晚、最多 40 条', () => {
    const seen: ToolLabelCall[] = []
    const labels = one((c) => { seen.push(c); return { text: 'ok' } })
    const ctxEvents: ToolEvent[] = [
      ...Array.from({ length: 45 }, (_, i) => call(`o${i}`, 'observe_ui', { n: i })),
      call('r', 'read_file', { path: 'x' }), // 核心工具:不进 earlier
      call('n', 'observe_ui', { n: 'no-result' }, { result: undefined, done: false }),
      ev,
      call('after', 'observe_ui', { n: 'later' }), // 排在后面的:不进
    ]
    toolLabelOf(labels, plugins, engine, 'en', ev, 'running', ctxEvents)
    const c = seen[0]
    expect(c).toMatchObject({ tool: 'act_ui', args: { stateId: 's1' }, result: 'result a', phase: 'running', locale: 'en' })
    expect(c.earlier).toHaveLength(40)
    expect(c.earlier[0]).toEqual({ tool: 'observe_ui', args: { n: 6 }, result: 'result o6' })
    expect(c.earlier.at(-1)).toEqual({ tool: 'observe_ui', args: { n: 'no-result' } })
    expect(c.earlier.some((e) => e.tool === 'read_file')).toBe(false)
    expect(Object.isFrozen(c.earlier)).toBe(true)
    // 不在上下文里 = 没有更早的
    toolLabelOf(labels, plugins, engine, 'zh', ev, 'done')
    expect(seen[1].earlier).toEqual([])
  })

  it('revision:插件自报的外部数据变了才重算(图标表后来才学到);没变照旧用缓存;revision 抛错不连坐', () => {
    let rev = 0
    let icon: string | undefined
    const spy = vi.fn(() => (icon ? { text: '已点击', icon: { appBundleId: icon } } : { text: '已点击' }))
    const labels = [{ pluginId: 'cu', item: { tools: ['act_ui'], describe: spy, revision: () => rev } }]
    const ev = call('rev1', 'act_ui', { stateId: 's1' })
    expect(toolLabelOf(labels, plugins, engine, 'zh', ev, 'done')).toEqual({ text: '已点击' })
    toolLabelOf(labels, plugins, engine, 'zh', ev, 'done')
    expect(spy, 'revision 没变:不重算').toHaveBeenCalledTimes(1)
    icon = 'com.example.chatter'
    expect(toolLabelOf(labels, plugins, engine, 'zh', ev, 'done'), 'revision 没动:外部数据变了宿主看不见(所以要报)').toEqual({ text: '已点击' })
    rev = 1
    expect(toolLabelOf(labels, plugins, engine, 'zh', ev, 'done'), 'revision 变了 → 重算,图标补上').toEqual({ text: '已点击', appBundleId: 'com.example.chatter' })
    expect(spy).toHaveBeenCalledTimes(2)
    const boom = [{ pluginId: 'cu', item: { tools: ['act_ui'], describe: spy, revision: () => { throw new Error('x') } } }]
    expect(toolLabelOf(boom, plugins, engine, 'zh', ev, 'done')?.text, 'revision 抛错:当没有,句子照出').toBe('已点击')
    const odd = [{ pluginId: 'cu', item: { tools: ['act_ui'], describe: spy, revision: () => ({}) as never } }]
    expect(toolLabelOf(odd, plugins, engine, 'zh', ev, 'done')?.text, 'revision 给了别的类型:当没有').toBe('已点击')
  })

  it('describeTool:认领到就整句,不拼插件名、不跟参数;只问内置工具以外的', () => {
    const lab = () => ({ text: '已在 Chatter 中点击「发送」', appBundleId: 'com.example.chatter' })
    const d = describeTool(ev, () => '电脑操作', lab)
    expect([toolVerb(d, ev, (k) => k), d.target, d.sentence, d.appBundleId]).toEqual(['已在 Chatter 中点击「发送」', '', true, 'com.example.chatter'])
    expect(toolVerb(describeTool(ev, () => '电脑操作', () => undefined), ev, (k) => k)).toBe('电脑操作 · act ui')
    expect(describeTool(call('r', 'read_file', { path: 'a/b.md' }), undefined, lab)).toMatchObject({ verbKey: 'tool.verb.read', target: 'b.md' })
    // kind 与有没有句子无关:折叠时不给看不见的行求句子,汇总计数不能因此变
    const br = call('b', 'browser_click', { text: 'x' })
    expect(describeTool(br, undefined, lab).kind).toBe(describeTool(br, undefined, () => undefined).kind)
  })
})

describe('③④ 在过程行里', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(async () => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const ctx = ctxOf('cu', { bundle: bundle(['computer-use']) })
    ctx.registerToolLabel!({ tool: ['act_ui', 'observe_ui'], describe: cuDescribe })
    // 第一次挂上会去拉一次引擎名单(台架里没有后端 → 拉回空表),等它落定再摆假名单
    await act(async () => root.render(React.createElement(ToolGroup, { events: [] })))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    useEngineTools.setState({ byEngine: { 'computer-use': ['act_ui', 'observe_ui'] }, toolOwner: { act_ui: { name: '电脑操作', nameEn: 'Computer use' }, observe_ui: { name: '电脑操作', nameEn: 'Computer use' } }, loaded: true })
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  const render = async (props: Parameters<typeof ToolGroup>[0]) => {
    await act(async () => root.render(React.createElement(LocaleProvider, null, React.createElement(ToolGroup, props))))
    await act(async () => { host.querySelectorAll('.tool-roll-item.is-out').forEach((el) => el.dispatchEvent(new Event('animationend', { bubbles: true }))) })
  }
  const head = () => host.querySelector('.tool-group-head') as HTMLButtonElement
  const rows = () => [...host.querySelectorAll('.tool-row-copy-text')].map((e) => e.textContent)

  const observe = call('o1', 'observe_ui', {}, { result: 'Observed 12 elements in Chatter — Inbox.' })
  const clicking = call('a1', 'act_ui', { stateId: 's1' }, { done: false, result: undefined })

  it('运行中:折叠头是当前这步 running 的句子(App 名来自整条回答里更早那次调用)', async () => {
    // observe 在前一组(另一个分段),act 在这一组:earlier 仍拿得到
    await render({ events: [clicking], running: true, context: [observe, clicking] })
    expect(host.querySelector('.tool-group-cur .chat-run-shimmer-text')?.textContent).toBe('正在 Chatter 中点击「发送」…')
  })

  it('做完:折叠头照旧汇总;展开每行 done 的句子;describe 返回空的 observe 行照旧', async () => {
    await render({ events: [observe, { ...clicking, done: true, result: 'Attempted 1 UI actions in Chatter — Inbox.' }], context: [observe, clicking] })
    expect(host.querySelector('.tool-group-sum-long')?.textContent).toBe('2 个工具')
    await act(async () => head().click())
    expect(rows()).toEqual(['电脑操作 · observe ui{}', '已在 Chatter 中点击「发送」']) // describe 返回空的照旧:插件名 · 工具 + 参数
  })

  it('切语言重新求值', async () => {
    const done = { ...clicking, done: true, result: 'ok' }
    await render({ events: [done], context: [observe, done] })
    await act(async () => head().click())
    expect(rows()).toEqual(['已在 Chatter 中点击「发送」'])
    await act(async () => setLocaleGlobal('en'))
    expect(rows()).toEqual(['Clicked “Send” in Chatter'])
  })

  it('成本:折叠着做完的组不求值;同一份 props 重渲染 N 次 describe 次数不涨;流式只有文字在变时为 0 次', async () => {
    const spy = vi.fn(cuDescribe)
    usePluginStore.setState({ toolLabels: [{ pluginId: 'cu', item: { tools: ['act_ui', 'observe_ui'], describe: spy } }] })
    const steps = Array.from({ length: 30 }, (_, i) => call(`s${i}`, i % 2 ? 'act_ui' : 'observe_ui', { n: i }, { result: 'Observed 3 elements in Chatter.' }))
    await render({ events: steps, context: steps })
    expect(spy, '折叠头是宿主汇总,看不见的行不求值').toHaveBeenCalledTimes(0)
    await act(async () => head().click())
    const opened = spy.mock.calls.length
    expect(opened).toBeGreaterThan(0)
    for (let i = 0; i < 6; i++) await render({ events: steps, context: steps })
    expect(spy.mock.calls.length, '重渲染不重算').toBe(opened)
    const live = [...steps, call('cur', 'act_ui', { n: 'cur' }, { done: false, result: undefined })]
    await render({ events: live, context: live, running: true, reasoning: 'a' })
    const streaming = spy.mock.calls.length
    for (let i = 0; i < 6; i++) {
      const copy = live.slice() // store 的不可变更新:数组换新,事件对象不变
      await render({ events: copy, context: copy, running: true, reasoning: 'a'.repeat(i + 2) })
    }
    expect(spy.mock.calls.length, '只有文字在变').toBe(streaming)
  })

  it('describe 抛错 → 照旧「插件名 · 工具」,不连坐整组', async () => {
    usePluginStore.setState({ toolLabels: [{ pluginId: 'cu', item: { tools: ['act_ui'], describe: () => { throw new Error('bug') } } }] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await render({ events: [{ ...clicking, done: true, result: 'ok' }] })
    await act(async () => head().click())
    expect(rows()).toEqual(['电脑操作 · act uis1'])
    warn.mockRestore()
  })
})
