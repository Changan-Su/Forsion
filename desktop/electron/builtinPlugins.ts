/**
 * 随 App 内置的 Forsion 插件捆绑包(bundle)—— 启动早期播种进 `<home>/plugins/<id>/`。
 *
 * 为什么是「播种」而不是「加第二个搜索根」:桌面(readExternalPlugins)与引擎(bundles.ts)都只认
 * `<home>/plugins` 这一个根,卸载/级联/Space 归属/技能扫描全部挂在它上面。多一个根 = 每一处都要再学一遍;
 * 播种一次,读取侧零改动。「内置与外置的唯一区别是提前装好了」(mindmap 迁出时的原则)在这里是字面意思。
 *
 * 替换规则只看版本号(manifest.version,cmpVersion):
 *   · 目标不存在            → 装
 *   · 随包版本 > 已装版本   → 原子替换(staging + rename,失败回滚,绝不留空壳 —— 空壳会被宿主扫到,比没装更糟)
 *   · 其余(相同 / 已装更新) → 不碰。用户从市场装了更新的版本、或开发者 install.sh 装了在做的版本,都不能被降级。
 * 不用技能播种那套目录树哈希:插件目录是安装产物不是用户编辑的东西,版本号就是它的身份;
 * 而「版本相同内容不同」正是开发者在迭代,他有 install.sh。
 *
 * 播种来源:打包版 = `resources/bundled-plugins/<name>`(electron-builder extraResources 从 node_modules 里的
 * 随包 npm 包复制);dev = `<appPath>/node_modules/<pkg>`(同一个包)。随包版本 = desktop/package.json 里钉死的
 * npm 精确版本,Dependabot 在 npm 发了新版时提 PR 升级。别用本地构建替换它:本地 build:native 是 ad-hoc 签名,
 * 会让 Mac 用户重新授权(release-content.check 会拦)。
 * 内置包清单 = builtinBundles.json(单一来源:这里、builtinUpdates、electron-builder.config.cjs、release-content.check.cjs、
 * dependabot 绑定测试都读它):每个包自己声明 platforms(电脑操作只 darwin / win32 —— 它的 Linux helper 从未真机验收,
 * 在没有工具面的平台上多一张插件卡只是噪音;Forsion Extend 全平台),不在名单里的平台既不播种也不更新。
 * 带 `desktop` 的包还有主进程半身:入口由 cloudHost.ts 在播种后 import 进主进程,所以来源(随包 / npm 暂存)
 * 换上之前先用钉在清单里的公钥核包内签名(bundleSignature.ts),验不过的那份不换。
 *
 * 第二个来源 = npm 更新器(builtinUpdates.ts)下载好的新版,暂存在 `<pluginsRoot>/.pending/<随包目录名>/`:
 * 同 id、比随包新、过 gatePluginManifest(apiVersion / minAppVersion)才顶替随包来源,之后走同一套替换规则。
 * 每次播种结束整个 `.pending/` 清掉(用过的、过时的、不兼容的、崩溃留下的半成品都删),更新器按需重下。
 * 播种仍是启动期唯一的写点。
 *
 * 播种过的 id 记在进程内(builtinPluginIds),readExternalPlugins 据此标 `builtin`:设置页显示「内置」、
 * 不给卸载按钮(不想用就关开关;删了目录下次启动也会种回来 —— 内置的语义就是「一直在」)。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { cmpVersion, gatePluginManifest } from '@amadeus-shared/ipc'
import bundlesJson from './builtinBundles.json'
import { verifyBundleSignature } from './bundleSignature'

export interface BuiltinBundle {
  /** npm 包名(dev 从 node_modules 取;打包版按包名去 scope 落在 resources/bundled-plugins/)。 */
  pkg: string
  /** 随包 manifest.json 必须是这个 id(release-content 核;cloudHost 装载前也核)。 */
  id: string
  /** 只在这些平台播种 / 更新。 */
  platforms: readonly string[]
  /** 主进程半身:entry 相对包根;signingKey = 核 SIGNATURE 的 ed25519 公钥(SPKI PEM)。有 desktop 就必须验签。 */
  desktop?: { entry: string; signingKey: string }
  /** 宿主要求的最低随包版本:宿主每删掉一块原生实现(账号面 / Connect …)就抬到提供那块的包版本,
   *  release-content 与 builtinBundles.test 核「钉的版本 ≥ 它」—— 否则钉着旧版的干净构建会静默丢功能。 */
  minVersion?: string
}

