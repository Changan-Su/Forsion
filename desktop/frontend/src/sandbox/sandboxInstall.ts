/**
 * 插件沙箱「装没装进用户那份 Forsion」的共用文案与判断(11-28 方案 A):对话卡、右栏卡、Coding Studio 面板、沙箱窗口顶条读同一份。
 * 状态真源在主进程(electron/pluginSandbox.ts sandboxInstalledState:逐文件比对 plugins/<id> 与沙箱目录),这里只管怎么说。
 */
import type { SandboxInstalled } from '../../../../tangu-agent/src/contracts/pluginSandbox'
import { registerMessages } from '../i18n'

registerMessages({
  'sandbox.inst.tag': { zh: '已安装', en: 'Installed' },
  'sandbox.inst.tagOpen': { zh: '已安装 · 沙箱开着', en: 'Installed · sandbox open' },
  'sandbox.inst.same': { zh: '已装进你的 Forsion：{name} {version}，和沙箱里是同一份', en: 'In your Forsion: {name} {version}, the same files as the sandbox' },
  'sandbox.inst.older': { zh: '你的 Forsion 里装的是旧的一份{version}，沙箱里改过 {n} 个文件', en: 'Your Forsion has an older copy{version}; {n} files changed in the sandbox' },
  'sandbox.inst.store': {
    zh: '你的 Forsion 里已经另装了这个插件{version}（多半来自商店）。要装这份，先在「设置 › 插件」卸载那份',
    en: 'Your Forsion already has this plugin installed separately{version} (usually from the store). To install this copy, uninstall that one in Settings › Plugins first',
  },
  'sandbox.inst.update': { zh: '更新到我的 Forsion', en: 'Update in my Forsion' },
  'sandbox.inst.updateShort': { zh: '更新', en: 'Update' },
  'sandbox.inst.installedShort': { zh: '已安装', en: 'Installed' },
  'sandbox.inst.installedTip': { zh: '你的 Forsion 里装的就是这一份', en: 'Your Forsion has exactly this copy' },
  'sandbox.inst.open': { zh: '在我的 Forsion 打开', en: 'Open in my Forsion' },
  'sandbox.inst.close': { zh: '关闭沙箱', en: 'Close sandbox' },
  'sandbox.inst.openSettings': { zh: '打开插件设置', en: 'Open plugin settings' },
  'sandbox.inst.after.open': { zh: '沙箱还开着，可以接着试；关掉沙箱不影响已经装好的那份。', en: 'The sandbox is still open, so you can keep trying it; closing it does not touch the installed copy.' },
  'sandbox.inst.after.closed': { zh: '沙箱已经关了。要再测，点「重新启动」；插件改过之后这里会出现「更新」。', en: 'The sandbox is closed. Start it again to test more; after you change the plugin, Update shows up here.' },
  'sandbox.inst.err.store': { zh: '没装上：你的 Forsion 里已经另装了这个插件，先在「设置 › 插件」卸载那份再装。', en: 'Not installed: your Forsion already has this plugin installed separately. Uninstall it in Settings › Plugins, then install again.' },
  'sandbox.inst.err.same': { zh: '你的 Forsion 里装的就是这一份，不用再装。', en: 'Your Forsion already has exactly this copy.' },
  'sandbox.inst.err.changed': { zh: '确认的时候沙箱换了插件，没有装。再点一次安装。', en: 'The sandbox switched plugins while you were confirming, so nothing was installed. Try again.' },
  'sandbox.inst.err.noSandbox': { zh: '沙箱已经停了，先重新启动再装。', en: 'The sandbox has stopped. Start it again, then install.' },
  'sandbox.inst.err.other': { zh: '没装上：{error}', en: 'Not installed: {error}' },
  'sandbox.rcpt.doneTitle': { zh: '已装进你的 Forsion', en: 'Installed in your Forsion' },
  'sandbox.rcpt.doneBody': {
    zh: '{name} {version}，和沙箱里这份是同一份。沙箱还开着，可以接着试；改了插件文件，这里会变成「更新」。',
    en: '{name} {version}, the same files as the sandbox. The sandbox stays open so you can keep trying it; when you change the plugin files, this turns into Update.',
  },
  'sandbox.rcpt.doneBodyPlain': {
    zh: '{name} {version} 已经装好。沙箱还开着，可以接着试；改了插件之后再装一次就是更新。',
    en: '{name} {version} is installed. The sandbox stays open so you can keep trying it; install again after you change the plugin to update it.',
  },
  'sandbox.rcpt.reinstall': { zh: '重新安装', en: 'Install again' },
  'sandbox.rcpt.failTitle': { zh: '没装上', en: 'Not installed' },
  'sandbox.rcpt.ok': { zh: '知道了', en: 'Got it' },
})

type T = (key: string, vars?: Record<string, string | number>) => string

/** 版本号前面带个空格塞进句子里(没有版本就整段省掉)。 */
const ver = (v: string): string => (v ? ` ${v}` : '')

/** 卡片上的事实行;none / unknown / 没有 = 不说。 */
export function installedFact(inst: SandboxInstalled | null | undefined, name: string, t: T): { kind: 'ok' | 'warn'; text: string } | null {
  if (!inst) return null
  if (inst.state === 'same') return { kind: 'ok', text: t('sandbox.inst.same', { name, version: inst.version }) }
  if (inst.state === 'older') return { kind: 'warn', text: t('sandbox.inst.older', { version: ver(inst.version), n: inst.changed }) }
  if (inst.state === 'store') return { kind: 'warn', text: t('sandbox.inst.store', { version: ver(inst.version) }) }
  return null
}

/** 安装按钮该怎么摆:hidden = 不给装(另装着一份,换成「打开插件设置」);done = 装的就是这一份。 */
export type InstallButton = 'install' | 'update' | 'done' | 'blocked'
export function installButton(inst: SandboxInstalled | null | undefined): InstallButton {
  if (inst?.state === 'same') return 'done'
  if (inst?.state === 'older') return 'update'
  if (inst?.state === 'store') return 'blocked'
  return 'install'
}

/** 安装失败给人看的话(主进程的英文原文只在 code = error 时带上)。取消 / 成功 = ''。 */
export function installErrorText(r: { ok: boolean; code?: string; error?: string; cancelled?: boolean }, t: T): string {
  if (r.ok || r.cancelled) return ''
  if (r.code === 'store') return t('sandbox.inst.err.store')
  if (r.code === 'same') return t('sandbox.inst.err.same')
  if (r.code === 'changed') return t('sandbox.inst.err.changed')
  if (r.code === 'no_sandbox') return t('sandbox.inst.err.noSandbox')
  return r.error ? t('sandbox.inst.err.other', { error: r.error.slice(0, 300) }) : ''
}
