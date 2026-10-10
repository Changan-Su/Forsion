/**
 * Market 安装核心:把下载到的 zip 解压到 ~/.tangu/<type>/<slug>/。
 * 只依赖 jszip + fs/path(不 import electron),便于单测路径穿越 / 剥顶层;不碰 I/O 的校验规则在 shared/marketPackage.ts。
 */
import JSZip from 'jszip'
import { mkdir, writeFile, readFile, readdir, chmod } from 'fs/promises'
import { join, dirname, basename } from 'path'
import { effectivePluginId } from '../shared/products'
import {
  MARKET_SUBDIR, MARKET_MANIFEST, isSafeSlug, isJunkPath, computeStripPrefix, safeEntryPath, planZipFiles,
  detectMarketTypeFromNames, toArchiveUrl, downloadCandidates, ZIP_MAGIC, GZIP_MAGIC, hasMagic, ZipPlanError,
} from '../shared/marketPackage'

// 纯校验逻辑(白名单 / slug / 重定根 / 防穿越 / 双类型纠偏 / 镜像候选)住在 shared/marketPackage.ts,
// Android App 的市场安装(mobile/src/plugins/mobileMarket.ts)共用同一份;这里再导出,既有调用方与单测不变。
export { MARKET_SUBDIR, MARKET_MANIFEST, isSafeSlug, isJunkPath, computeStripPrefix, safeEntryPath, toArchiveUrl, downloadCandidates, ZIP_MAGIC, GZIP_MAGIC }

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
 * 读已安装插件的装载 id(目录名可 ≠ id),供市场「打开设置」直达那个插件自己的设置页。
 * 与两侧装载器同一条规则:Forsion 插件 = effectivePluginId(manifest id 不合法回落目录名);
 * 引擎插件 = tangu-plugin.json 的 kebab id(同 readUserPluginDirs)。非插件类型 / 读不到 → null。
 */
export async function readInstalledPluginId(type: string, dir: string): Promise<string | null> {
  try {
    if (type === 'amadeus-plugin') return effectivePluginId(basename(dir), JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))?.id)
    if (type === 'plugin') {
      const id = JSON.parse(await readFile(join(dir, 'tangu-plugin.json'), 'utf8'))?.id
      return isSafeSlug(id) ? id : null
    }
  } catch { /* manifest 缺失/损坏 → 装载器也不认它 */ }
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

/** 插件双类型实测判定(规则见 shared/marketPackage.ts 的 detectMarketTypeFromNames):按包内最浅 manifest 纠偏后端 type。 */
export async function detectMarketType(zipBuffer: Buffer, backendType: string): Promise<string> {
  if (backendType !== 'plugin' && backendType !== 'amadeus-plugin') return backendType
  const zip = await JSZip.loadAsync(zipBuffer)
  return detectMarketTypeFromNames(Object.values(zip.files).filter((f) => !f.dir).map((f) => f.name), backendType)
}

/** 解压 zip 到 destRoot(manifest 感知重定根 + 防穿越)。返回写入文件数。遇到穿越 / 绝对路径条目直接抛错(写盘之前)。
 *  计划按包里的**原名**判(planZipFiles 看 jszip 的 unsafeOriginalName):jszip 读包时会把 `../main.js`、`/main.js`
 *  规整成 `main.js`,只看规整名就会把它当普通文件照装。 */
export async function extractZipToDir(zipBuffer: Buffer, destRoot: string, manifestNames: string[] = []): Promise<number> {
  const zip = await JSZip.loadAsync(zipBuffer)
  let plan: ReturnType<typeof planZipFiles>
  try {
    plan = planZipFiles(Object.values(zip.files), manifestNames)
  } catch (e) {
    if (!(e instanceof ZipPlanError)) throw e
    throw new Error(e.code === 'traversal' ? `压缩包含非法路径: ${e.entry}` : '压缩包为空或无有效文件')
  }
  await mkdir(destRoot, { recursive: true })
  for (const { name, rel } of plan) {
    const out = join(destRoot, rel)
    await mkdir(dirname(out), { recursive: true })
    const f = zip.files[name]
    await writeFile(out, Buffer.from(await f.async('arraybuffer')))
    // Fresh update directories must retain helper executable bits from ZIP/npm archives.
    // Only ordinary permission bits are copied; archive setuid/setgid bits never survive.
    const mode = typeof f.unixPermissions === 'string' ? parseInt(f.unixPermissions, 8) : f.unixPermissions
    if (typeof mode === 'number' && Number.isFinite(mode)) await chmod(out, mode & 0o777)
  }
  return plan.length
}

// ── 下载:候选地址 + 每个候选的连接/断流超时 + 字节进度 ──
// 中国大陆直连 GitHub 的典型失败不是「快速报错」而是 SYN 挂起 / 慢到断流:没有超时,「换下一个地址」永远轮不到。
// fetch 由调用方注入:主进程给 github 源传 electron `net.fetch`(Chromium 网络栈,认系统代理),
// Node 的全局 fetch 不认系统代理 —— 挂着 VPN(系统代理模式)也照样直连被墙。

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

/** 依次尝试候选,返回第一个完整下载到的归档(缺省 zip;传 GZIP_MAGIC 下 .tgz)。每个候选:响应头超时 + 断流超时 +
 *  大小上限 + 魔数(代理站被限流时常回 200 的 HTML 页面,不认魔数就会拿它去解压、把能用的下一个候选错过)。 */
export async function downloadZip(
  urls: string[],
  fetchFn: FetchFn,
  onProgress: (p: DownloadProgress) => void = () => {},
  magic: readonly number[] = ZIP_MAGIC,
): Promise<Buffer> {
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
      if (!hasMagic(buf, magic)) throw new Error(magic === ZIP_MAGIC ? 'not a zip' : 'unexpected content')
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
