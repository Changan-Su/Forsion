import { describe, expect, it } from 'vitest'
import {
  BUFFER_CAP, HOURLY_CAP, MESSAGE_CAP, STACK_CAP,
  createStartupTracker, createTelemetryHost, crashFromError, engineExitProps, processGoneProps, publicPluginId, shapeRendererReport, telemetryPackaged,
  type HostTelemetryEvent,
} from './telemetryHost'

const host = (packaged = true) => createTelemetryHost({
  packaged, sessionId: '00000000-0000-4000-8000-000000000000', channel: () => 'stable', coreVersion: () => '2.13.13', now: () => Date.UTC(2026, 9, 28, 9, 0, 0),
})

describe('shapeRendererReport:渲染层上报的整形与校验', () => {
  it('种类不在 crash / feature / longtasks 里、或 props 不是对象 → 丢', () => {
    expect(shapeRendererReport('agent_run', { name: 'x' })).toBeNull()
    expect(shapeRendererReport('perf', { kind: 'startup' })).toBeNull()
    expect(shapeRendererReport(undefined, { message: 'x' })).toBeNull()
    expect(shapeRendererReport('crash', 'boom')).toBeNull()
    expect(shapeRendererReport('crash', ['boom'])).toBeNull()
    expect(shapeRendererReport('feature', { name: 'setting_change', key: 'theme' })).toBeNull() // 这一版不采
  })

  it('crash:原文照传但封顶 message ≤ 2000、stack ≤ 8000;错误名只留合法字符', () => {
    const r = shapeRendererReport('crash', { reason: 'rejection', errorName: 'Type Error<script>', message: 'm'.repeat(5000), stack: 's'.repeat(20000), extra: 'dropped' })
    expect(r).not.toBeNull()
    const props = (r as { props: Record<string, unknown> }).props
    expect(props.process).toBe('renderer')
    expect(props.reason).toBe('rejection')
    expect(props.errorName).toBe('Type-Errorscript')
    expect((props.message as string).length).toBe(MESSAGE_CAP)
    expect((props.stack as string).length).toBe(STACK_CAP)
    expect(props).not.toHaveProperty('extra')
    expect(shapeRendererReport('crash', { message: '' })).toBeNull() // 什么都没有就不报
  })

  it('crash 的 pluginId:只有内置 / 商店的原样,其余 local', () => {
    const pid = (pluginId: unknown, pluginOfficial: unknown) => (shapeRendererReport('crash', { message: 'x', pluginId, pluginOfficial }) as { props: Record<string, unknown> }).props.pluginId
    expect(pid('forsion-extend', true)).toBe('forsion-extend')
    expect(pid('my-secret-plugin', false)).toBe('local')
    expect(pid('x'.repeat(65), true)).toBe('local') // 白名单 max 64
  })

  it('space_open:内置给 Space id;插件 Space 给 plugin + 插件 id(侧载 → local);用户自建的给 custom、不带 id', () => {
    expect(shapeRendererReport('feature', { name: 'space_open', origin: 'builtin', space: 'muse' })).toEqual({ event: 'feature', props: { name: 'space_open', kind: 'muse' } })
    expect(shapeRendererReport('feature', { name: 'space_open', origin: 'plugin', pluginId: 'market-3f0c8a8e-1b2c-4d5e-8f90-123456789abc', pluginOfficial: true }))
      .toEqual({ event: 'feature', props: { name: 'space_open', kind: 'plugin', id: 'market-3f0c8a8e-1b2c-4d5e-8f90-123456789abc' } })
    expect(shapeRendererReport('feature', { name: 'space_open', origin: 'plugin', pluginId: 'my-side-loaded', pluginOfficial: false }))
      .toEqual({ event: 'feature', props: { name: 'space_open', kind: 'plugin', id: 'local' } })
    expect(shapeRendererReport('feature', { name: 'space_open', origin: 'user', space: '我的周报' })).toEqual({ event: 'feature', props: { name: 'space_open', kind: 'custom' } })
    expect(shapeRendererReport('feature', { name: 'space_open', origin: 'builtin', space: 'has space' })).toBeNull()
    expect(shapeRendererReport('feature', { name: 'space_open', space: 'muse' })).toBeNull() // 来源不明不报
  })

  it('view_open:给 View 类型;插件视图只记 plugin,不把插件 id 漏进 kind', () => {
    expect(shapeRendererReport('feature', { name: 'view_open', view: 'calendar' })).toEqual({ event: 'feature', props: { name: 'view_open', kind: 'calendar' } })
    expect(shapeRendererReport('feature', { name: 'view_open', view: 'plugin:my-side-loaded:main' })).toEqual({ event: 'feature', props: { name: 'view_open', kind: 'plugin' } })
    expect(shapeRendererReport('feature', { name: 'view_open', view: 'x'.repeat(61) })).toBeNull()
  })

  it('plugin_open:内置 / 商店的原样,侧载 / 不合规的 local', () => {
    expect(shapeRendererReport('feature', { name: 'plugin_open', pluginId: 'forsion-calendar', pluginOfficial: true })).toEqual({ event: 'feature', props: { name: 'plugin_open', id: 'forsion-calendar' } })
    expect(shapeRendererReport('feature', { name: 'plugin_open', pluginId: 'acme-notes', pluginOfficial: false })).toEqual({ event: 'feature', props: { name: 'plugin_open', id: 'local' } })
    expect(shapeRendererReport('feature', { name: 'plugin_open', pluginId: '../../etc', pluginOfficial: true })).toEqual({ event: 'feature', props: { name: 'plugin_open', id: 'local' } })
  })

  it('longtasks:只收正整数', () => {
    expect(shapeRendererReport('longtasks', { count: 7 })).toEqual({ longTasks: 7 })
    expect(shapeRendererReport('longtasks', { count: 0 })).toBeNull()
    expect(shapeRendererReport('longtasks', { count: -3 })).toBeNull()
    expect(shapeRendererReport('longtasks', { count: 1.5 })).toBeNull()
  })

  it('publicPluginId:official 必须是 true 本身', () => {
    expect(publicPluginId('forsion-extend', 'true')).toBe('local')
    expect(publicPluginId(42, true)).toBe('local')
  })
})

