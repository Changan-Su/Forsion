/**
 * 电脑历史的静态加密(逐行 AES-256-GCM)。纯函数,不依赖 electron:主进程 computerHistory.ts 写读、vitest 直测。
 * 引擎侧 tangu-agent/src/services/computerHistoryCrypto.ts 是同一份格式的镜像(引擎 rootDir 不含 desktop/,不能 import),
 * 两边测试钉同一条黄金向量,格式改动两处同步。
 *
 * 行格式(events/<本地日期>.jsonl 的一行):
 *   明文(老格式 / 迁移前):`{"t":…,"kind":…}`,以 `{` 开头
 *   密文:`ch1.<kid>.<base64(iv12 ‖ 密文 ‖ tag16)>`,kid = 钥匙指纹前 4 字节的 hex(区分「别的钥匙加的」和「坏行」)
 * AAD 固定为 CH_AAD;明文就是原来那一行 JSON(含 t —— 时间不留明文,日文件名之外不泄露活动时间线)。
 *
 * 钥匙:32 字节随机数,hex 存在设备凭据 device-secrets.json 的 computerHistoryKey 槽(safeStorage:macOS 钥匙串 / Windows
 * DPAPI),一个安装期一把、不轮换。引擎经 stdin 私有通道拿到同一把(见 backendManager / 引擎 hostChannel)。
 *
 * 读的分类(「读失败 ≠ 空」的落点):
 *   plain  明文行(原样交给调用方解析)
 *   enc    解开了
 *   locked 语法是密文行,但手上没钥匙 / kid 不是这把 —— **未知**:不当残行删、不当没有,重写时整份文件不动
 *   broken 既不是 `{` 开头也不合密文语法,或 kid 对上了却认证失败(半截写入)—— 残行,与明文残行同一口径
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export const CH_LINE_PREFIX = 'ch1.'
export const CH_AAD = 'forsion-computer-history/1'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
/** 至少 iv + tag(28 字节 = 40 个 base64 字符);`.` 不在 base64 字符集里,半截行与下一行粘在一起时必然对不上。 */
const LINE_RE = /^ch1\.([0-9a-f]{8})\.([A-Za-z0-9+/]{40,}={0,2})$/

export interface ChKey {
  /** 指纹:sha256('forsion-ch-kid/1' ‖ key) 前 4 字节 hex。 */
  kid: string
  key: Buffer
}

export function chKeyFrom(raw: Buffer): ChKey {
  if (raw.length !== KEY_BYTES) throw new Error('computer history key must be 32 bytes')
  const kid = createHash('sha256').update('forsion-ch-kid/1').update(raw).digest('hex').slice(0, 8)
  return { kid, key: Buffer.from(raw) }
}

/** 槽里存的 hex → 钥匙;形状不对 = null(调用方当「拿不到」,不当「没有」)。 */
export function chKeyFromHex(hex: unknown): ChKey | null {
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/i.test(hex)) return null
  return chKeyFrom(Buffer.from(hex, 'hex'))
}

export const newChKeyHex = (): string => randomBytes(KEY_BYTES).toString('hex')

/** 一行 JSON(不含换行)→ 密文行(不含换行)。iv 只给测试钉黄金向量用。 */
export function encryptLine(k: ChKey, json: string, iv: Buffer = randomBytes(IV_BYTES)): string {
  const c = createCipheriv('aes-256-gcm', k.key, iv)
  c.setAAD(Buffer.from(CH_AAD))
  const ct = Buffer.concat([c.update(json, 'utf8'), c.final()])
  return `${CH_LINE_PREFIX}${k.kid}.${Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64')}`
}

export type ChLineRead =
  | { kind: 'plain'; text: string }
  | { kind: 'enc'; text: string }
  | { kind: 'locked' }
  | { kind: 'broken' }

/** 读一行(不含换行、非空)。key = null:还没拿到钥匙,密文行一律 locked。 */
export function readChLine(line: string, key: ChKey | null): ChLineRead {
  if (line.startsWith('{')) return { kind: 'plain', text: line }
  const m = LINE_RE.exec(line)
  if (!m) return { kind: 'broken' }
  if (!key || m[1] !== key.kid) return { kind: 'locked' }
  const buf = Buffer.from(m[2], 'base64')
  if (buf.length < IV_BYTES + TAG_BYTES) return { kind: 'broken' }
  try {
    const d = createDecipheriv('aes-256-gcm', key.key, buf.subarray(0, IV_BYTES))
    d.setAAD(Buffer.from(CH_AAD))
    d.setAuthTag(buf.subarray(buf.length - TAG_BYTES))
    const text = Buffer.concat([d.update(buf.subarray(IV_BYTES, buf.length - TAG_BYTES)), d.final()]).toString('utf8')
    return { kind: 'enc', text }
  } catch {
    return { kind: 'broken' } // kid 对上了还认证失败:半截写入 / 被改过 —— 残行
  }
}

/** 测试与台架用的固定向量(两端测试各钉一份;改格式时这里与引擎镜像一起改)。 */
export const CH_GOLDEN = {
  keyHex: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  ivHex: 'a0a1a2a3a4a5a6a7a8a9aaab',
  json: '{"t":1759000000000,"kind":"app","app":{"name":"Notes","bundleId":"com.apple.Notes"}}',
} as const
