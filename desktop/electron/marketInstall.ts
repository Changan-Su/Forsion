/**
 * Market 安装核心:把下载到的 zip 解压到 ~/.tangu/<type>/<slug>/。
 * 纯逻辑(只依赖 jszip + fs/path,不 import electron),便于单测路径穿越 / 剥顶层。
 */
import JSZip from 'jszip'
import { mkdir, writeFile, readFile, readdir } from 'fs/promises'
import { join, dirname, relative, isAbsolute } from 'path'

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

/** 规整版本字符串(去前导 v、去空白);空 → null。 */
function normVer(raw: unknown): string | null {
  const s = String(raw ?? '').trim().replace(/^v/i, '')
  return s || null
}

/**
 * 读已安装项的版本号(从 manifest),供市场「可更新」检查:
 * skill=SKILL.md frontmatter version;plugin=tangu-plugin.json version;agent=config.toml version。读不到 → null。
 */
export async function readInstalledVersion(type: string, dir: string): Promise<string | null> {
  try {
    if (type === 'plugin') {
      return normVer(JSON.parse(await readFile(join(dir, 'tangu-plugin.json'), 'utf8'))?.version)
    }
    if (type === 'space') {
      return normVer(JSON.parse(await readFile(join(dir, 'space.json'), 'utf8'))?.version)
    }
    if (type === 'theme') {
      return normVer(JSON.parse(await readFile(join(dir, 'theme.json'), 'utf8'))?.version)
    }
    if (type === 'amadeus-plugin') {
      return normVer(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))?.version)
    }
    if (type === 'skill') {
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(await readFile(join(dir, 'SKILL.md'), 'utf8'))
      const m = fm && /(?:^|\n)version\s*:\s*["']?([^"'\n]+)/.exec(fm[1])
      return m ? normVer(m[1]) : null
    }
    if (type === 'agent') {
      const m = /(?:^|\n)\s*version\s*=\s*["']([^"'\n]+)["']/.exec(await readFile(join(dir, 'config.toml'), 'utf8'))
      return m ? normVer(m[1]) : null
    }
  } catch { /* manifest 缺失/损坏 → 无版本 */ }
  return null
}

/**
 * 市场项的安装目录(卸载/探测共用)。**返回 null = 拒绝**,调用方不得自己拼路径。
 *
 * 卸载是删目录的操作,所以这里是安全面:type 必须在 MARKET_SUBDIR 白名单里、slug 必须是
 * 安全 kebab —— 两者任一不合格就返回 null,绝不把未经校验的串拼进 rm 的目标。
 */
export function marketItemDir(home: string, type: string, slug: string): string | null {
  const sub = MARKET_SUBDIR[type]
  if (!sub || !isSafeSlug(slug)) return null
  return join(home, sub, slug)
}

/** install_slug 必须是 kebab(防目录穿越 / data-attr 注入)。 */
export function isSafeSlug(s: unknown): s is string {
  return typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(s)
}

/** 扫用户插件目录,读每个子目录的 tangu-plugin.json,返回 manifest id → 目录名(id 可能 ≠ 目录名)。 */
export async function readUserPluginDirs(pluginsRoot: string): Promise<Array<{ id: string; slug: string }>> {
  let entries
  try { entries = await readdir(pluginsRoot, { withFileTypes: true }) } catch { return [] }
  const out: Array<{ id: string; slug: string }> = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    try {
      const m = JSON.parse(await readFile(join(pluginsRoot, e.name, 'tangu-plugin.json'), 'utf8'))
      // 只认 kebab id(与 loader/settings/卸载 IPC 同一字符集):非法 id 的插件 loader 也不会加载,不给卸载按钮。
      if (isSafeSlug(m?.id)) out.push({ id: m.id, slug: e.name })
    } catch { /* 无/坏 manifest → 跳过 */ }
  }
  return out
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

/** 条目在 destRoot 下的安全相对路径;垃圾/不在前缀下/非法(穿越/绝对/空/目录)返回 null。 */
export function safeEntryPath(name: string, prefix: string): string | null {
  let rel = name.replace(/\\/g, '/')
  if (isJunkPath(rel)) return null
  if (prefix) {
    if (!rel.startsWith(prefix)) return null // 不在 manifest 根下的旁支,丢弃
    rel = rel.slice(prefix.length)
  }
  rel = rel.replace(/^\/+/, '')
  if (!rel || rel.endsWith('/')) return null
  const probe = relative('/__root__', join('/__root__', rel))
  if (!probe || probe.startsWith('..') || isAbsolute(probe)) return null
  return rel
}

/**
 * 插件双类型实测判定:市场后端的 category 会把 Forsion(UI)插件误标成引擎 'plugin'(反之亦然),
 * 装错目录后两边加载器都不认 → 插件失效(实测 forsion-mindmap 即被标成 'plugin')。下载后按包内
 * manifest 重定类型:`tangu-plugin.json` = 引擎插件('plugin');`manifest.json` = Forsion/Amadeus
 * 插件('amadeus-plugin')。只在 plugin 家族内纠偏;二者皆有/皆无 → 尊重后端;其它类型原样返回。
 */
