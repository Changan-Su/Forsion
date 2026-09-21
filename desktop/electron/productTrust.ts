/**
 * 产物相关的**宿主侧信任凭据**,无 Electron 依赖。和 devLoadStore 同一条原则:项目目录不可信,
 * 凡是「授权这个目录做某件有权限的事」的凭据,一律住在 forsionHomeDir() 下、项目自己够不着的地方。
 *
 * 这里存两样:
 *  · gitNonces —— Forsion 自己 `git init` 时发出去的 nonce(见 gitHistory.GitOwners)。标记文件在 `.git/` 里,
 *    nonce 在这里,两边对上才算我方仓;外来文件夹自带一个标记文件没用。
 *  · externalLaunch —— 允许**从应用外**(桌面快捷方式 / forsion:// 深链)拉起的产物:产物 id + 授权当时那个目录的身份
 *    (dev+ino,见 dirIdentity.ts:改名 / 同卷挪位置后快捷方式照样有效;同 id 的 sidecar 搬进别的文件夹不算)。
 *    只有「添加到桌面」成功时才登记。深链是任意网页可达的输入,而产物页面手里有 Forsion Connect 代理
 *    (读账号、花额度):一个下载来的文件夹配上一条链接,不该零点击跑起来。应用内点开不受此限。
 *
 * 坏文件 / 读不了 → 当空(fail closed:不认任何仓、不放行任何外部拉起)。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { dirIdentity, isDirIdentity, matchesDirIdentity, type DirIdentity } from './dirIdentity'

const FILE = 'product-trust.json'
const NONCE = /^[0-9a-f]{32}$/
const ID = /^p_[0-9a-f]{12}$/
/** ponytail: nonce 只增不删(删了项目也留着,一条 33 字节);上限防病态增长,满了丢最旧的 —— 被丢的仓退成只读,不丢数据。 */
const MAX_NONCES = 4096

interface Launch { root: string; dir: DirIdentity }
interface Trust { gitNonces: string[]; externalLaunch: Record<string, Launch> }

function read(homeDir: string): Trust {
  const trust: Trust = { gitNonces: [], externalLaunch: Object.create(null) as Record<string, Launch> }
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(join(homeDir, FILE), 'utf8')) } catch { return trust }
  const raw = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as { gitNonces?: unknown; externalLaunch?: unknown }
  if (Array.isArray(raw.gitNonces)) trust.gitNonces = raw.gitNonces.filter((n): n is string => typeof n === 'string' && NONCE.test(n))
  if (raw.externalLaunch && typeof raw.externalLaunch === 'object' && !Array.isArray(raw.externalLaunch)) {
    for (const [id, value] of Object.entries(raw.externalLaunch as Record<string, unknown>)) {
      const entry = value as { root?: unknown; dir?: unknown } | null
      if (ID.test(id) && entry && typeof entry === 'object' && typeof entry.root === 'string' && isAbsolute(entry.root) && isDirIdentity(entry.dir)) trust.externalLaunch[id] = { root: entry.root, dir: entry.dir }
    }
  }
  return trust
}

function write(homeDir: string, trust: Trust): void {
  const target = join(homeDir, FILE)
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: 1, ...trust }), { mode: 0o600 })
  renameSync(tmp, target)
}

/** gitHistory 的 GitOwners 实现:每次现读现写(主进程单实例,低频),不留内存副本 → 不存在「两份状态谁新」的问题。 */
export function gitOwners(homeDir: string): { has(nonce: string): boolean; add(nonce: string): void } {
  return {
    has: (nonce) => NONCE.test(nonce) && read(homeDir).gitNonces.includes(nonce),
    add: (nonce) => {
      if (!NONCE.test(nonce)) throw new Error('invalid nonce')
      const trust = read(homeDir)
      if (trust.gitNonces.includes(nonce)) return
      trust.gitNonces = [...trust.gitNonces, nonce].slice(-MAX_NONCES)
      write(homeDir, trust)
    },
  }
}

export function allowExternalLaunch(homeDir: string, product: { id: string; root: string }): void {
  if (!ID.test(product.id) || !isAbsolute(product.root)) throw new Error('invalid product')
  const dir = dirIdentity(product.root)
  if (!dir) throw new Error('project directory is unavailable')
  const trust = read(homeDir)
  trust.externalLaunch[product.id] = { root: product.root, dir }
  write(homeDir, trust)
}

/** id 与目录身份都对上才放行:同 id 的 sidecar 被搬进别的目录、复制出来的项目(id 会被重铸)都不算;改名 / 同卷挪位置照样算。 */
export function isExternalLaunchAllowed(homeDir: string, product: { id: string; root: string }): boolean {
  const grant = read(homeDir).externalLaunch[product.id]
  return !!grant && matchesDirIdentity(product.root, grant.dir)
}

export function revokeExternalLaunch(homeDir: string, id: string): void {
  const trust = read(homeDir)
  if (!(id in trust.externalLaunch)) return
  delete trust.externalLaunch[id]
  write(homeDir, trust)
}
