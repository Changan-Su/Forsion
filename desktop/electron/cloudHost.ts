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
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { gatePluginManifest } from '@amadeus-shared/ipc'
import { activeBundleDir, readManifest, type BuiltinSource } from './builtinPlugins'
import { verifyBundleSignature } from './bundleSignature'
import type { RemoteBackendFactory } from './remotesync/backends'
import type { Creds, ExternalCredsChange } from './accountCore'

/** 验签必须覆盖的文件:入口本身,以及决定 id / 版本 / 门禁的 manifest(否则改一改未签的 minAppVersion 就能改装载判断)。 */
export const signedEssentials = (entry: string): string[] => [entry, 'manifest.json']

/** Genesis 主进程给内置包主进程半身的接缝。Forsion-Extend 仓 src/desktop/host.d.ts 是它的镜像,两边同改。
 *  入口是从一次性临时文件跑起来的(见下),所以它必须是自包含单文件:`import.meta.url` 相对的邻居文件不存在,设计如此。 */
export interface CloudHost {
  /** 当前账号的云端基址(无尾斜杠)与 token(空串=未登录)。token 只在主进程流转,绝不下发渲染层。 */
  getCloud(): Promise<{ base: string; token: string }>
  /** 等价 ipcMain.handle;宿主记下通道名,preload 据此只保留有人接的桥键(cloud:present)。 */
  handle(channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown): void
  openExternal(url: string): Promise<void>
  isTrustedSender(e: IpcMainInvokeEvent): boolean
  log(message: string): void
  // ── 0.2 起(Forsion Connect 用)。新成员一律只增不改:Extend 用 hasXxxHost 探测,老宿主缺了就跳过那一块并 log ──
  /** Coding Space 项目根(~/Forsion/Project;dev = ~/Forsion-Dev/Project)。 */
  projectsRoot(): string
  /** 与预览完全相同的转译器(发布产物 = 预览所见);不能转译的扩展名返回 null。 */
  transpileForServe(code: string, ext: string, filePath?: string): string | null
  /** 预览服务器的 MIME 表(按小写扩展名,含点);未知返回 undefined。 */
  mimeOf(ext: string): string | undefined
  /** codePreview 本地服务器的 Forsion 挂钩:/forsion-connect.js 的 SDK 源码 + /__forsion/* 的云端代理。 */
  setPreviewHooks(h: { sdkJs?: string; proxy?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): void
  // ── 0.3 起(penzor 远程同步后端 / 账号核心用)──
  /** auth.json **原样**同步读(空串 = 没有),不做 DEFAULT_CLOUD_URL 回落:身份、基线指纹、镜像目录都从这里推,
   *  getCloud() 的回落会把「没登录」凭空造成一个账号。 */
  readCreds(): { cloudUrl: string; token: string }
  /** 当前账号身份(shared/forsionAccount.ts 的 forsionAccountId(readCreds()));未登录 / 拿不到 = null。 */
  accountId(): string | null
  /** 远程同步(设置 → 同步 → 本地库远程同步)注册一个外置后端(remotesync/backends.ts);remotesync:get 会把 kind 报给渲染层。 */
  registerRemoteSyncBackend(kind: string, factory: RemoteBackendFactory): void
  // ── 0.3 起(账号核心:auth:* 通道住在 Extend,编排在 accountCore.ts)──
  /** Forsion 家目录(auth.json / auth-accounts.json 所在;dev = ~/.forsion-dev)。 */
  homeDir(): string
  appVersion(): string
  /** 向全部窗口 webContents.send。 */
  broadcast(channel: string, payload: unknown): void
  /** managed 变体的引擎状态(auth:status 的 backendState 轴);external / 无 agent 后端 = null。 */
  accountBackendState(): Promise<string | null>
  /** 账号变更串行队列;commit / clear 不自带排队,调用方用它包一层(与今天 runAuthTransition(…withPreparedAccount) 同构)。 */
  accountTransition<T>(fn: () => Promise<T>): Promise<T>
  /** 换成这份凭据:握手 → 停同步 → 写 cloudUrl → 写 auth.json → 引擎重启 → 设备互联 → 起同步 → 广播 auth:changed。assertCurrent 抛错即中止;
   *  onCommitPoint 在最后一次 assertCurrent 通过、写 auth.json 之前同步调一次(Extend 的记账 / 忘账号 / 清缓存 / 发吊销都放这里,握手失败一样不发生)。 */
  accountCommit(creds: Creds, assertCurrent?: () => void, onCommitPoint?: () => void): Promise<void>
  /** 清 token(保留 cloudUrl / model),链同上;不做任何 HTTP(服务端吊销由调用方在 onCommitPoint 里自己发)。 */
  accountClear(assertCurrent?: () => void, onCommitPoint?: () => void): Promise<void>
  /** 只换 auth.json 不重启(滑动续期),并同步 watcher 的去重快照。 */
  writeCreds(patch: Partial<Creds>): void
  /** auth.json 被别的来源改了(终端 tangu login / logout、手改):watcher 在走传播链之前先调它。 */
  onExternalCredsChange(cb: (change: ExternalCredsChange) => void): void
  /** 登记滑动续期实现;宿主启动时(4s 封顶,排在引擎启动之前)与之后每 24h 调一次。 */
  setTokenRefresher(fn: (timeoutMs?: number) => Promise<void>): void
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