/** 随 App 内置的捆绑包清单(builtinBundles.json)。 */
export const BUILTIN_BUNDLES: readonly BuiltinBundle[] = bundlesJson
export const BUILTIN_BUNDLE_PACKAGES: readonly string[] = BUILTIN_BUNDLES.map((b) => b.pkg)

/** 打包版落点目录名 = 包名去掉 scope(与 electron-builder.config.cjs 的 extraResources `to` 同一约定)。 */
export const bundledDirName = (pkg: string): string => pkg.replace(/^@[^/]+\//, '')

export interface BuiltinSourceOpts {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
  platform?: NodeJS.Platform
}

/** 清单项 + 随包来源目录。 */
export interface BuiltinSource extends BuiltinBundle {
  dir: string
}

/** 当前平台要播种的内置包及其随包来源目录(存在与否不在这里判,seedBuiltinBundles 逐个 stat)。 */
export function builtinBundleSources(o: BuiltinSourceOpts): BuiltinSource[] {
  const platform = o.platform ?? process.platform
  return BUILTIN_BUNDLES.filter((b) => b.platforms.includes(platform)).map((b) => ({
    ...b,
    dir: o.isPackaged
      ? path.join(o.resourcesPath, 'bundled-plugins', bundledDirName(b.pkg))
      : path.join(o.appPath, 'node_modules', ...b.pkg.split('/')),
  }))
}

const SAFE_PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

const builtinIds = new Set<string>()
/** 本进程播种/确认过的内置插件 id(manifest id)。设置页据此标「内置」+ 隐藏卸载。 */
export const builtinPluginIds = (): ReadonlySet<string> => builtinIds

export interface SeedBundlesReport {
  installed: string[]
  updated: string[]
  kept: string[]
  skipped: string[]
}

export interface BundleManifest {
  id: string
  version: string
  apiVersion?: unknown
  minAppVersion?: unknown
}

export async function readManifest(dir: string): Promise<BundleManifest | null> {
  try {
    const m = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>
    if (typeof m.id !== 'string' || !SAFE_PLUGIN_ID.test(m.id)) return null
    return {
      id: m.id,
      version: typeof m.version === 'string' && m.version ? m.version : '0.0.0',
      apiVersion: m.apiVersion,
      minAppVersion: m.minAppVersion,
    }
  } catch {
    return null
  }
}

/** npm 更新器的暂存目录 `<pluginsRoot>/.pending/<随包目录名>`。点开头:桌面 readExternalPlugins 与引擎 bundleDirs 都看不见。 */
export const pendingDirFor = (pluginsRoot: string, source: string): string =>
  path.join(pluginsRoot, '.pending', path.basename(source))

/** 已装同 id 的目录(目录名可与 id 不同:市场按 install_slug 落目录,readExternalPlugins 认 manifest id)。 */
export async function installedDirFor(pluginsRoot: string, id: string): Promise<string | null> {
  const direct = path.join(pluginsRoot, id)
  if (await readManifest(direct).then((m) => m?.id === id)) return direct
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(pluginsRoot, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === id) continue
    const dir = path.join(pluginsRoot, e.name)
    if ((await readManifest(dir))?.id === id) return dir
  }
  return null
}

/** 实际生效的那份捆绑包:已装的同 id 副本(播种保证它不比随包旧;npm 更新 / install.sh 装的会更新),没装才退回随包来源。
 *  凡是要「跑包里的脚本」的地方(桌面权限引导装 helper)都必须用这份:跑随包旧版会和引擎侧的新版互相把 helper
 *  换来换去,ad-hoc 签名每换一次 macOS 就要重新授权。 */
export async function activeBundleDir(pluginsRoot: string, source: string): Promise<string> {
  const bundled = await readManifest(source)
  return (bundled && (await installedDirFor(pluginsRoot, bundled.id))) || source
}

/** 原子落位:同盘 staging 整拷(解引用符号链接,播种结果自包含)→ 旧的挪开 → staging 换位 → 删旧;任一步失败回滚。
 *  中间目录一律 `.` 开头:硬杀进程留下的孤儿带着同一份 manifest.json,桌面 readExternalPlugins 与引擎 bundleDirs
 *  都跳过点开头的目录,否则孤儿会成为第二个同 id 的 bundle 根(07-27「同 id 旧副本会赢」那类事故)。 */
