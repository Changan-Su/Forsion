/**
 * 电脑历史逐行加密的引擎侧镜像(只读:引擎绝不写电脑历史)。格式正典在 desktop/electron/computerHistoryCrypto.ts
 * (引擎 rootDir 不含 desktop/,不能 import),两边测试钉同一条黄金向量,改格式两处同步。
 *
 * 行:明文 `{"t":…}`(老格式 / 迁移前) | 密文 `ch1.<kid>.<base64(iv12 ‖ 密文 ‖ tag16)>`,AES-256-GCM,AAD 固定。
 * 读的分类:plain / enc / locked(语法是密文、但没钥匙或 kid 不是这把 —— 未知,不当没有)/ broken(残行)。
 *
 * 钥匙:桌面主进程从 safeStorage 取出后经 stdin 私有通道交来(core/hostChannel.ts → setComputerHistoryKey),
 * 只在内存里;不经 env(工具子进程、ps 都看不到),也不落盘。不经桌面拉起的引擎(CLI / TUI)没有钥匙,本来也过不了门禁。
 */
import { createDecipheriv, createHash } from 'node:crypto';

const CH_AAD = 'forsion-computer-history/1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const LINE_RE = /^ch1\.([0-9a-f]{8})\.([A-Za-z0-9+/]{40,}={0,2})$/;

export interface ChKey {
  kid: string;
  key: Buffer;
}

export function chKeyFromHex(hex: unknown): ChKey | null {
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/i.test(hex)) return null;
  const raw = Buffer.from(hex, 'hex');
  if (raw.length !== KEY_BYTES) return null;
  return { kid: createHash('sha256').update('forsion-ch-kid/1').update(raw).digest('hex').slice(0, 8), key: raw };
}

export type ChLineRead =
  | { kind: 'plain'; text: string }
  | { kind: 'enc'; text: string }
  | { kind: 'locked' }
  | { kind: 'broken' };

export function readChLine(line: string, key: ChKey | null): ChLineRead {
  if (line.startsWith('{')) return { kind: 'plain', text: line };
  const m = LINE_RE.exec(line);
  if (!m) return { kind: 'broken' };
  if (!key || m[1] !== key.kid) return { kind: 'locked' };
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < IV_BYTES + TAG_BYTES) return { kind: 'broken' };
  try {
    const d = createDecipheriv('aes-256-gcm', key.key, buf.subarray(0, IV_BYTES));
    d.setAAD(Buffer.from(CH_AAD));
    d.setAuthTag(buf.subarray(buf.length - TAG_BYTES));
    return { kind: 'enc', text: Buffer.concat([d.update(buf.subarray(IV_BYTES, buf.length - TAG_BYTES)), d.final()]).toString('utf8') };
  } catch {
    return { kind: 'broken' };
  }
}

let current: ChKey | null = null;

/** 桌面交来的钥匙(hex);形状不对就忽略(保留原来那把,不当成「没有钥匙」去清掉)。返回是否收下。 */
export function setComputerHistoryKey(hex: unknown): boolean {
  const k = chKeyFromHex(hex);
  if (!k) return false;
  current = k;
  return true;
}

export const computerHistoryKey = (): ChKey | null => current;

/** 仅测试。 */
export function resetComputerHistoryKeyForTests(): void {
  current = null;
}
