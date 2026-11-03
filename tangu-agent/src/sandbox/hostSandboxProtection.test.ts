/**
 * 契约 C4 钉桩(P1-K5):桌面把设备配对密钥与 external token 迁到 `<userData>/device-secrets.json`(safeStorage 密文)。
 * 引擎不需要为它改代码 —— credentialPaths() 本来就把整片 userData 收进凭据清单;这里钉住新文件确实被覆盖,
 * 免得以后有人把 userData 整目录收录改成逐文件列举时漏掉它。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

describe('C4:config-backup/(config.json / provider-auth.json 的 .bak 与 .bad-*,auth.json 的 .bad-*)在凭据读清单与受保护清单里', () => {
  it('共享域 config-backup 下的备份命中 credentialReadTarget、protectedHostPaths、forsionConfigPaths', async () => {
    const { configFile } = await import('../core/tanguHome.js');
    const { configBackupDir } = await import('../core/config.js');
    const { protectedHostPaths, forsionConfigPaths, matchProtected } = await import('./hostSandboxProtection.js');
    const dir = configBackupDir(configFile());
    for (const n of ['provider-auth.json.bak', 'config.json.bak', 'provider-auth.json.bad-2026-10-28T09-00-00-000Z', 'auth.json.bad-2026-10-31T20-00-00-000Z-abcd1234']) {
      expect(credentialReadTarget(join(dir, n))).not.toBeNull();
      expect(matchProtected(join(dir, n), protectedHostPaths())).not.toBeNull();
      expect(matchProtected(join(dir, n), forsionConfigPaths())).not.toBeNull();
    }
    expect(credentialReadTarget(join(homedir(), '.forsion', 'config-backup', 'provider-auth.json.bak'))).not.toBeNull();
  });
});

describe('C4:provider-auth.json 是软链时,真身旁边的 config-backup/ 同样受保护', () => {
  const prevHome = process.env.TANGU_HOME;
  afterEach(() => { if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome; });

  it.skipIf(process.platform === 'win32')('软链到别处:真身目录的 config-backup 命中三张清单;别的 standalone home 的 config-backup 也在凭据清单里', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-bak-link-')));
    dirs.push(home);
    mkdirSync(join(home, 'elsewhere'));
    writeFileSync(join(home, 'elsewhere', 'provider-auth.json'), '{}');
    symlinkSync(join(home, 'elsewhere', 'provider-auth.json'), join(home, 'provider-auth.json'));
    process.env.TANGU_HOME = home;
    const { protectedHostPaths, forsionConfigPaths, matchProtected } = await import('./hostSandboxProtection.js');
    const target = join(home, 'elsewhere', 'config-backup', 'provider-auth.json.bak');
    expect(credentialReadTarget(target)).not.toBeNull();
    expect(matchProtected(target, protectedHostPaths())).not.toBeNull();
    expect(matchProtected(target, forsionConfigPaths())).not.toBeNull();
    expect(credentialReadTarget(join(homedir(), '.tangu', 'config-backup', 'config.json.bak'))).not.toBeNull();
  });
});
