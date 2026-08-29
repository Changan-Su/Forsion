/** 引擎插件包根 icon.png → 设置页 data URL；约束与 Forsion Market 一致。 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 256 * 1024;
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pluginIconDataUrl(dir: string): string | undefined {
  try {
    const buf = readFileSync(path.join(dir, 'icon.png'));
    if (buf.length < 24 || buf.length > MAX_BYTES || !buf.subarray(0, 8).equals(SIG)) return undefined;
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width !== height || width < 64 || width > 512) return undefined;
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return undefined;
  }
}