async function replaceDir(src: string, dest: string): Promise<void> {
  const staging = path.join(path.dirname(dest), `.${path.basename(dest)}.staging-${process.pid}`)
  const old = path.join(path.dirname(dest), `.${path.basename(dest)}.old-${process.pid}`)
  await fs.rm(staging, { recursive: true, force: true })
  try {
    await fs.cp(src, staging, { recursive: true, dereference: true, errorOnExist: false })
    const had = await fs.stat(dest).then(() => true, () => false)
    if (had) await fs.rename(dest, old)
    try {
      await fs.rename(staging, dest)
    } catch (e) {
      if (had) await fs.rename(old, dest).catch(() => {}) // 换不过去就把旧的放回来
      throw e
    }
    if (had) await fs.rm(old, { recursive: true, force: true })
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
}

/**
 * 把各内置捆绑包播种进 pluginsRoot。逐包吞错(一个坏包不能挡住启动,也不能挡住别的包),错误进 log。
 * 必须在引擎 spawn 与首次 listPlugins 之前 await 完 —— 引擎只在启动时扫一次 bundle 根。
 */
export async function seedBuiltinBundles(
  pluginsRoot: string,
  sources: ReadonlyArray<string | BuiltinSource>,
  opts: { log?: (m: string) => void; appVersion?: string | null } = {},
): Promise<SeedBundlesReport> {
  const report: SeedBundlesReport = { installed: [], updated: [], kept: [], skipped: [] }
  const log = opts.log ?? ((m: string) => console.log(m))
  for (const source of sources) {
    const src = typeof source === 'string' ? source : source.dir
    const signing = typeof source === 'string' ? undefined : source.desktop
    const pendingPath = pendingDirFor(pluginsRoot, src)
    try {
      const bundled = await readManifest(src)
      if (!bundled) {
        report.skipped.push(src)
        log(`[builtin-plugins] 随包来源缺失,跳过:${src}`) // 单品变体 / 包没装是常态;打包版由 release-content.check 拦
        continue
      }
      // 带主进程半身的包:换上之前先验签。验不过的那份不用 —— 暂存的退回随包来源,随包的整包跳过。
      const trusted = async (dir: string, what: string): Promise<boolean> => {
        if (!signing) return true
        const v = await verifyBundleSignature(dir, signing.signingKey, [signing.entry, 'manifest.json'])
        if (!v.ok) log(`[builtin-plugins] ${bundled.id} ${what}验签失败(${dir}):${v.reason}`)
        return v.ok
      }
      const pending = await readManifest(pendingPath)
      const usePending = !!pending && pending.id === bundled.id && cmpVersion(pending.version, bundled.version) > 0
        && !gatePluginManifest(pending, opts.appVersion ?? null) && (await trusted(pendingPath, '暂存的新版'))
      const from = usePending ? pendingPath : src
      const offered = usePending ? pending! : bundled
      const how = usePending ? 'npm 更新' : '随 App 更新'
      const current = await installedDirFor(pluginsRoot, bundled.id)
      const installed = current ? await readManifest(current) : null
      // 「永不降级」的唯一例外:已装那份是带主进程半身的包却验不过签名 —— 那不是我们发的字节,版本号写多高都不算数,
      // 换成可信的那份(装载器本来就不会载它,更新器也不把它的版本当基线;不换掉它就会永远卡在那里)。
      const installedTrusted = !installed || (await trusted(current!, '已装副本'))
      const replace = !installed || !installedTrusted || cmpVersion(offered.version, installed.version) > 0
      if (replace && !usePending && !(await trusted(src, '随包那份'))) {
        report.skipped.push(src)
        continue
      }
      if (!installed) {
        await fs.mkdir(pluginsRoot, { recursive: true })
        await replaceDir(from, path.join(pluginsRoot, bundled.id))
        report.installed.push(bundled.id)
        log(`[builtin-plugins] 已内置 ${bundled.id}@${offered.version}(${how})`)
      } else if (replace) {
        await replaceDir(from, current!)
        report.updated.push(bundled.id)
        log(`[builtin-plugins] ${bundled.id} ${installed.version} → ${offered.version}(${how}${installedTrusted ? '' : ';已装副本验签失败,换掉'})`)
      } else {
        report.kept.push(bundled.id)
      }
      builtinIds.add(bundled.id)
    } catch (e) {
      log(`[builtin-plugins] 播种 ${src} 失败(忽略,下次启动再试):${(e as Error)?.message || e}`)
    }
  }
  // 暂存区只活到下一次播种:用过的、过时的、不兼容的、换失败的(下次退回随包来源,不让一份坏下载每次启动都卡住)、
  // 更新器被杀留下的 staging 半成品,一律清掉。更新器按需重下。
  await fs.rm(path.join(pluginsRoot, '.pending'), { recursive: true, force: true }).catch(() => {})
  return report
}

/** 测试用:清掉进程内的内置 id 集。 */
export function _resetBuiltinIdsForTest(): void {
  builtinIds.clear()
}
