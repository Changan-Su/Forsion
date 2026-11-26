/**
 * 插件的 ctx.stage(演示舞台,2026-11-20+):声明了 `stage` 能力、且在桌面版里才注入。
 * 起一份装着演示库的隔离 Forsion,按步骤操作它、拍全分辨率截图、录视频。主进程那侧见 electron/pluginStage.ts,
 * 参数与错误码见 shared/pluginStage.ts,方案见仓根 docs/ToBeImproved/沙箱开放给插件方案_2026-11-20。
 *
 * 插件停用 / 重载 / 卸载时宿主替它关舞台(scope.own)。每次调用都先问 alive():插件停了还拿着旧的 stage 对象调,一律 closed。
 */
import type { PluginStageApi, PluginStageHandle, PluginStageAction, PluginStageImage, PluginStageVideo } from './types'

type Reply = { ok: boolean; code?: string; error?: string } & Record<string, unknown>

/** 失败一律 reject 带 code 的 Error(和 ctx.ui.capture 一个风格)。 */
export function stageError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

const asAction = (r: Reply): PluginStageAction => ({
  did: typeof r.did === 'string' ? r.did : '',
  target: typeof r.target === 'string' ? r.target : '',
  ...(typeof r.outline === 'string' ? { outline: r.outline } : {}),
})

const asBytes = (v: unknown): Uint8Array => (v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array())

export function createStageApi(o: { pluginId: string; alive(): boolean; own(off: () => void): void }): PluginStageApi {
  const exec = (op: string, args: Record<string, unknown> = {}): Promise<Reply> => {
    const fn = window.tangu?.pluginStage?.exec
    if (!fn) return Promise.reject(stageError('unsupported', 'the demo stage needs the Forsion desktop app'))
    if (!o.alive()) return Promise.reject(stageError('closed', 'this plugin was stopped'))
    return fn(o.pluginId, op, args).then((r) => {
      if (!r || !r.ok) throw stageError(r?.code || 'error', r?.error || `stage action "${op}" failed`)
      return r
    })
  }
  let owned = false
  let latest: number | undefined
  return {
    async open(options) {
      const r = await exec('open', (options ?? {}) as Record<string, unknown>)
      // open 等着的工夫插件被停用了(清理那次带的是旧代号,主进程不认):这一份由自己关掉,不留着跑(Codex 11-20)
      if (!o.alive()) {
        void window.tangu?.pluginStage?.exec(o.pluginId, 'close', typeof r.gen === 'number' ? { __gen: r.gen } : {})?.catch(() => {})
        throw stageError('closed', 'this plugin was stopped')
      }
      // 这一次 open 的代号:句柄上的每个动作都带着它,重开之后旧句柄一律 closed,不会去动新的那份
      const gen = typeof r.gen === 'number' ? r.gen : undefined
      latest = gen
      // 插件停用 / 重载时替它关:登记一次就够;关的是这个实例最后开的那一份(别的实例后来重开的不动)
      if (!owned) { owned = true; o.own(() => { void window.tangu?.pluginStage?.exec(o.pluginId, 'close', latest === undefined ? {} : { __gen: latest })?.catch(() => {}) }) }
      const run = (op: string, args: Record<string, unknown> = {}): Promise<Reply> => exec(op, gen === undefined ? args : { ...args, __gen: gen })
      const win = (r.window ?? {}) as { width?: number; height?: number; scale?: number }
      const handle: PluginStageHandle = {
        window: { width: Number(win.width) || 0, height: Number(win.height) || 0, scale: Number(win.scale) || 1 },
        plugins: Array.isArray(r.plugins) ? (r.plugins as string[]) : [],
        engine: r.engine === 'scripted' ? 'scripted' : 'none',
        space: (space) => run('space', { space }).then(asAction),
        command: (command, args) => run('command', { command, args: args ?? {} }).then(asAction),
        click: (target) => run('click', { target }).then(asAction),
        type: (text, opts) => run('type', { text, ...(opts?.target ? { target: opts.target } : {}), ...(opts?.append ? { append: true } : {}) }).then(asAction),
        press: (key, opts) => run('press', { key, ...(opts?.target ? { target: opts.target } : {}) }).then(asAction),
        scroll: (target, amount) => run('scroll', { ...(target ? { target } : {}), ...(typeof amount === 'number' ? { amount } : {}) }).then(asAction),
        read: (target) => run('read', target ? { target } : {}).then((x) => ({ outline: typeof x.outline === 'string' ? x.outline : '' })),
        capture: async (opts) => {
          const x = await run('capture', { ...(opts?.rect ? { rect: opts.rect } : {}), ...(opts?.selector ? { selector: opts.selector } : {}) })
          const img: PluginStageImage = { bytes: asBytes(x.bytes), width: Number(x.width) || 0, height: Number(x.height) || 0, mime: 'image/png' }
          return img
        },
        record: async (opts) => {
          await run('recordStart', { ...(opts ?? {}) })
          let stopped: Promise<PluginStageVideo> | null = null
          const gone = (): Promise<void> => Promise.reject(stageError('closed', 'this recording has already stopped'))
          return {
            pause: () => (stopped ? gone() : run('recordPause').then(() => undefined)),
            resume: () => (stopped ? gone() : run('recordResume').then(() => undefined)),
            stop: () => (stopped ??= run('recordStop').then((x) => ({
              bytes: asBytes(x.bytes), mime: typeof x.mime === 'string' ? x.mime : 'video/mp4',
              width: Number(x.width) || 0, height: Number(x.height) || 0, durationMs: Number(x.durationMs) || 0,
            }))),
          }
        },
        close: () => run('close').then(() => undefined),
      }
      return handle
    },
  }
}