export async function detectMarketType(zipBuffer: Buffer, backendType: string): Promise<string> {
  if (backendType !== 'plugin' && backendType !== 'amadeus-plugin') return backendType
  const zip = await JSZip.loadAsync(zipBuffer)
  // 以「最浅 manifest」定类型:包根那个 manifest 才代表包本体,嵌套的 example/子模块 manifest
  // (如 Forsion 插件带 examples/engine/tangu-plugin.json)不能盖过它 —— 与 computeStripPrefix 重定根口径一致。
  let tanguDepth = Infinity
  let manifestDepth = Infinity
  for (const f of Object.values(zip.files)) {
    if (f.dir || isJunkPath(f.name)) continue
    const parts = f.name.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
    const base = parts[parts.length - 1].toLowerCase()
    if (base === 'tangu-plugin.json') tanguDepth = Math.min(tanguDepth, parts.length)
    else if (base === 'manifest.json') manifestDepth = Math.min(manifestDepth, parts.length)
  }
  if (tanguDepth < manifestDepth) return 'plugin'
  if (manifestDepth < tanguDepth) return 'amadeus-plugin'
  return backendType // 同深度(含二者皆缺失)→ 尊重后端
}

/** 解压 zip 到 destRoot(manifest 感知重定根 + 防穿越)。返回写入文件数。遇到穿越路径直接抛错。 */
export async function extractZipToDir(zipBuffer: Buffer, destRoot: string, manifestNames: string[] = []): Promise<number> {
  const zip = await JSZip.loadAsync(zipBuffer)
  const entries = Object.values(zip.files).filter((f) => !f.dir && !isJunkPath(f.name))
  const prefix = computeStripPrefix(entries.map((f) => f.name), manifestNames)
  await mkdir(destRoot, { recursive: true })
  let n = 0
  for (const f of entries) {
    const rel = safeEntryPath(f.name, prefix)
    if (rel === null) {
      if (/(^|\/)\.\.(\/|$)/.test(f.name.replace(/\\/g, '/'))) throw new Error(`压缩包含非法路径: ${f.name}`)
      continue
    }
    const out = join(destRoot, rel)
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, Buffer.from(await f.async('arraybuffer')))
    n++
  }
  if (n === 0) throw new Error('压缩包为空或无有效文件')
  return n
}

// ── 下载:候选地址 + 每个候选的连接/断流超时 + 字节进度 ──
// 中国大陆直连 GitHub 的典型失败不是「快速报错」而是 SYN 挂起 / 慢到断流:没有超时,「换下一个地址」永远轮不到。
// fetch 由调用方注入:主进程给 github 源传 electron `net.fetch`(Chromium 网络栈,认系统代理),
// Node 的全局 fetch 不认系统代理 —— 挂着 VPN(系统代理模式)也照样直连被墙。

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

export interface DownloadProgress { attempt: number; attempts: number; host: string; received: number; total: number | null }

/** 全部候选都失败:message 只含主机名与原因码(语言中立),界面层自己套中英文案。 */
export class DownloadFailed extends Error {
  constructor(readonly attempts: Array<{ host: string; reason: string }>) {
    super(attempts.map((a) => `${a.host}: ${a.reason}`).join(' · '))
  }
}

type FetchFn = (url: string, init: { signal: AbortSignal }) => Promise<Response>

// 两个 env 既是单测把超时压到毫秒级的旋钮,也是现场排障(极慢网络)调宽的旋钮。
const connectMs = (): number => Number(process.env.FORSION_MARKET_CONNECT_TIMEOUT_MS) || 15_000 // 到响应头为止
const stallMs = (): number => Number(process.env.FORSION_MARKET_STALL_TIMEOUT_MS) || 20_000 // 下载中多久没新字节算断流
const MAX_ZIP_BYTES = 200 * 1024 * 1024

function hostOf(url: string): string {
  try { return new URL(url).host } catch { return url.slice(0, 60) }
}

/** 依次尝试候选,返回第一个完整下载到的 zip。每个候选:响应头超时 + 断流超时 + 大小上限 + zip 魔数
 *  (代理站被限流时常回 200 的 HTML 页面,不认魔数就会拿它去解压、把能用的下一个候选错过)。 */
export async function downloadZip(urls: string[], fetchFn: FetchFn, onProgress: (p: DownloadProgress) => void = () => {}): Promise<Buffer> {
  const failed: Array<{ host: string; reason: string }> = []
  for (const [i, url] of urls.entries()) {
    const host = hostOf(url)
    const ac = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    // 超时既让 race 落败、又 abort 请求:不指望 fetch 实现把 abort 传进 body 流(net.fetch 与 Node fetch 行为不一)。
    // 先 reject 再 abort —— 反过来 fetch 的 AbortError 可能先落定,原因码就成了 aborted 而不是 timeout。
    const deadline = (ms: number, reason: string): Promise<never> => new Promise((_, reject) => {
      clearTimeout(timer)
      timer = setTimeout(() => { reject(new Error(reason)); ac.abort() }, ms)
    })
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      onProgress({ attempt: i + 1, attempts: urls.length, host, received: 0, total: null })
      const res = await Promise.race([fetchFn(url, { signal: ac.signal }), deadline(connectMs(), 'timeout')])
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length')) || null // codeload / 代理站常不给长度 → 界面显示已收字节
      reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let received = 0
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), deadline(stallMs(), 'stalled')])
        if (done) break
        received += value.byteLength
        if (received > MAX_ZIP_BYTES) throw new Error('too large')
        chunks.push(value)
        onProgress({ attempt: i + 1, attempts: urls.length, host, received, total })
      }
      const buf = Buffer.concat(chunks)
      if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('not a zip')
      return buf
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } })?.cause // Node fetch 把真原因(ECONNRESET 等)藏在 cause 里
      failed.push({ host, reason: cause?.code || cause?.message || (e as Error)?.message || String(e) })
      reader?.cancel().catch(() => {})
      ac.abort()
    } finally {
      clearTimeout(timer)
    }
  }
  throw new DownloadFailed(failed)
}