describe('宿主事件的形状', () => {
  it('主进程异常 → crash(main),原文封顶', () => {
    const e = new RangeError('x'.repeat(3000))
    const p = crashFromError('main', 'exception', e, { uptimeS: 12 })
    expect(p).toMatchObject({ process: 'main', reason: 'exception', errorName: 'RangeError', uptimeS: 12 })
    expect((p.message as string).length).toBe(MESSAGE_CAP)
    expect(crashFromError('main', 'rejection', 'plain string')).toMatchObject({ process: 'main', reason: 'rejection', errorName: 'string', message: 'plain string' })
  })

  it('引擎意外退出:退出码 / 信号映射;Windows NTSTATUS 超出 int 记进 errorName', () => {
    expect(engineExitProps(1, null, 30)).toEqual({ process: 'engine', reason: 'abnormal-exit', exitCode: 1, uptimeS: 30 })
    expect(engineExitProps(null, 'SIGSEGV')).toEqual({ process: 'engine', reason: 'crashed', errorName: 'SIGSEGV' })
    expect(engineExitProps(null, 'SIGKILL')).toEqual({ process: 'engine', reason: 'killed', errorName: 'SIGKILL' })
    expect(engineExitProps(3221225477, null)).toEqual({ process: 'engine', reason: 'abnormal-exit', errorName: '0xC0000005' })
  })

  it('渲染 / 子进程没了:clean-exit 不算;未知 reason → other;子进程类型进 errorName', () => {
    expect(processGoneProps('renderer', { reason: 'clean-exit', exitCode: 0 })).toBeNull()
    expect(processGoneProps('renderer', { reason: 'oom', exitCode: 9 }, 5)).toEqual({ process: 'renderer', reason: 'oom', exitCode: 9, uptimeS: 5 })
    expect(processGoneProps('other', { type: 'Sandbox helper', reason: 'memory-eviction', exitCode: 1 })).toEqual({ process: 'other', reason: 'other', exitCode: 1, errorName: 'Sandbox-helper' })
  })
})

