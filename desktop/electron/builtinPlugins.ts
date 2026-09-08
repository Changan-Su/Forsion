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
 * 随包 npm 包复制);dev = `<appPath>/node_modules/<pkg>`(同一个包,`npm run vendor:cu` 刷新)。
 * 只在 darwin / win32 播种:这些捆绑包的引擎侧自己按平台门控(Linux helper 从未真机验收),
 * 在没有工具面的平台上多一张插件卡只是噪音。
 *
 * 播种过的 id 记在进程内(builtinPluginIds),readExternalPlugins 据此标 `builtin`:设置页显示「内置」、
 * 不给卸载按钮(不想用就关开关;删了目录下次启动也会种回来 —— 内置的语义就是「一直在」)。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { cmpVersion } from '@amadeus-shared/ipc'

/** 随 App 内置的捆绑包 npm 包名(dev 从 node_modules 取;打包版按包名的最后一段落在 resources/bundled-plugins/)。 */
export const BUILTIN_BUNDLE_PACKAGES: readonly string[] = ['@forsion/tangu-computer-use']

/** 打包版落点目录名 = 包名去掉 scope(与 electron-builder.config.cjs 的 extraResources `to` 同一约定)。 */
export const bundledDirName = (pkg: string): string => pkg.replace(/^@[^/]+\//, '')

export interface BuiltinSourceOpts {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}

/** 播种来源目录(存在与否不在这里判,seedBuiltinBundles 逐个 stat)。 */
export function builtinBundleSources(o: BuiltinSourceOpts): string[] {
  return BUILTIN_BUNDLE_PACKAGES.map((pkg) =>
    o.isPackaged
      ? path.join(o.resourcesPath, 'bundled-plugins', bundledDirName(pkg))
      : path.join(o.appPath, 'node_modules', ...pkg.split('/')),
  )
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

async function readManifest(dir: string): Promise<{ id: string; version: string } | null> {
  try {
    const m = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')) as { id?: unknown; version?: unknown }
    if (typeof m.id !== 'string' || !SAFE_PLUGIN_ID.test(m.id)) return null
    return { id: m.id, version: typeof m.version === 'string' && m.version ? m.version : '0.0.0' }
  } catch {
    return null
  }
}

/** 已装同 id 的目录(目录名可与 id 不同:市场按 install_slug 落目录,readExternalPlugins 认 manifest id)。 */
async function installedDirFor(pluginsRoot: string, id: string): Promise<string | null> {
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
  sources: string[],
  opts: { platform?: NodeJS.Platform; log?: (m: string) => void } = {},
): Promise<SeedBundlesReport> {
  const report: SeedBundlesReport = { installed: [], updated: [], kept: [], skipped: [] }
  const platform = opts.platform ?? process.platform
  const log = opts.log ?? ((m: string) => console.log(m))
  if (platform !== 'darwin' && platform !== 'win32') return report
  for (const src of sources) {
    try {
      const bundled = await readManifest(src)
      if (!bundled) {
        report.skipped.push(src)
        continue // 没随包(单品变体 / 包没装)是常态,不是错
      }
      const current = await installedDirFor(pluginsRoot, bundled.id)
      const installed = current ? await readManifest(current) : null
      if (!installed) {
        await fs.mkdir(pluginsRoot, { recursive: true })
        await replaceDir(src, path.join(pluginsRoot, bundled.id))
        report.installed.push(bundled.id)
        log(`[builtin-plugins] 已内置 ${bundled.id}@${bundled.version}`)
      } else if (cmpVersion(bundled.version, installed.version) > 0) {
        await replaceDir(src, current!)
        report.updated.push(bundled.id)
        log(`[builtin-plugins] ${bundled.id} ${installed.version} → ${bundled.version}(随 App 更新)`)
      } else {
        report.kept.push(bundled.id)
      }
      builtinIds.add(bundled.id)
    } catch (e) {
      log(`[builtin-plugins] 播种 ${src} 失败(忽略,下次启动再试):${(e as Error)?.message || e}`)
    }
  }
  return report
}

/** 测试用:清掉进程内的内置 id 集。 */
export function _resetBuiltinIdsForTest(): void {
  builtinIds.clear()
}
