/**
 * 插件沙箱 · 沙箱那份 Forsion 的渲染层(主进程那侧见 electron/sandboxChild.ts,契约 tangu-agent/docs/plugin-sandbox.md)。
 *
 *  · 首屏种子(语言、主题、跳过引导)在 seed.ts:它得赶在所有 store 之前,是 main.tsx 的第一个 import;
 *  · installSandboxHook:`window.__forsionSandbox`,主进程经 executeJavaScript 调它:状态 / 跑插件命令 / 开视图 / 重载;
 *  · 插件第一次装好时把它的第一个视图开出来,之后每次装载落定都报一次给主进程(父进程那边的卡片跟着变)。
 *
 * 普通实例里 window.tangu.sandbox 不存在,这里的函数全是 no-op。
 */
import { usePluginStore } from '../amadeus/plugins/pluginStore'
import { getDevPluginState, reloadDevPlugin } from '../amadeus/plugins/devSandbox'
import { hiddenSpaceForAgent, hiddenSpacesOf } from '../pluginSpaceHealth'
import { pluginSpaceOwner } from '../stores/spaceProgress'
import type { SandboxStatus } from '../../../../tangu-agent/src/contracts/pluginSandbox'

export const sandboxSelf = () => window.tangu?.sandbox?.self ?? null

let loads = 0
let settled = false

/** 一份状态(形状 = SandboxStatus,主进程补 windowVisible,父进程再过一道 parseSandboxStatus)。 */
function status(pluginId: string): Omit<SandboxStatus, 'windowVisible'> {
  const self = sandboxSelf()!
  const s = usePluginStore.getState()
  const p = s.plugins.find((x) => x.id === pluginId)
  const dev = getDevPluginState(pluginId)
  const views = s.views.filter((v) => v.pluginId === pluginId).map((v) => v.item.id)
  const hidden = hiddenSpacesOf(pluginId)
  const notListed = settled && !p ? 'the host did not list this plugin (manifest.json id changed, or the folder is no longer a plugin)' : null
  const state: SandboxStatus['state'] = !settled ? 'starting'
    : dev.blocked ? 'blocked'
      : dev.active ? 'running'
        : 'failed'
  return {
    v: 1,
    state,
    pluginId,
    name: p?.name || self.name,
    version: p?.version || self.version,
    dir: self.dir,
    views,
    spaces: [...pluginSpaceOwner].filter(([, owner]) => owner === pluginId).map(([id]) => id),
    hiddenSpaces: hidden.map((h) => ({ slug: h.slug, reason: hiddenSpaceForAgent(pluginId, h) })),
    setupError: dev.setupError || notListed,
    blocked: dev.blocked ? `${dev.blocked}${dev.blockedReason ? `: ${dev.blockedReason}` : ''}` : null,
    mountErrors: dev.mountErrors.map((m) => ({ view: m.viewId, message: m.message })),
    logs: dev.logs.slice(-40).map((l) => ({ level: l.level, text: l.text })),
    warnCount: dev.logs.filter((l) => l.level === 'warn').length,
    errorCount: dev.logs.filter((l) => l.level === 'error').length + dev.mountErrors.length,
    loads,
  }
}

function openView(pluginId: string, view?: string): boolean {
  const s = usePluginStore.getState()
  const own = s.views.filter((v) => v.pluginId === pluginId).map((v) => v.item.id)
  const id = view ? own.find((v) => v === view || `plugin:${pluginId}:${v}` === view) : own[0]
  if (!id || !s.viewOpener) return false
  s.viewOpener(`plugin:${pluginId}:${id}`, undefined, {})
  return true
}

/** 插件命令 = ctx.registerCommand 注册的那些;按命令 id(不带插件前缀)找。 */
async function command(pluginId: string, id: string, args: unknown): Promise<{ ok: boolean; error?: string }> {
  const cmd = usePluginStore.getState().commands.find((c) => c.pluginId === pluginId && (c.item.id === id || `amadeus:${pluginId}:${c.item.id}` === id))
  if (!cmd) {
    const have = usePluginStore.getState().commands.filter((c) => c.pluginId === pluginId).map((c) => c.item.id)
    return { ok: false, error: `no command "${id}"; this plugin registered: ${have.join(', ') || 'none'}` }
  }
  try {
    await (cmd.item.run as (a?: unknown) => unknown)(args && typeof args === 'object' ? args : undefined)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 主窗口的插件第一次装载落定时由 amadeusPlugins 调(loadExternal 之后)。 */
export function sandboxPluginsLoaded(): void {
  const self = sandboxSelf()
  if (!self || settled) return
  settled = true
  loads += 1
  openView(self.pluginId)
  window.tangu?.sandbox?.changed()
}

export function installSandboxHook(): void {
  const self = sandboxSelf()
  if (!self) return
  const pid = self.pluginId
  ;(window as unknown as { __forsionSandbox: unknown }).__forsionSandbox = {
    status: () => status(pid),
    command: (id: string, args: unknown) => command(pid, id, args),
    openView: (view?: string) => openView(pid, view),
    reload: async () => {
      const before = usePluginStore.getState().views.some((v) => v.pluginId === pid)
      await reloadDevPlugin(pid).catch((e) => console.warn('[sandbox] reload failed', e))
      loads += 1
      // 第一次没装上、这次装上了:把视图开出来(reloadDevPlugin 只恢复「之前开着的」)
      if (!before) openView(pid)
      window.tangu?.sandbox?.changed()
    },
  }
}
