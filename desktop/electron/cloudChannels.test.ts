/**
 * 宿主与 Forsion Extend 的 IPC 通道不许重名(2026-09-28,第三刀起的启动闸)。
 * Extend 在 whenReady 早段(cloudHost.ts)先 handle 它的通道;之后 main.ts / amadeus/ipc.ts / remotesyncIpc.ts 若再对同名通道
 * ipcMain.handle,Electron 直接抛 —— whenReady 回调余下部分(含 createWindow)全部不跑,表现为「起不来窗口」。
 * 这里读 node_modules 里钉住的那份 @forsion/extend(与 release-content / 播种来源同一份),假 host 收集它注册的通道,
 * 再扫宿主源码里的通道字面量(+ amadeus/sync/ipcKeys 的常量),两边不许有交集。搬一块处理器进 Extend 时,宿主那份必须同一提交删掉。
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error 私有包不带类型;这里只用运行时导出
import { registerCloud } from '@forsion/extend/dist/desktop.mjs'

const ROOT = join(__dirname)
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === 'node_modules' || name.startsWith('.')) continue
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !/\.d\.ts$/.test(name)) yield p
  }
}

function hostChannels(): Set<string> {
  const out = new Set<string>()
  // 单双引号字面量都认;amadeus/ipc.ts 的 handle() 包装只注册 @amadeus-shared/ipc 的 IPC.* 常量(vault 面,Extend 不碰);SYNC_IPC 0.4 起归 Extend
  const re = /ipcMain\.(?:handle|on)\(\s*(['"])([^'"]+)\1/g
  for (const file of walk(ROOT)) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(re)) out.add(m[2])
  }
  return out
}

async function extendChannels(): Promise<string[]> {
  const channels: string[] = []
  const host = {
    getCloud: async () => ({ base: 'https://cloud.test', token: '' }),
    handle: (channel: string) => { channels.push(channel) },
    openExternal: async () => {},
    isTrustedSender: () => true,
    log: () => {},
    projectsRoot: () => '/tmp/projects',
    transpileForServe: () => null,
    mimeOf: () => undefined,
    setPreviewHooks: () => {},
    readCreds: () => ({ cloudUrl: '', token: '' }),
    accountId: () => null,
    registerRemoteSyncBackend: () => {},
    homeDir: () => '/tmp/forsion-home',
    appVersion: () => '2.11.5',
    broadcast: () => {},
    accountBackendState: async () => null,
    accountTransition: (fn: () => Promise<unknown>) => fn(),
    accountCommit: async () => {},
    accountClear: async () => {},
    writeCreds: () => {},
    onExternalCredsChange: () => {},
    setTokenRefresher: () => {},
    setAmadeusSyncFactory: () => {},
  }
  await registerCloud(host)
  return channels
}

describe('cloud channels: host × Extend 不重名', () => {
  it('Extend 注册的每个通道,宿主源码里都没有同名 ipcMain.handle/on', async () => {
    const mine = hostChannels()
    const theirs = await extendChannels()
    expect(mine.size).toBeGreaterThan(100) // 仪器自检:扫描器真读到了宿主源码
    expect(theirs.length).toBeGreaterThanOrEqual(8) // 账号面 8 条起
    const clash = theirs.filter((c) => mine.has(c))
    expect(clash).toEqual([])
    expect(new Set(theirs).size).toBe(theirs.length) // Extend 自己也不重复注册
  })
})
