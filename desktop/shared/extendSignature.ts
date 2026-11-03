/**
 * Forsion Extend 的包内签名(SIGNATURE)在内存里核:手机构建期(mobile/build/extendBundle.ts,node:crypto)
 * 与手机运行时的 npm 更新(mobile/src/plugins/bundledExtend.ts,WebCrypto + @noble/ed25519)走同一份规则。
 * 桌面主进程核的是解到盘上的目录(electron/bundleSignature.ts verifyBundleSignature),签名格式相同。
 *
 * 规则:SIGNATURE = { alg:'ed25519', files:{相对路径 → sha256 hex}, sig: base64 },sig 签的是 canonicalFiles(files);
 * 公钥是钉在 desktop/electron/builtinBundles.json 里的那把(换 registry、换镜像、换 npm 账号都绕不过);
 * manifest.json / package.json / dist/main.js 必须在签名里;每个签过的文件都在且摘要对上;**没签的文件当场丢掉**。
 */
export const canonicalFiles = (files: Record<string, string>): string =>
  JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))

export interface SignatureCrypto {
  sha256Hex(data: Uint8Array): string | Promise<string>
  /** ed25519 验签;publicKeyPem = SPKI PEM。 */
  verify(message: Uint8Array, signature: Uint8Array, publicKeyPem: string): boolean | Promise<boolean>
}

const MAX_FILES = 5000
const REQUIRED = ['manifest.json', 'package.json', 'dist/main.js']

/** 包内相对路径:无反斜杠 / NUL / 前导斜杠,没有空段、`.`、`..`。 */
export const safePackagePath = (p: string): boolean =>
  !!p && !p.includes('\\') && !p.includes('\0') && !p.startsWith('/') && p.split('/').every((s) => s !== '.' && s !== '..' && !!s)

const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** 核签名;不过就抛(原因写在消息里)。通过后 files 里只剩签过的文件 + SIGNATURE。 */
export async function verifyExtendFiles(files: Map<string, Uint8Array>, publicKeyPem: string, crypto: SignatureCrypto): Promise<void> {
  let signature: { alg?: unknown; files?: Record<string, string>; sig?: unknown } | null = null
  try {
    const raw = files.get('SIGNATURE')
    signature = raw ? JSON.parse(new TextDecoder().decode(raw)) : null
  } catch { /* 下面统一报 */ }
  if (!signature || signature.alg !== 'ed25519' || !signature.files || typeof signature.files !== 'object' || typeof signature.sig !== 'string') throw new Error('Extend SIGNATURE is missing or malformed')
  const entries = Object.entries(signature.files)
  const signed = new Set(entries.map(([p]) => p)) // 自有键:`in` 会把 constructor / __proto__ 之类原型上的名字也当成签过的
  if (!entries.length || entries.length > MAX_FILES) throw new Error('Extend SIGNATURE file count is invalid')
  let sigOk = false
  try { sigOk = await crypto.verify(new TextEncoder().encode(canonicalFiles(signature.files)), b64(signature.sig), publicKeyPem) } catch { sigOk = false }
  if (!sigOk) throw new Error('Extend signature does not match the pinned public key')
  for (const required of REQUIRED) if (!signed.has(required)) throw new Error(`Extend ${required} is unsigned`)
  for (const [p, digest] of entries) {
    if (!safePackagePath(p) || p === 'SIGNATURE' || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw new Error('Extend SIGNATURE has an unsafe entry')
    const data = files.get(p)
    if (!data || (await crypto.sha256Hex(data)) !== digest) throw new Error(`Extend ${p} does not match its signed hash`)
  }
  // Only signed bytes may reach the renderer (extra package files are ignored).
  for (const p of [...files.keys()]) if (p !== 'SIGNATURE' && !signed.has(p)) files.delete(p)
}

/** 手机能跑的 Extend:id / 入口对、声明了手机宿主接口 mobileHostApi:1(渲染层半身;0.6 之前的包没有)。 */
export function assertMobileExtendManifest(manifest: Record<string, unknown> | null, id = 'forsion-extend'): void {
  if (manifest?.mobileHostApi !== 1) throw new Error('Extend package is missing mobileHostApi:1')
  if (manifest.id !== id || manifest.main !== 'dist/main.js') throw new Error('Extend manifest identity or entry is invalid')
}
