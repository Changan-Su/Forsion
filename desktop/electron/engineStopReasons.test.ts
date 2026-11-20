/**
 * 每条停引擎的路记哪个原因(中断任务续跑方案 B,D1 / D5)。main.ts 的接线没法单测,这里按源码钉住:
 * 写进 shutdown-intent.json 的原因决定引擎下次启动续不续 —— 记错一条(比如更新记成 engine_stop)就静默不续了。
 * 意图文件本身「发信号前写好」由 backendManager.test.ts 的假引擎钉住;延后重启的规则由 engineRestart.test.ts 钉住。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
/** 一个 IPC 处理器的函数体(到下一个 ipcMain.handle 为止)。 */
const handler = (channel: string): string => {
  const at = main.indexOf(`ipcMain.handle('${channel}'`)
  expect(at, channel).toBeGreaterThan(0)
  const next = main.indexOf('ipcMain.handle(', at + 10)
  return main.slice(at, next > 0 ? next : undefined)
}
const between = (from: string, to: string): string => {
  const a = main.indexOf(from)
  expect(a, from).toBeGreaterThan(0)
  const b = main.indexOf(to, a + from.length)
  expect(b, to).toBeGreaterThan(a)
  return main.slice(a, b)
}

describe('engine stop paths × shutdown reason', () => {
  it('every ensureBackend / backend.stop call names its reason', () => {
    expect(main).not.toMatch(/ensureBackend\(\s*\)/)
    expect(main).not.toMatch(/await backend\.stop\(\)/) // 注释里提到的 backend.stop() 不算
  })

  it('clearing data: wiping the engine database too → no reason; keeping it (desktop settings only) → engine_stop, so the run is not auto-resumed with a reset toggle', () => {
    // 评审 #3:只清桌面设置时续跑开关跟着没了、下次按缺省「开」;不写原因的话 Windows 强杀后会按 crash 自动续
    expect(handler('app:clearData')).toContain("await backend.stop(opts?.tangu ? undefined : 'engine_stop')")
  })

  it('quitting the app (⌘Q / tray / before-quit) → app_quit', () => {
    expect(between("app.on('before-quit'", "app.on('window-all-closed'")).toContain("backend.stop('app_quit')")
  })

  it('restart to install an update → app_update; a plain relaunch → app_quit', () => {
    expect(between('const guardedRestart = createRestartGuard({', "ipcMain.handle('app:relaunch'")).toContain("await backend.stop(install ? 'app_update' : 'app_quit')")
    expect(handler('updater:install')).toContain('guardedRestart(true)')
  })

  it('sign-in / sign-out / 401 sign-out / auth.json rewritten (all through accountCore) → account_change, never deferred', () => {
    expect(between('const accountCore = createAccountCore({', '})')).toContain("ensureBackend: () => ensureBackend('account_change'),")
  })

  it('provider save / delete / import and managed-config changes → engine_restart, deferred while tasks run', () => {
    for (const ch of ['providers:save', 'providers:delete', 'providers:importLocal']) {
      expect(handler(ch), ch).toContain("void ensureBackend('engine_restart', { defer: true })")
    }
    expect(handler('config:set')).toContain("void ensureBackend('engine_restart', { defer: true })")
  })

  it('a restart stops the old engine before reading config, marks what it carries, and registers itself (review #4)', () => {
    // 读配置在停之前的话,等旧进程退出那 5s 里存下的设置 / 提供方就得再重启一回;不登记的话,期间来的请求会再排一次重启
    const body = between('function ensureBackend(reason: EngineStopReason', '\n}\n')
    const at = (s: string) => { const i = body.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i }
    expect(at('if (isQuitting) return')).toBeLessThan(at('await backend.stop(reason)')) // 退出 / 清数据自己带原因停,队里这次别抢先
    expect(at('await backend.stop(reason)')).toBeLessThan(at('deferredEngineRestart.markCovered()'))
    expect(at('deferredEngineRestart.markCovered()')).toBeLessThan(at('await loadConfig()'))
    expect(body).toContain('deferredEngineRestart.track(ensureChain)')
  })

  it('the explicit restart button and a subscription sign-in restart right away (engine_restart): the caller needs the new engine', () => {
    expect(handler('backend:restart')).toMatch(/await ensureBackend\('engine_restart'\)(?!,)/)
    expect(handler('auth:providerLogin')).toMatch(/await ensureBackend\('engine_restart'\)(?!,)/)
  })

  it('toggling auto-resume does not restart the engine (it only reads TANGU_AUTO_RESUME at start-up)', () => {
    const keys = between('const managedKeys: Array<keyof TanguStoredConfig> = [', ']')
    expect(keys).not.toContain('autoResumeInterrupted')
    expect(handler('config:set')).toContain('backend.setAutoResume(')
  })

  it('the setting persists in the desktop shell file (written only when patched, so other config:set calls leave it alone) and defaults to on', () => {
    expect(between('const SHELL_KEYS: Array<keyof TanguStoredConfig> = [', ']')).toContain("'autoResumeInterrupted',")
    expect(main).toMatch(/keepAwakeWhileRunning: false,\n\s*autoResumeInterrupted: true,/) // DEFAULT_CONFIG
    expect(main).toContain("backend.setAutoResume(stored.autoResumeInterrupted !== false)") // 每次拉起前按落盘值对齐内存镜像
  })
})
