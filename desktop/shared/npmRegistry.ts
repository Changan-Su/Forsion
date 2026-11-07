/**
 * npm registry 的只读查询:桌面内置捆绑包 / 引擎更新(electron/builtinUpdates.ts、engineUpdates.ts)与
 * 手机核心插件更新(mobile/src/plugins/coreUpdates.ts)共用。fetch 由调用方给(主进程 net.fetch / WebView fetch),
 * registry 只用调用方给的官方 + npmmirror;tarball 地址按 registry 规范路径自己拼,不跟 packument 里的 URL。
 */
export type RegistryFetch = (url: string, init: { signal: AbortSignal; headers?: Record<string, string> }) => Promise<Response>

export const NPM_OFFICIAL = 'https://registry.npmjs.org'
export const NPM_MIRROR = 'https://registry.npmmirror.com'

/** 开了「中国大陆镜像」先问 npmmirror,否则先官方;另一个兜底。 */
export const registryOrder = (mirror: string | undefined): string[] =>
  mirror === 'china' ? [NPM_MIRROR, NPM_OFFICIAL] : [NPM_OFFICIAL, NPM_MIRROR]

/** npm registry 的规范 tarball 路径(npmjs 与 npmmirror 同构):`<registry>/@scope/name/-/name-<ver>.tgz`。 */
export const tarballUrl = (registry: string, pkg: string, version: string): string =>
  `${registry}/${pkg}/-/${pkg.replace(/^@[^/]+\//, '')}-${version}.tgz`

/**
 * dist-tag(缺省 latest)指向的版本与 integrity;先答上的 registry 排在下载候选首位。
 * 某个 registry 没有这个标签就问下一个(npmmirror 同步有延迟);答上的都没有 → null(引擎的本线标签可能还没发过),
 * 一个都没答上才抛。
 */
export async function resolveLatest(pkg: string, registries: string[], fetchFn: RegistryFetch, tag = 'latest'): Promise<{ version: string; integrity: string; tarballs: string[] } | null> {
  const failed: string[] = []
  let untagged = false
  for (const [i, registry] of registries.entries()) {
    try {
      const res = await fetchFn(`${registry}/${pkg.replace('/', '%2f')}`, {
        signal: timeoutSignal(15_000),
        headers: { accept: 'application/vnd.npm.install-v1+json' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const doc = (await res.json()) as { 'dist-tags'?: Record<string, string>; versions?: Record<string, { dist?: { integrity?: string } }> }
      const version = doc['dist-tags']?.[tag]
      if (!version) {
        untagged = true
        continue
      }
      const integrity = doc.versions?.[version]?.dist?.integrity?.split(/\s+/)[0]
      if (!integrity?.startsWith('sha512-')) throw new Error(`${tag}=${version} has no sha512 integrity`)
      const order = [registry, ...registries.filter((_, j) => j !== i)]
      return { version, integrity, tarballs: order.map((r) => tarballUrl(r, pkg, version)) }
    } catch (e) {
      failed.push(`${new URL(registry).host}: ${(e as Error)?.message || e}`)
    }
  }
  if (untagged) return null
  throw new Error(failed.join(' · '))
}

/** 只认正式版:自动更新不装预发布。10-25 之前的 cmpVersion 把 0.5.9-rc.1 排在 0.5.9 之上,预发布进了暂存区同号正式版就换不上;排序已改对,这条照旧守着。 */
export const RELEASE_VERSION = /^\d+\.\d+\.\d+$/

/** AbortSignal.timeout 要 Chrome 103:老 WebView(没有 GMS 的手机常年不升)上没有它,自己拼一个。 */
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
  const c = new AbortController()
  setTimeout(() => c.abort(new Error('timeout')), ms)
  return c.signal
}