describe('createTelemetryHost:缓冲、回放、上限', () => {
  it('首个订阅者之前最多攒 50 条(留最早的),订阅时一次性回放;之后直接投递、不再攒', () => {
    const h = host()
    for (let i = 0; i < BUFFER_CAP + 10; i++) h.emit('perf', { kind: 'hourly', rssMb: i })
    const got: HostTelemetryEvent[] = []
    const off = h.seam.subscribe((ev) => got.push(ev))
    expect(got).toHaveLength(BUFFER_CAP)
    expect(got[0]).toEqual({ event: 'perf', ts: '2026-10-28T09:00:00.000Z', props: { kind: 'hourly', rssMb: 0 } })
    h.emit('perf', { kind: 'hourly', rssMb: 999 })
    expect(got).toHaveLength(BUFFER_CAP + 1)
    off()
    h.emit('perf', { kind: 'hourly', rssMb: 1000 })
    const late: HostTelemetryEvent[] = []
    h.seam.subscribe((ev) => late.push(ev))
    expect(late).toHaveLength(0) // 退订后没人收就丢,不再攒
    expect(got).toHaveLength(BUFFER_CAP + 1)
  })

  it('订阅者抛错不影响别的订阅者与宿主', () => {
    const h = host()
    h.seam.subscribe(() => { throw new Error('bad') })
    const got: HostTelemetryEvent[] = []
    h.seam.subscribe((ev) => got.push(ev))
    expect(() => h.emit('crash', { process: 'main' })).not.toThrow()
    expect(got).toHaveLength(1)
  })

  it('report:坏种类丢;longtasks 攒进本小时,takeHour 读走并清零;crash / feature 每小时有上限', () => {
    const h = host()
    const got: HostTelemetryEvent[] = []
    h.seam.subscribe((ev) => got.push(ev))
    h.report('nope', { message: 'x' })
    h.report('longtasks', { count: 3 })
    h.report('longtasks', { count: 4 })
    expect(got).toHaveLength(0)
    expect(h.takeHour()).toEqual({ longTasks: 7 })
    expect(h.takeHour()).toEqual({ longTasks: 0 })
    for (let i = 0; i < HOURLY_CAP.crash + 5; i++) h.report('crash', { message: `e${i}` })
    expect(got.filter((e) => e.event === 'crash')).toHaveLength(HOURLY_CAP.crash)
    h.takeHour()
    h.report('crash', { message: 'next hour' })
    expect(got.filter((e) => e.event === 'crash')).toHaveLength(HOURLY_CAP.crash + 1)
  })

  it('接缝成员照契约 §3', () => {
    const h = host(false)
    expect(h.seam.sessionId).toBe('00000000-0000-4000-8000-000000000000')
    expect(h.seam.packaged).toBe(false)
    expect(h.seam.channel()).toBe('stable')
    expect(h.seam.coreVersion()).toBe('2.13.13')
  })
})

describe('telemetryPackaged', () => {
  it('打包版且不是台架 / 沙箱才算;force 一律算、off 一律不算', () => {
    expect(telemetryPackaged({ isPackaged: true, harness: false, sandbox: false, env: undefined })).toBe(true)
    expect(telemetryPackaged({ isPackaged: false, harness: false, sandbox: false, env: undefined })).toBe(false)
    expect(telemetryPackaged({ isPackaged: true, harness: true, sandbox: false, env: undefined })).toBe(false)
    expect(telemetryPackaged({ isPackaged: true, harness: false, sandbox: true, env: undefined })).toBe(false)
    expect(telemetryPackaged({ isPackaged: true, harness: false, sandbox: false, env: 'off' })).toBe(false)
    expect(telemetryPackaged({ isPackaged: false, harness: true, sandbox: false, env: 'force' })).toBe(true)
  })
})

describe('createStartupTracker', () => {
  const tracker = (expectEngine: boolean) => {
    const out: Array<Record<string, unknown>> = []
    let timer: (() => void) | null = null
    const t = createStartupTracker({ expectEngine, waitMs: 60_000, emit: (p) => out.push(p), setTimer: (fn) => { timer = fn } })
    return { t, out, fire: () => timer?.() }
  }
  it('首帧 + 引擎就绪都齐了发一条,只发一次', () => {
    const { t, out, fire } = tracker(true)
    t.firstFrame(1234.4)
    expect(out).toHaveLength(0)
    t.engineReady(2500.6)
    expect(out).toEqual([{ kind: 'startup', startupMs: 1234, engineReadyMs: 2501 }])
    fire(); t.firstFrame(9); t.engineReady(9)
    expect(out).toHaveLength(1)
  })
  it('引擎迟迟不就绪:等到时限只带首帧;没有托管引擎:首帧就发', () => {
    const a = tracker(true)
    a.t.firstFrame(800)
    a.fire()
    expect(a.out).toEqual([{ kind: 'startup', startupMs: 800 }])
    const b = tracker(false)
    b.t.firstFrame(700)
    expect(b.out).toEqual([{ kind: 'startup', startupMs: 700 }])
  })
})
