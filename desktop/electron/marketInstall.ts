/**
 * Market 安装核心:把下载到的 zip 解压到 ~/.tangu/<type>/<slug>/。
 * 纯逻辑(只依赖 jszip + fs/path,不 import electron),便于单测路径穿越 / 剥顶层。
 */
import JSZip from 'jszip'
import { mkdir, writeFile, readFile } from 'fs/promises'
import { join, dirname, relative, isAbsolute } from 'path'

/** type → ~/.tangu 下的子目录。 */
export const MARKET_SUBDIR: Record<string, string> = { skill: 'skills', agent: 'agents', plugin: 'plugins' }

/** type → manifest 文件名(用于 manifest 感知重定根,见 computeStripPrefix)。 */
export const MARKET_MANIFEST: Record<string, string[]> = {
  skill: ['SKILL.md'],
  agent: ['config.toml'],
  plugin: ['tangu-plugin.json'],
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
