/**
 * Market 安装包的**纯逻辑**(无 node:fs / node:path / Buffer / Electron):桌面主进程(electron/marketInstall.ts)
 * 与 Android App(mobile/src/plugins/mobileMarket.ts)共用同一套校验 —— 白名单 type、kebab slug、垃圾条目、
 * manifest 感知重定根、防穿越、插件双类型纠偏、GitHub 镜像候选。两端各管各的 I/O(fs / Capacitor Filesystem),
 * 拒收规则只在这一处,改一处两端同时生效。
 * 2026-10-02 从 electron/marketInstall.ts 搬来(原文件改为再导出,桌面行为与单测不变)。
 */

/** type → ~/.forsion 下的子目录(join 会展开嵌套)。引擎域装 tangu/;desktop 域留顶层。 */
export const MARKET_SUBDIR: Record<string, string> = {
  skill: 'tangu/skills',
  agent: 'tangu/agents',
  plugin: 'tangu/plugins',
  space: 'spaces',
  theme: 'themes',
  'amadeus-plugin': 'plugins', // Forsion(UI)插件目录(类别 id 保留 amadeus-plugin 兼容市场后端)
}

/** type → manifest 文件名(用于 manifest 感知重定根,见 computeStripPrefix)。 */
export const MARKET_MANIFEST: Record<string, string[]> = {
  skill: ['SKILL.md'],
  agent: ['config.toml'],
  plugin: ['tangu-plugin.json'],
  space: ['space.json'],
  theme: ['theme.json'],
  'amadeus-plugin': ['manifest.json'],
}

/** install_slug 必须是 kebab(防目录穿越 / data-attr 注入)。 */
export function isSafeSlug(s: unknown): s is string {
  return typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(s)
}

/** zip 里常见的垃圾条目(macOS/Windows 压缩残留),解压时一律丢弃。 */
const JUNK_SEG = new Set(['__MACOSX', '.DS_Store', 'Thumbs.db'])
export function isJunkPath(name: string): boolean {
  return name.replace(/\\/g, '/').split('/').some((seg) => JUNK_SEG.has(seg))
}

/**
 * 计算要剥掉的前缀('' = 不剥)。优先用 manifest 文件(SKILL.md / tangu-plugin.json / config.toml)
 * 定位:以「深度最浅的 manifest 文件所在目录」为根 —— 这样无论用户在 Finder「压缩文件夹」多套了
 * __MACOSX/ 兄弟目录、还是嵌了几层,都能把 manifest 重定根到 destRoot。无 manifest 时回退到旧的
 * 「单一顶级目录就剥」(GitHub source zip owner-repo-sha/)。垃圾条目在计算前已过滤。
 */
export function computeStripPrefix(names: string[], manifestNames: string[] = []): string {
  const files = names.map((n) => n.replace(/\\/g, '/')).filter((n) => n && !n.endsWith('/') && !isJunkPath(n))
  if (!files.length) return ''
  if (manifestNames.length) {
    const want = new Set(manifestNames.map((s) => s.toLowerCase()))
    let best: string | null = null
    for (const f of files) {
      const base = f.split('/').pop()!.toLowerCase()
      if (!want.has(base)) continue
      if (best === null || f.split('/').length < best.split('/').length) best = f
    }
    if (best !== null) {
      const dir = best.split('/').slice(0, -1).join('/')
      return dir ? dir + '/' : ''
    }
  }
  const tops = new Set(files.map((n) => n.split('/')[0]))
  if (tops.size === 1 && files.every((n) => n.includes('/'))) return files[0].split('/')[0] + '/'
  return ''
}

/**
 * 条目在 destRoot 下的安全相对路径(正斜杠、已规整);垃圾/不在前缀下/非法(穿越/绝对/空/目录)返回 null。
 * 纯字符串实现(不借 node:path):`..` 越过根 → null;首段以 `..` 开头 → null(与原 path.relative 判据同口径);
 * 首段带盘符(`C:`)→ null(原实现在 win32 上靠 path.isAbsolute 拒)。返回值已规整(`a//b`、`a/./b`、`a/x/../b`
 * 都落成同一个落点),Android 的 Filesystem 路径与 IndexedDB 键不认 `..`,必须先规整再拼。
 */
export function safeEntryPath(name: string, prefix: string): string | null {
  let rel = name.replace(/\\/g, '/')
  if (isJunkPath(rel)) return null
  if (prefix) {
    if (!rel.startsWith(prefix)) return null // 不在 manifest 根下的旁支,丢弃
    rel = rel.slice(prefix.length)
  }
  rel = rel.replace(/^\/+/, '')
  if (!rel || rel.endsWith('/')) return null
  const out: string[] = []
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (!out.length) return null
      out.pop()
      continue
    }
    out.push(seg)
  }
  if (!out.length) return null
  if (out[0].startsWith('..') || /^[A-Za-z]:/.test(out[0])) return null
  return out.join('/')
}

/** 解包计划的拒收原因码。message 只是开发者可读的英文;上屏文案由宿主按 code 给
 *  (桌面主进程沿用原有文案,见 electron/marketInstall.ts;移动端套 zh/en 词条)。 */
export class ZipPlanError extends Error {
  constructor(readonly code: 'traversal' | 'empty', message: string, readonly entry?: string) {
    super(message)
    this.name = 'ZipPlanError'
  }
}

