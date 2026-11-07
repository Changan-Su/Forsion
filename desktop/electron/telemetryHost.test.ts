import { describe, expect, it } from 'vitest'
import {
  BUFFER_CAP, COMMAND_PAIR_CAP, HOURLY_CAP, RENDERER_REPORT_KINDS, STACK_CAP,
  appUpdateProps, coreUpdateProps, createStartupTracker, createTelemetryHost, crashFromError, engineExitProps, processGoneProps, publicPluginId, shapeRendererReport,
  telemetryPackaged, updateProps,
  type HostTelemetryEvent,
} from './telemetryHost'

const host = (packaged = true) => createTelemetryHost({
  packaged, sessionId: '00000000-0000-4000-8000-000000000000', channel: () => 'stable', coreVersion: () => '2.13.13', now: () => Date.UTC(2026, 9, 28, 9, 0, 0),
})

describe('shapeRendererReport:渲染层上报的整形与校验', () => {
  it('种类不在 §9 的清单里、或 props 不是对象 → 丢', () => {
    expect(shapeRendererReport('agent_run', { name: 'x' })).toBeNull()
    expect(shapeRendererReport('perf', { kind: 'startup' })).toBeNull()
    expect(shapeRendererReport('update', { target: 'app', outcome: 'error' })).toBeNull() // update 只由主进程自己报
    expect(shapeRendererReport('app_counts', { achChatSend: 3 })).toBeNull() // 计数只能经 count 攒
    expect(shapeRendererReport(undefined, { message: 'x' })).toBeNull()
    expect(shapeRendererReport('crash', 'boom')).toBeNull()
    expect(shapeRendererReport('crash', ['boom'])).toBeNull()
    // setting_change 不许直接当 feature 报(值没归档):只走 setting 种类
    expect(shapeRendererReport('feature', { name: 'setting_change', key: 'ui.themeMode', value: 'dark' })).toBeNull()
    expect(RENDERER_REPORT_KINDS).toEqual(['crash', 'feature', 'longtasks', 'plugin_install', 'plugin_deps', 'plugin_lifecycle', 'plugin_load', 'onboarding', 'guide_tip', 'count', 'command', 'setting'])
  })

  it('crash:报错原文不转发,stack 封顶 8000;错误名只留合法字符', () => {
    const r = shapeRendererReport('crash', { reason: 'rejection', errorName: 'Type Error<script>', message: 'm'.repeat(5000), stack: 's'.repeat(20000), extra: 'dropped' })
    expect(r).not.toBeNull()
    const props = (r as { props: Record<string, unknown> }).props
    expect(props.process).toBe('renderer')
    expect(props.reason).toBe('rejection')
    expect(props.errorName).toBe('Type-Errorscript')
    expect(props).not.toHaveProperty('message')
    expect((props.stack as string).length).toBe(STACK_CAP)
    expect(props).not.toHaveProperty('extra')
    expect(shapeRendererReport('crash', { message: '' })).toBeNull() // 什么都没有就不报
  })

  it('crash 的 pluginId:只有内置 / 商店的原样,其余 local', () => {
    const pid = (pluginId: unknown, pluginOfficial: unknown) => (shapeRendererReport('crash', { errorName: 'Error', pluginId, pluginOfficial }) as { props: Record<string, unknown> }).props.pluginId
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
  it('主进程异常 → crash(main),报错原文不转发', () => {
    const e = new RangeError('x'.repeat(3000))
    const p = crashFromError('main', 'exception', e, { uptimeS: 12 })
    expect(p).toMatchObject({ process: 'main', reason: 'exception', errorName: 'RangeError', uptimeS: 12 })
    expect(p).not.toHaveProperty('message')
    expect(crashFromError('main', 'rejection', 'plain string')).toEqual({ process: 'main', reason: 'rejection', errorName: 'string' })
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
    for (let i = 0; i < HOURLY_CAP.crash + 5; i++) h.report('crash', { errorName: 'Error', stack: `    at e${i}` })
    expect(got.filter((e) => e.event === 'crash')).toHaveLength(HOURLY_CAP.crash)
    h.takeHour()
    h.report('crash', { errorName: 'Error' })
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
  it('启动后才知道不拉起引擎(外接引擎):首帧在前在后都不空等', () => {
    const a = tracker(true)
    a.t.firstFrame(600); a.t.noEngine()
    expect(a.out).toEqual([{ kind: 'startup', startupMs: 600 }])
    const b = tracker(true)
    b.t.noEngine(); b.t.firstFrame(650)
    expect(b.out).toEqual([{ kind: 'startup', startupMs: 650 }])
  })
})

// ── v2(契约 §9)──
/** 真实值(11-07 取自 api.forsion.net 的商店目录与本仓):商店条目 id 是裸 UUID,新装目录是 market-<UUID>,老条目目录是作者自起名。 */
const STORE_ID = 'c6ff39fc-e42e-4999-9b2c-23776defd853' // better-pdf 的商店条目 id
const ev = (r: ReturnType<typeof shapeRendererReport>) => r as { event: string; props: Record<string, unknown> }

describe('v2 渲染层上报的整形', () => {
  it('plugin_install:字段按白名单过,枚举外的归 other,报错原文 / 多余字段不带;错误类只在 outcome=error 时有', () => {
    const r = ev(shapeRendererReport('plugin_install', {
      pluginId: STORE_ID, pluginOfficial: true, entry: 'muse-card', kind: 'amadeus-plugin', source: 'github', stage: 'download',
      outcome: 'error', errorClass: 'timeout', durationMs: 1234, sizeKb: 88, restart: false, message: 'github.com: timeout', path: '/Users/x',
    }))
    expect(r).toEqual({ event: 'plugin_install', props: { id: STORE_ID, entry: 'muse-card', kind: 'amadeus-plugin', source: 'github', stage: 'download', outcome: 'error', errorClass: 'timeout', durationMs: 1234, sizeKb: 88, restart: false } })
    const ok = ev(shapeRendererReport('plugin_install', { pluginId: STORE_ID, pluginOfficial: true, entry: 'weird', kind: 'x', source: 'echo', stage: 'done', outcome: 'done', errorClass: 'timeout', durationMs: 1.5 }))
    expect(ok.props).toEqual({ id: STORE_ID, entry: 'other', kind: 'other', source: 'other', stage: 'done', outcome: 'done' })
    expect(shapeRendererReport('plugin_install', { pluginId: STORE_ID, pluginOfficial: true, outcome: 'maybe' })).toBeNull()
    expect(shapeRendererReport('plugin_install', { outcome: 'done' })).toBeNull()
    expect(ev(shapeRendererReport('plugin_install', { pluginId: 'my-private', pluginOfficial: false, outcome: 'done' })).props.id).toBe('local')
  })

  it('plugin_deps / plugin_lifecycle / plugin_load', () => {
    expect(ev(shapeRendererReport('plugin_deps', { total: 3, installed: 1, failedAt: 2, outcome: 'failed', names: ['a'] })).props).toEqual({ total: 3, installed: 1, failedAt: 2, outcome: 'failed' })
    expect(shapeRendererReport('plugin_deps', { total: 3, outcome: 'meh' })).toBeNull()
    expect(ev(shapeRendererReport('plugin_lifecycle', { pluginId: 'forsion-calendar', pluginOfficial: true, action: 'disable', blockedReason: 'api' })).props).toEqual({ id: 'forsion-calendar', action: 'disable' })
    expect(ev(shapeRendererReport('plugin_lifecycle', { pluginId: 'x', pluginOfficial: false, action: 'blocked', blockedReason: 'whatever' })).props).toEqual({ id: 'local', action: 'blocked', blockedReason: 'other' })
    expect(shapeRendererReport('plugin_lifecycle', { pluginId: 'x', pluginOfficial: true, action: 'delete' })).toBeNull()
    expect(ev(shapeRendererReport('plugin_load', { pluginId: STORE_ID, pluginOfficial: true, outcome: 'error', activateMs: 42 })).props).toEqual({ id: STORE_ID, outcome: 'error', activateMs: 42 })
    expect(shapeRendererReport('plugin_load', { pluginId: STORE_ID, pluginOfficial: true, outcome: 'slow' })).toBeNull()
  })

  it('onboarding:只收 int / bool / 枚举字段', () => {
    const r = ev(shapeRendererReport('onboarding', { mode: 'returning', outcome: 'skip', screens: 2, backJumps: 1, msStart: 900, msTheme: 3000.5, youWritten: true, museOn: 'yes', aboutMe: '我是谁' }))
    expect(r.props).toEqual({ mode: 'returning', outcome: 'skip', screens: 2, backJumps: 1, msStart: 900, youWritten: true })
    expect(shapeRendererReport('onboarding', { mode: 'full', outcome: 'quit' })).toBeNull()
  })

  it('guide_tip:只发公开插件的提示;提示 id 按清单的形状', () => {
    expect(ev(shapeRendererReport('guide_tip', { pluginId: STORE_ID, pluginOfficial: true, tipId: 'drag-to-reorder', result: 'learned' })).props).toEqual({ pluginId: STORE_ID, tipId: 'drag-to-reorder', result: 'learned' })
    expect(shapeRendererReport('guide_tip', { pluginId: 'my-side-loaded', pluginOfficial: false, tipId: 'a', result: 'ok' })).toBeNull()
    expect(shapeRendererReport('guide_tip', { pluginId: STORE_ID, pluginOfficial: true, tipId: 'Has Space', result: 'ok' })).toBeNull()
    expect(shapeRendererReport('guide_tip', { pluginId: STORE_ID, pluginOfficial: true, tipId: 'a', result: 'shown' })).toBeNull()
  })

  it('count / command / setting 的形状', () => {
    expect(shapeRendererReport('count', { key: 'achChatSend' })).toEqual({ count: 'achChatSend', n: 1 })
    expect(shapeRendererReport('count', { key: 'openNote', n: 5000 })).toEqual({ count: 'openNote', n: 1000 })
    expect(shapeRendererReport('count', { key: 'plugin:demo:hi' })).toBeNull()
    expect(shapeRendererReport('count', { key: 'achChatSend', n: -1 })).toBeNull()
    expect(shapeRendererReport('command', { id: 'open-settings', source: 'hotkey' })).toEqual({ command: { id: 'open-settings', source: 'hotkey' } })
    expect(shapeRendererReport('command', { id: `amadeus:${STORE_ID}:open-reader`, source: 'nope' })).toEqual({ command: { id: `amadeus:${STORE_ID}:open-reader`, source: 'other' } })
    // 嵌着 market-<UUID> 的命令 id 会被密钥规则整条丢:这里先挡(渲染层应已换成裸 UUID)
    expect(shapeRendererReport('command', { id: 'amadeus:market-8f2a49a8-9de7-462d-864b-576c2bf1981d:x', source: 'palette' })).toBeNull()
    expect(shapeRendererReport('command', { id: 'has space', source: 'palette' })).toBeNull()
    expect(shapeRendererReport('command', { id: 'x'.repeat(81), source: 'palette' })).toBeNull()
    expect(ev(shapeRendererReport('setting', { key: 'muse.heartbeat', value: 45 })).props).toEqual({ name: 'setting_change', key: 'muse.heartbeat', value: 'other' })
    expect(ev(shapeRendererReport('setting', { key: 'computerHistory.enabled', value: true })).props).toEqual({ name: 'setting_change', key: 'computerHistory.enabled', value: 'on' })
    expect(shapeRendererReport('setting', { key: 'ui.fontFamily', value: 'serif' })).toBeNull() // 表外的键
    expect(shapeRendererReport('setting', { key: 'ui.themeMode', value: 'sepia' })).toBeNull() // 值不在枚举里
    expect(shapeRendererReport('setting', { key: 'ui.designLanguage', value: 'My Theme' })).toBeNull()
  })
})

describe('v2 宿主的攒与发', () => {
  it('count 按小时攒成一条 app_counts(只带非零的键);command 按 (id, 来源) 一条 command_use;flush 之后清零', () => {
    const h = host()
    const got: HostTelemetryEvent[] = []
    h.seam.subscribe((e) => got.push(e))
    h.report('count', { key: 'achChatSend' })
    h.report('count', { key: 'achChatSend', n: 2 })
    h.count('byokSave')
    h.report('command', { id: 'open-settings', source: 'hotkey' })
    h.report('command', { id: 'open-settings', source: 'hotkey' })
    h.report('command', { id: 'open-settings', source: 'palette' })
    expect(got).toHaveLength(0)
    h.flushCounts()
    expect(got.map((e) => [e.event, e.props])).toEqual([
      ['app_counts', { achChatSend: 3, byokSave: 1 }],
      ['command_use', { id: 'open-settings', source: 'hotkey', n: 2 }],
      ['command_use', { id: 'open-settings', source: 'palette', n: 1 }],
    ])
    h.flushCounts()
    expect(got).toHaveLength(3) // 没攒到就什么都不发
    h.count('not-a-key' as never)
    h.flushCounts()
    expect(got).toHaveLength(3)
  })

  it('一小时里不同 (命令, 来源) 的组合有上限:新组合丢、已记下的照常累加', () => {
    const h = host()
    const got: HostTelemetryEvent[] = []
    h.seam.subscribe((e) => got.push(e))
    for (let i = 0; i < COMMAND_PAIR_CAP + 20; i++) h.report('command', { id: `cmd-${i}`, source: 'palette' })
    h.report('command', { id: 'cmd-0', source: 'palette' })
    h.flushCounts()
    const uses = got.filter((e) => e.event === 'command_use')
    expect(uses).toHaveLength(COMMAND_PAIR_CAP)
    expect(uses.find((e) => e.props.id === 'cmd-0')?.props.n).toBe(2)
  })

  it('每类事件的每小时上限各算各的,takeHour 一并清零;汇总事件不受上限', () => {
    const h = host()
    const got: HostTelemetryEvent[] = []
    h.seam.subscribe((e) => got.push(e))
    for (let i = 0; i < HOURLY_CAP.plugin_install + 3; i++) h.report('plugin_install', { pluginId: STORE_ID, pluginOfficial: true, outcome: 'done' })
    for (let i = 0; i < HOURLY_CAP.update + 3; i++) h.emit('update', updateProps('engine', 'current'))
    expect(got.filter((e) => e.event === 'plugin_install')).toHaveLength(HOURLY_CAP.plugin_install)
    expect(got.filter((e) => e.event === 'update')).toHaveLength(HOURLY_CAP.update)
    h.takeHour()
    h.report('plugin_install', { pluginId: STORE_ID, pluginOfficial: true, outcome: 'done' })
    expect(got.filter((e) => e.event === 'plugin_install')).toHaveLength(HOURLY_CAP.plugin_install + 1)
    for (let i = 0; i < 700; i++) h.emit('app_counts', { openNote: 1 })
    expect(got.filter((e) => e.event === 'app_counts')).toHaveLength(700)
  })

  it('plugin_load 同一插件同一次启动只报一次;blocked 同一插件同一原因只报一次;local 不去重', () => {
    const h = host()
    const got: HostTelemetryEvent[] = []
    h.seam.subscribe((e) => got.push(e))
    for (let i = 0; i < 3; i++) h.report('plugin_load', { pluginId: STORE_ID, pluginOfficial: true, outcome: 'ok', activateMs: i })
    h.report('plugin_load', { pluginId: 'a', pluginOfficial: false, outcome: 'ok' })
    h.report('plugin_load', { pluginId: 'b', pluginOfficial: false, outcome: 'ok' })
    expect(got.filter((e) => e.event === 'plugin_load').map((e) => e.props.id)).toEqual([STORE_ID, 'local', 'local'])
    h.report('plugin_lifecycle', { pluginId: STORE_ID, pluginOfficial: true, action: 'blocked', blockedReason: 'deps' })
    h.report('plugin_lifecycle', { pluginId: STORE_ID, pluginOfficial: true, action: 'blocked', blockedReason: 'deps' })
    h.report('plugin_lifecycle', { pluginId: STORE_ID, pluginOfficial: true, action: 'blocked', blockedReason: 'min-app' })
    h.report('plugin_lifecycle', { pluginId: STORE_ID, pluginOfficial: true, action: 'disable' })
    h.report('plugin_lifecycle', { pluginId: STORE_ID, pluginOfficial: true, action: 'disable' })
    expect(got.filter((e) => e.event === 'plugin_lifecycle').map((e) => `${e.props.action}:${e.props.blockedReason ?? ''}`)).toEqual(['blocked:deps', 'blocked:min-app', 'disable:', 'disable:'])
  })

  it('主进程自己的设置改动同一张表、同一套归档', () => {
    const h = host()
    const got: HostTelemetryEvent[] = []
    h.seam.subscribe((e) => got.push(e))
    h.setting('update.channel', 'beta')
    h.setting('computerHistory.enabled', false)
    h.setting('update.channel', 'nightly')
    h.setting('secret.key', 'on')
    expect(got.map((e) => e.props)).toEqual([
      { name: 'setting_change', key: 'update.channel', value: 'beta' },
      { name: 'setting_change', key: 'computerHistory.enabled', value: 'off' },
    ])
  })
})

describe('update 的形状', () => {
  it('引擎 / 内置插件:只报有结论的阶段;报错原文换成 errorClass', () => {
    expect(coreUpdateProps({ id: 'tangu-engine', phase: 'checking' }, 'tangu-engine')).toBeNull()
    expect(coreUpdateProps({ id: 'tangu-engine', phase: 'development' }, 'tangu-engine')).toBeNull()
    expect(coreUpdateProps({ id: 'tangu-engine', phase: 'staged' }, 'tangu-engine')).toEqual({ target: 'engine', outcome: 'staged' })
    expect(coreUpdateProps({ id: 'tangu-engine', phase: 'error', error: 'integrity mismatch' }, 'tangu-engine')).toEqual({ target: 'engine', outcome: 'error', errorClass: 'integrity' })
    expect(coreUpdateProps({ id: 'forsion-extend', phase: 'error', error: 'signature: bad file /Users/me/x' }, 'tangu-engine')).toEqual({ target: 'builtin-plugin', id: 'forsion-extend', outcome: 'error', errorClass: 'signature' })
    expect(coreUpdateProps({ id: 'forsion-extend', phase: 'current' }, 'tangu-engine')).toEqual({ target: 'builtin-plugin', id: 'forsion-extend', outcome: 'current' })
  })
  it('安装包:available / not-available / downloaded → staged / error', () => {
    expect(appUpdateProps({ phase: 'checking' })).toBeNull()
    expect(appUpdateProps({ phase: 'downloading' })).toBeNull()
    expect(appUpdateProps({ phase: 'downloaded' })).toEqual({ target: 'app', outcome: 'staged' })
    expect(appUpdateProps({ phase: 'error', error: 'unreachable' })).toEqual({ target: 'app', outcome: 'error', errorClass: 'network' })
    expect(appUpdateProps({ phase: 'error', error: 'HttpError: 404 https://github.com/x?token=abc' })).toEqual({ target: 'app', outcome: 'error', errorClass: 'http' })
  })
  it('id 不是插件 id 的形状就不带', () => {
    expect(updateProps('builtin-plugin', 'current', { id: '../x' })).toEqual({ target: 'builtin-plugin', outcome: 'current' })
  })
})

describe('插件 id 规则(真实值)', () => {
  it('商店条目 id(裸 UUID)/ 内置 id / market-<UUID> 目录名原样;别的 local', () => {
    for (const id of [STORE_ID, 'bbed7431-5f4f-4063-960d-9d308b0c8ce7', 'forsion-extend', 'tangu-computer-use', 'market-8f2a49a8-9de7-462d-864b-576c2bf1981d']) expect(publicPluginId(id, true)).toBe(id)
    expect(publicPluginId('Better_PDF', true)).toBe('local')
    expect(publicPluginId(STORE_ID, false)).toBe('local')
  })
})
