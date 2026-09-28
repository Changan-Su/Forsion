/**
 * P1 · K2 S1(契约 C4):远端写不了锁状态。锁文件平时住在桌面 userData(整目录已在 credentialPaths 里,靠 FORSION_AMADEUS_CONFIG 推);
 * 这里钉两条具体断言:① userData 推得出时,远程 ctx 写 <userData>/remote-lock.json → 硬拒;② 宿主没给 FORSION_AMADEUS_CONFIG、
 * 锁文件在别处时,凭 FORSION_REMOTE_LOCK_FILE 点名同样硬拒(本机 run 写 → 也硬拒:凭据类写入只经主进程)。
 * 负对照:改前 ② 远程写锁文件 → ok:true(实跑见红,记在 K2 交付报告)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkWritePath } from '../src/tools/fsPolicy.js';
import { REMOTE_LOCK_FILE_ENV } from '../src/services/remoteLock.js';
import type { ToolContext } from '../src/tools/toolTypes.js';

let dir: string;
const prevAmadeus = process.env.FORSION_AMADEUS_CONFIG;
const ctx = (cwd: string, remote: boolean): ToolContext =>
  ({ userId: 'u', sessionId: 'S', appId: 'tangu', execMode: 'host', cwd, ...(remote ? { remote: { via: 'tunnel', marked: true } } : {}) }) as ToolContext;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tangu-lockcred-')); });
afterEach(() => {
  delete process.env[REMOTE_LOCK_FILE_ENV];
  if (prevAmadeus === undefined) delete process.env.FORSION_AMADEUS_CONFIG; else process.env.FORSION_AMADEUS_CONFIG = prevAmadeus;
  rmSync(dir, { recursive: true, force: true });
});

describe('锁文件是凭据类路径(远程写硬拒)', () => {
  it('userData 由 FORSION_AMADEUS_CONFIG 推出:远程写 <userData>/remote-lock.json → 硬拒', () => {
    const userData = join(dir, 'Forsion-dev');
    process.env.FORSION_AMADEUS_CONFIG = join(userData, 'amadeus-config.json');
    expect(checkWritePath(ctx(dir, true), join(userData, 'remote-lock.json'))).toMatchObject({ ok: false, hardDeny: true });
  });

  it('宿主没给 FORSION_AMADEUS_CONFIG:凭 FORSION_REMOTE_LOCK_FILE 点名,远程写同样硬拒', () => {
    delete process.env.FORSION_AMADEUS_CONFIG;
    const lockFile = join(dir, 'elsewhere', 'remote-lock.json');
    process.env[REMOTE_LOCK_FILE_ENV] = lockFile;
    expect(checkWritePath(ctx(dir, true), lockFile)).toMatchObject({ ok: false, hardDeny: true });
    // 同目录的普通文件照常(只点名锁文件本身)
    expect(checkWritePath(ctx(dir, true), join(dir, 'elsewhere', 'notes.txt')).hardDeny).toBeFalsy();
  });
});