export interface ZipPlanEntry {
  /** zip 内原名(给 jszip 取内容用)。 */
  name: string
  /** 落到 destRoot 下的安全相对路径(正斜杠)。 */
  rel: string
}

/**
 * 解包计划:按 manifest 重定根、丢垃圾 / 旁支,遇穿越条目整包拒(抛 ZipPlanError('traversal'))、
 * 一个有效文件都没有也拒('empty')。只看文件条目名(调用方先滤掉 jszip 的目录条目)。
 * **先算计划再落盘**:拒收发生在写下第一个字节之前(此前桌面边写边判,穿越条目之前的文件会先落盘)。
 */
export function planZipEntries(fileNames: string[], manifestNames: string[] = []): ZipPlanEntry[] {
  const names = fileNames.filter((n) => !isJunkPath(n))
  const prefix = computeStripPrefix(names, manifestNames)
  const out: ZipPlanEntry[] = []
  for (const name of names) {
    const rel = safeEntryPath(name, prefix)
    if (rel === null) {
      if (/(^|\/)\.\.(\/|$)/.test(name.replace(/\\/g, '/'))) throw new ZipPlanError('traversal', `unsafe path in archive: ${name}`, name)
      continue
    }
    out.push({ name, rel })
  }
  if (out.length === 0) throw new ZipPlanError('empty', 'archive is empty')
  return out
}

/**
 * 插件双类型实测判定:市场后端的 category 会把 Forsion(UI)插件误标成引擎 'plugin'(反之亦然),
 * 装错目录后两边加载器都不认 → 插件失效(实测 forsion-mindmap 即被标成 'plugin')。下载后按包内
 * manifest 重定类型:`tangu-plugin.json` = 引擎插件('plugin');`manifest.json` = Forsion/Amadeus
 * 插件('amadeus-plugin')。只在 plugin 家族内纠偏;二者皆有/皆无 → 尊重后端;其它类型原样返回。
 * 以「最浅 manifest」定类型:包根那个 manifest 才代表包本体,嵌套的 example/子模块 manifest
 * (如 Forsion 插件带 examples/engine/tangu-plugin.json)不能盖过它 —— 与 computeStripPrefix 重定根口径一致。
 */
export function detectMarketTypeFromNames(fileNames: string[], backendType: string): string {
  if (backendType !== 'plugin' && backendType !== 'amadeus-plugin') return backendType
  let tanguDepth = Infinity
  let manifestDepth = Infinity
  for (const name of fileNames) {
    if (isJunkPath(name)) continue
    const parts = name.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
    const base = parts[parts.length - 1].toLowerCase()
    if (base === 'tangu-plugin.json') tanguDepth = Math.min(tanguDepth, parts.length)
    else if (base === 'manifest.json') manifestDepth = Math.min(manifestDepth, parts.length)
  }
  if (tanguDepth < manifestDepth) return 'plugin'
  if (manifestDepth < tanguDepth) return 'amadeus-plugin'
  return backendType // 同深度(含二者皆缺失)→ 尊重后端
}

// ── 下载候选(中国大陆镜像)──
const GH_PROXIES = ['https://ghfast.top', 'https://ghproxy.net', 'https://gh-proxy.com']

/** api.github.com 的 zipball 地址 → github.com 的 archive 地址(同一份源码 zip,同样套一层顶级目录)。
 *  gh 代理站只前置 github.com / *.githubusercontent.com,不前置 API 域名;老服务端对「release 没挂 zip 资产」
 *  与「无 release」的条目回的恰恰是 zipball,于是镜像对它们一次都没被试过。其余地址原样返回。 */
export function toArchiveUrl(url: string): string {
  const m = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/zipball(?:\/(.+))?$/.exec(url)
  return m ? `https://github.com/${m[1]}/${m[2]}/archive/${m[3] || 'HEAD'}.zip` : url
}

/**
 * 下载候选序列。开了「中国大陆镜像」(mirror=china):多代理站(站点更迭频繁,单点必然间歇失效)→ 直连兜底,
 * customProxy(TANGU_GITHUB_PROXY)排最前;没开:只直连。
 * ⚠️ 代理站不能默认给所有人兜底(Codex 09-21):那是第三方,回来的字节未经校验就当插件代码执行 —— 这份信任得用户自己开。
 * 根治 = 服务端把包镜像进自家对象存储(待拍板)。非 github 地址(Forsion 对象存储等)原样单发。
 */
export function downloadCandidates(url: string, mirror: string, customProxy = ''): string[] {
  const u = toArchiveUrl(url)
  if (!/^https:\/\/(github\.com|[^/]*\.githubusercontent\.com)\//.test(u)) return [u]
  const custom = customProxy.replace(/\/+$/, '')
  const proxied = (custom ? [custom, ...GH_PROXIES.filter((p) => p !== custom)] : GH_PROXIES).map((p) => `${p}/${u}`)
  return mirror === 'china' ? [...proxied, u] : [u]
}

export const ZIP_MAGIC: readonly number[] = [0x50, 0x4b]
/** gzip 魔数:npm tarball(.tgz)用,见 electron/builtinUpdates.ts。 */
export const GZIP_MAGIC: readonly number[] = [0x1f, 0x8b]

/** 字节开头是否对上魔数(长度 < 4 一律不认:代理站被限流时常回 200 的空页 / HTML)。 */
export function hasMagic(bytes: ArrayLike<number>, magic: readonly number[]): boolean {
  return bytes.length >= 4 && magic.every((b, j) => bytes[j] === b)
}
