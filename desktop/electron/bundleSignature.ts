/**
 * 内置捆绑包的包内签名(2026-09-27,首例 Forsion Extend):带主进程半身的捆绑包在 CI 里对包内每个文件签名,
 * 桌面端播种 / 装载前用钉在 builtinBundles.json 里的公钥核对。npm 更新通道只有 registry 自报的 sha512,
 * 证得了「下载的就是 registry 上那份」,证不了「那份是我们发的」;渲染层 / 引擎半身沿用这一档就够,
 * 但要被 import 进主进程的代码得多这一道 —— 公钥在 Genesis 手里,换 registry、换镜像、换 npm 账号都绕不过。
 *
 * SIGNATURE(包根,JSON):
 *   { "alg": "ed25519",
 *     "files": { "<posix 相对路径>": "<sha256 hex>", … },   // 包内除 SIGNATURE 外的每个普通文件
 *     "sig": "<base64(ed25519 签名)>" }
 *   被签名的字节 = canonicalFiles(files):键按码点升序排好后 JSON.stringify,不含空白。
 *
 * 核对规则:签名对得上公钥;files 里每一项都存在、是普通文件(符号链接一律拒)、sha256 一致;
 * 调用方点名的文件(主进程入口)必须在 files 里。目录里多出来的文件不算错 —— 入口是 esbuild 单文件、
 * 不会 require 相邻文件,而宿主以后可能往插件目录写自己的东西。
 * 生成侧(Forsion-Extend 仓 scripts/sign.mjs)与这里是同一份口径,改格式两边同改。
 */
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const SIGNATURE_FILE = 'SIGNATURE'
const MAX_FILES = 5000

export interface BundleSignature {
  alg: 'ed25519'
  files: Record<string, string>
  sig: string
}

export const canonicalFiles = (files: Record<string, string>): string =>
  JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))

export type SignatureVerdict = { ok: true; files: string[]; digests: Record<string, string> } | { ok: false; reason: string }

const SAFE_REL = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[^\0]+$/

/** 核对 dir 下的 SIGNATURE。require = 必须被签到的文件(相对路径)。任何一条不满足都返回 ok:false + 原因。 */
export async function verifyBundleSignature(dir: string, publicKeyPem: string, require: readonly string[] = []): Promise<SignatureVerdict> {
  let parsed: Partial<BundleSignature>
  try {
    parsed = JSON.parse(await fs.readFile(path.join(dir, SIGNATURE_FILE), 'utf8')) as Partial<BundleSignature>
  } catch (e) {
    return { ok: false, reason: `no readable ${SIGNATURE_FILE}: ${(e as Error)?.message || e}` }
  }
  if (parsed.alg !== 'ed25519' || typeof parsed.sig !== 'string' || !parsed.files || typeof parsed.files !== 'object') {
    return { ok: false, reason: `${SIGNATURE_FILE} is malformed` }
  }
  const entries = Object.entries(parsed.files)
  if (entries.length === 0 || entries.length > MAX_FILES) return { ok: false, reason: `${SIGNATURE_FILE} lists ${entries.length} files` }
  for (const [rel, digest] of entries) {
    if (!SAFE_REL.test(rel) || rel === SIGNATURE_FILE || !/^[0-9a-f]{64}$/.test(digest)) return { ok: false, reason: `bad entry ${JSON.stringify(rel)}` }
  }
  let key: ReturnType<typeof createPublicKey>
  try {
    key = createPublicKey(publicKeyPem)
  } catch (e) {
    return { ok: false, reason: `bad public key: ${(e as Error)?.message || e}` }
  }
  let sigOk = false
  try {
    sigOk = verifySignature(null, Buffer.from(canonicalFiles(parsed.files), 'utf8'), key, Buffer.from(parsed.sig, 'base64'))
  } catch (e) {
    return { ok: false, reason: `signature check failed: ${(e as Error)?.message || e}` }
  }
  if (!sigOk) return { ok: false, reason: 'signature does not match the pinned public key' }
  for (const rel of require) {
    if (!(rel in parsed.files)) return { ok: false, reason: `${rel} is not covered by ${SIGNATURE_FILE}` }
  }
  for (const [rel, digest] of entries) {
    const file = path.join(dir, ...rel.split('/'))
    let stat: import('node:fs').Stats
    try {
      stat = await fs.lstat(file)
    } catch {
      return { ok: false, reason: `${rel} is missing` }
    }
    if (!stat.isFile()) return { ok: false, reason: `${rel} is not a regular file` }
    const actual = createHash('sha256').update(await fs.readFile(file)).digest('hex')
    if (actual !== digest) return { ok: false, reason: `${rel} does not match its signed hash` }
  }
  return { ok: true, files: entries.map(([rel]) => rel), digests: { ...parsed.files } }
}
