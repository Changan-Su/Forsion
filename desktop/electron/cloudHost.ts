/**
 * 内置捆绑包的主进程半身(2026-09-27,首例 Forsion Extend):桌面插件宿主只求值渲染层 main.js、引擎只装 tangu-plugins/,
 * 主进程从来没有插件装载器。云端账号那些 IPC 处理器要搬出公开仓,就得有这一条:清单(builtinBundles.json)里
 * 带 `desktop` 的包,播种后由这里 import 它的入口,把宿主接缝 CloudHost 递过去,入口自己 handle 通道。
 *
 * 信任闸(缺一不装):清单白名单(市场装的包永远没有 desktop 字段)→ 已装那份的 manifest id 等于清单 id →
 * gatePluginManifest(apiVersion / minAppVersion)→ 包内 SIGNATURE 用清单里钉的公钥核过且覆盖入口文件(bundleSignature.ts)。
 * 装的是 activeBundleDir(已装副本优先,同权限引导跑 setup-helper 的口径):npm 更新换上的新版就在那里。
 * 入口缺席 / 验签失败 = 这台机器没有云端账号面:preload 按 `cloud:present` 删键,渲染层门控自动隐藏,不报错。
 *
 * ponytail: 只在启动时装一次,没有卸载 / 热重载 —— 更新本来就是下次启动生效(播种是唯一写点)。
 */
import type { IpcMainInvokeEvent } from 'electron'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { gatePluginManifest } from '@amadeus-shared/ipc'
import { activeBundleDir, readManifest, type BuiltinSource } from './builtinPlugins'
import { verifyBundleSignature } from './bundleSignature'

/** 验签必须覆盖的文件:入口本身,以及决定 id / 版本 / 门禁的 manifest(否则改一改未签的 minAppVersion 就能改装载判断)。 */
export const signedEssentials = (entry: string): string[] => [entry, 'manifest.json']

/** Genesis 主进程给内置包主进程半身的接缝。Forsion-Extend 仓 src/desktop/host.d.ts 是它的镜像,两边同改。
 *  入口是从一次性临时文件跑起来的(见下),所以它必须是自包含单文件:`import.meta.url` 相对的邻居文件不存在,设计如此。 */
export interface CloudHost {
  /** 当前账号的云端基址(无尾斜杠)与 token(空串=未登录)。token 只在主进程流转,绝不下发渲染层。 */
  getCloud(): Promise<{ base: string; token: string }>
  /** 等价 ipcMain.handle。 */
  handle(channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown): void
  openExternal(url: string): Promise<void>
  isTrustedSender(e: IpcMainInvokeEvent): boolean
  log(message: string): void
}
export type RegisterCloud = (host: CloudHost) => void | Promise<void>

export interface LoadDesktopEntriesOpts {
  pluginsRoot: string
  sources: readonly BuiltinSource[]
  appVersion: string
  host: CloudHost
  /** 验过的入口字节先写进这里的一次性私有临时目录再 import(见下);主进程给 app.getPath('userData')。 */
  tempRoot: string
  /** 测试注入;缺省 import(file://)。 */
  importer?: (file: string) => Promise<Record<string, unknown>>
  log?: (m: string) => void
}

/** 装载清单里带 desktop 的包的主进程入口。返回装成的 manifest id。逐包吞错,只进 log。 */
export async function loadBuiltinDesktopEntries(o: LoadDesktopEntriesOpts): Promise<string[]> {
  const log = o.log ?? ((m: string) => console.log(m))
  const importer = o.importer ?? ((file: string) => import(pathToFileURL(file).href) as Promise<Record<string, unknown>>)
  const loaded: string[] = []
  for (const source of o.sources) {
    if (!source.desktop) continue
    try {
      // 已装副本优先;它验不过(用户目录里被改过)就退回随包那份 —— 用户可写目录里的东西只能升级、不能让云端面消失。
      const active = await activeBundleDir(o.pluginsRoot, source.dir)
      const candidates = active === source.dir ? [active] : [active, source.dir]
      let dir: string | null = null
      let manifest: Awaited<ReturnType<typeof readManifest>> = null
      let digests: Record<string, string> = {}
      for (const candidate of candidates) {
        const m = await readManifest(candidate)
        if (!m || m.id !== source.id) {
          log(`[cloud-host] ${source.pkg}:${candidate} 的 manifest ${m ? `id=${m.id}` : '缺失'},跳过这份`)
          continue
        }
        const gate = gatePluginManifest(m, o.appVersion)
        if (gate) {
          log(`[cloud-host] ${m.id}@${m.version} 需要${gate === 'minApp' ? `宿主 ≥ ${String(m.minAppVersion)}` : '另一版插件 API'},跳过这份`)
          continue
        }
        const verdict = await verifyBundleSignature(candidate, source.desktop.signingKey, signedEssentials(source.desktop.entry))
        if (!verdict.ok) {
          log(`[cloud-host] ${m.id}@${m.version} 验签失败(${candidate}):${verdict.reason}`)
          continue
        }
        dir = candidate
        manifest = m
        digests = verdict.digests
        break
      }
      if (!dir || !manifest) {
        log(`[cloud-host] ${source.pkg} 没有可装载的副本,这台机器没有云端账号面`)
        continue
      }
      // 执行的必须是验过的那份字节:已装目录可写,「验签读一遍、import 再读一遍」中间被换掉就等于没验。
      // 所以读进内存 → 对着签名表再核一次这份字节 → 写进一次性私有临时目录 → import 那个文件 → 删。
      const entryRel = source.desktop.entry
      const bytes = await fs.readFile(path.join(dir, ...entryRel.split('/')))
      if (createHash('sha256').update(bytes).digest('hex') !== digests[entryRel]) {
        log(`[cloud-host] ${manifest.id}@${manifest.version} 的入口在验签后被改动,不装载`)
        continue
      }
      await fs.mkdir(o.tempRoot, { recursive: true }) // 首次启动 userData 可能还没建
      const tmp = await fs.mkdtemp(path.join(o.tempRoot, 'cloud-host-'))
      let mod: Record<string, unknown>
      try {
        const file = path.join(tmp, path.basename(entryRel))
        await fs.writeFile(file, bytes, { mode: 0o600 })
        mod = await importer(file)
      } finally {
        await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
      }
      const register = (mod.registerCloud ?? (mod.default as Record<string, unknown> | undefined)?.registerCloud) as RegisterCloud | undefined
      if (typeof register !== 'function') {
        log(`[cloud-host] ${manifest.id}@${manifest.version} 的入口没有导出 registerCloud,不装载`)
        continue
      }
      await register(o.host)
      loaded.push(manifest.id)
      log(`[cloud-host] 已装载 ${manifest.id}@${manifest.version}(${dir})`)
    } catch (e) {
      log(`[cloud-host] 装载 ${source.pkg} 失败(忽略):${(e as Error)?.message || e}`)
    }
  }
  return loaded
}
