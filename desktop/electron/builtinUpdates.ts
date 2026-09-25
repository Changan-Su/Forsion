/**
 * 内置捆绑包的 npm 更新通道(2026-09-25,首例 Computer Use):在跑的桌面后台问 npm 有没有更新的版本,有就下载、
 * 校验、解到 `<pluginsRoot>/.pending/<随包目录名>/`,**下次启动**由 seedBuiltinBundles 换上。
 *
 * 为什么不当场换:引擎只在启动时扫一次 bundle 根,在跑的引擎与 helper 还拿着旧文件;播种是启动期唯一写点,
 * 版本比较 / 原子替换 / 永不降级 / 标「内置」都在那里。更新器只负责把字节安全地放进暂存区。
 *
 * 写暂存区前的闸(缺一不写):
 *  · registry 只用调用方给的官方 + npmmirror,不读任何覆盖 env;tarball 地址按 registry 规范路径自己拼,不跟 packument 里的 URL;
 *  · tarball 必须对上 packument 的 sha512 integrity(没有 sha512 就不装,不退到 sha1);
 *  · 包内 manifest 的 id 必须等于随包那份、version 必须等于 latest(坏发布不能覆盖别的插件目录);
 *  · gatePluginManifest(apiVersion / minAppVersion):插件更新不能把宿主带崩,宿主太旧就等宿主升级;
 *  · 解包:minitar 拒 symlink / 硬链接,safeJoin 防穿越,条目数与解压总量封顶。
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { cmpVersion, gatePluginManifest } from '@amadeus-shared/ipc'
import { BUILTIN_BUNDLE_PACKAGES, installedDirFor, pendingDirFor, readManifest, type BundleManifest } from './builtinPlugins'
import { downloadZip, GZIP_MAGIC } from './marketInstall'
import { stripTopDir, untar } from './minitar'

export const NPM_OFFICIAL = 'https://registry.npmjs.org'
export const NPM_MIRROR = 'https://registry.npmmirror.com'
const MAX_ENTRIES = 5000
const MAX_UNPACK = 500 * 1024 * 1024

export type RegistryFetch = (url: string, init: { signal: AbortSignal; headers?: Record<string, string> }) => Promise<Response>

/** 开了「中国大陆镜像」先问 npmmirror,否则先官方;另一个兜底。 */
export const registryOrder = (mirror: string | undefined): string[] =>
  mirror === 'china' ? [NPM_MIRROR, NPM_OFFICIAL] : [NPM_OFFICIAL, NPM_MIRROR]

/** npm registry 的规范 tarball 路径(npmjs 与 npmmirror 同构):`<registry>/@scope/name/-/name-<ver>.tgz`。 */
export const tarballUrl = (registry: string, pkg: string, version: string): string =>
  `${registry}/${pkg}/-/${pkg.replace(/^@[^/]+\//, '')}-${version}.tgz`

