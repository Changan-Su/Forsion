/**
 * 契约 C4 钉桩(P1-K5):桌面把设备配对密钥与 external token 迁到 `<userData>/device-secrets.json`(safeStorage 密文)。
 * 引擎不需要为它改代码 —— credentialPaths() 本来就把整片 userData 收进凭据清单;这里钉住新文件确实被覆盖,
 * 免得以后有人把 userData 整目录收录改成逐文件列举时漏掉它。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { credentialReadTarget } from './hostSandboxProtection.js';

const prev = process.env.FORSION_AMADEUS_CONFIG;
let dirs: string[] = [];
afterEach(() => {
  if (prev === undefined) delete process.env.FORSION_AMADEUS_CONFIG; else process.env.FORSION_AMADEUS_CONFIG = prev;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('C4:<userData>/device-secrets.json 在凭据读清单里', () => {
  it('宿主给的 userData(dirname FORSION_AMADEUS_CONFIG)里的 device-secrets.json 命中 credentialReadTarget', () => {
    const userData = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-k5-ud-')));
    dirs.push(userData);
    process.env.FORSION_AMADEUS_CONFIG = join(userData, 'amadeus-config.json');
    const f = join(userData, 'device-secrets.json');
    writeFileSync(f, JSON.stringify({ v: 1, entries: {} }));
    expect(credentialReadTarget(f)).not.toBeNull();
  });

  it('平台 appData 下正式 / dev 两套 userData 里的 device-secrets.json 同样命中(没设 FORSION_AMADEUS_CONFIG 也一样)', () => {
    delete process.env.FORSION_AMADEUS_CONFIG;
    const appData = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
      : process.platform === 'win32' ? (process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming'))
      : (process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'));
    for (const n of ['Forsion', 'forsion-desktop-dev']) {
      expect(credentialReadTarget(join(appData, n, 'device-secrets.json'))).not.toBeNull();
    }
  });
});