/** latest 的版本与 integrity;先答上的 registry 排在下载候选首位。 */
async function resolveLatest(pkg: string, registries: string[], fetchFn: RegistryFetch): Promise<{ version: string; integrity: string; tarballs: string[] }> {
  const failed: string[] = []
  for (const [i, registry] of registries.entries()) {
    try {
      const res = await fetchFn(`${registry}/${pkg.replace('/', '%2f')}`, {
        signal: AbortSignal.timeout(15_000),
        headers: { accept: 'application/vnd.npm.install-v1+json' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const doc = (await res.json()) as { 'dist-tags'?: Record<string, string>; versions?: Record<string, { dist?: { integrity?: string } }> }
      const version = doc['dist-tags']?.latest
      const integrity = version ? doc.versions?.[version]?.dist?.integrity?.split(/\s+/)[0] : undefined
      if (!version || !integrity?.startsWith('sha512-')) throw new Error('no latest version with sha512 integrity')
      const order = [registry, ...registries.filter((_, j) => j !== i)]
      return { version, integrity, tarballs: order.map((r) => tarballUrl(r, pkg, version)) }
    } catch (e) {
      failed.push(`${new URL(registry).host}: ${(e as Error)?.message || e}`)
    }
  }
  throw new Error(failed.join(' · '))
}

/** 落盘防穿越:rel 归一后必须仍在 root 之内(同引擎 npmInstall.safeJoin)。 */
function safeJoin(root: string, rel: string): string {
  const out = path.join(root, rel.replace(/\\/g, '/').replace(/^\/+/, ''))
  const back = path.relative(root, out)
  if (!back || back.startsWith('..') || path.isAbsolute(back)) throw new Error(`unsafe path in package: ${rel}`)
  return out
}

/** 本进程里验过「宿主不兼容」的版本:别每 6 小时重下一遍。跨进程不记,下次启动最多再下一次。 */
const incompatible = new Set<string>()

export interface BuiltinUpdateOpts {
  pluginsRoot: string
  /** 与 packages 一一对应的随包来源(builtinBundleSources);随包 manifest 是「这个包该是哪个 id」的锚。 */
  sources: string[]
  appVersion: string
  registries: string[]
  fetch: RegistryFetch
  packages?: readonly string[]
  platform?: NodeJS.Platform
  log?: (m: string) => void
}

/** 查一遍各内置包;有更新的下载进暂存区。返回暂存了的 `id@version`。逐包吞错,只进 log。 */
export async function checkBuiltinUpdates(o: BuiltinUpdateOpts): Promise<string[]> {
  const log = o.log ?? ((m: string) => console.log(m))
  const platform = o.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'win32') return [] // 与播种同口径:不播的平台下了也用不上
  const staged: string[] = []
  for (const [i, pkg] of (o.packages ?? BUILTIN_BUNDLE_PACKAGES).entries()) {
    const src = o.sources[i]
    try {
      const bundled = src ? await readManifest(src) : null
      if (!bundled) continue
      const pendingPath = pendingDirFor(o.pluginsRoot, src)
      const installedDir = await installedDirFor(o.pluginsRoot, bundled.id)
      const have = [bundled, installedDir ? await readManifest(installedDir) : null, await readManifest(pendingPath)]
        .filter((m): m is BundleManifest => !!m && m.id === bundled.id)
        .reduce((v, m) => (cmpVersion(m.version, v) > 0 ? m.version : v), '0.0.0')
      const latest = await resolveLatest(pkg, o.registries, o.fetch)
      if (cmpVersion(latest.version, have) <= 0 || incompatible.has(`${pkg}@${latest.version}`)) continue

      const tgz = await downloadZip(latest.tarballs, o.fetch, undefined, GZIP_MAGIC)
      if (`sha512-${createHash('sha512').update(tgz).digest('base64')}` !== latest.integrity) throw new Error('integrity mismatch')
      const entries = stripTopDir(untar(gunzipSync(tgz, { maxOutputLength: MAX_UNPACK })))
      if (entries.length > MAX_ENTRIES) throw new Error(`too many entries (${entries.length})`)
      const raw = entries.find((e) => e.path === 'manifest.json')
      const manifest = raw ? (JSON.parse(raw.data.toString('utf8')) as Record<string, unknown>) : null
      if (manifest?.id !== bundled.id || manifest.version !== latest.version) {
        throw new Error(`manifest ${String(manifest?.id)}@${String(manifest?.version)} is not ${bundled.id}@${latest.version}`)
      }
      const gate = gatePluginManifest(manifest, o.appVersion)
      if (gate) {
        incompatible.add(`${pkg}@${latest.version}`)
        log(`[builtin-updates] ${bundled.id}@${latest.version} 需要${gate === 'minApp' ? `宿主 ≥ ${String(manifest.minAppVersion)}` : '另一版插件 API'},等 Forsion 升级`)
        continue
      }

      // staging 与暂存区同在 .pending/ 下(点开头,两边加载器都看不见),写完一次 rename 换位。
      const staging = path.join(path.dirname(pendingPath), `.${path.basename(pendingPath)}.staging-${process.pid}`)
      await fs.rm(staging, { recursive: true, force: true })
      try {
        for (const e of entries) {
          const dest = safeJoin(staging, e.path)
          await fs.mkdir(path.dirname(dest), { recursive: true })
          await fs.writeFile(dest, e.data)
          if (e.mode && process.platform !== 'win32') await fs.chmod(dest, e.mode) // helper 可执行位
        }
        await fs.rm(pendingPath, { recursive: true, force: true })
        await fs.rename(staging, pendingPath)
      } finally {
        await fs.rm(staging, { recursive: true, force: true })
      }
      staged.push(`${bundled.id}@${latest.version}`)
      log(`[builtin-updates] ${bundled.id} ${have} → ${latest.version} 已下载,下次启动生效`)
    } catch (e) {
      log(`[builtin-updates] ${pkg} 检查更新失败(忽略,下次再试):${(e as Error)?.message || e}`)
    }
  }
  return staged
}
