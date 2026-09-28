/** P1 · K2 §3.1:引擎读锁文件的语义(每次现读、fail closed、闩只能在主进程写好解锁之后清)。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REMOTE_LOCK_FILE_ENV, REMOTE_LOCKED, remoteLockedBody, remoteLocked, remoteLockState, latchRemoteLock, clearRemoteLatch, __resetRemoteLatchForTests,
} from './remoteLock.js';

let dir: string;
let file: string;
const put = (v: unknown): void => writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tangu-rlock-'));
  file = join(dir, 'remote-lock.json');
  process.env[REMOTE_LOCK_FILE_ENV] = file;
  __resetRemoteLatchForTests();
});
afterEach(() => {
  delete process.env[REMOTE_LOCK_FILE_ENV];
  __resetRemoteLatchForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe('remoteLock', () => {
  it('契约字符串(与 desktop/shared/remoteSafety.ts 镜像,改名两处同步)', () => {
    expect(REMOTE_LOCK_FILE_ENV).toBe('FORSION_REMOTE_LOCK_FILE');
    expect(REMOTE_LOCKED).toBe('REMOTE_LOCKED');
    expect(remoteLockedBody).toEqual({ code: 'REMOTE_LOCKED', detail: expect.stringContaining('locked') });
  });

  it('env 没设 / 相对路径 → 未锁(独立 CLI 没有桌面锁)', () => {
    delete process.env[REMOTE_LOCK_FILE_ENV];
    expect(remoteLocked()).toBe(false);
    process.env[REMOTE_LOCK_FILE_ENV] = 'relative/remote-lock.json';
    expect(remoteLocked()).toBe(false);
  });

  it('ENOENT → 未锁;lock:null → 未锁', () => {
    expect(remoteLockState()).toEqual({ locked: false, source: null });
    put({ v: 1, lock: null, hotkey: '' });
    expect(remoteLocked()).toBe(false);
  });

  it('lock.locked===true → 锁定,带急停时刻;每次现读(改文件立即生效)', () => {
    put({ v: 1, lock: { locked: true, at: 123, source: 'hotkey' } });
    expect(remoteLockState()).toEqual({ locked: true, source: 'file', at: 123 });
    put({ v: 1, lock: null });
    expect(remoteLocked()).toBe(false);
  });

  it.each([
    ['坏 JSON', '{nope'],
    ['数组', '[]'],
    ['没有 lock 键', { v: 1, hotkey: '' }],
    ['lock 是对象但 locked 不是字面 true', { v: 1, lock: { locked: 'yes' } }],
    ['lock 是 false', { v: 1, lock: false }],
    ['lock 是字符串', { v: 1, lock: 'off' }],
  ])('%s → fail closed(锁定)', (_k, v) => {
    put(v);
    expect(remoteLockState()).toEqual({ locked: true, source: 'file' });
  });

  it('读错(路径是目录)→ 锁定', () => {
    mkdirSync(file);
    expect(remoteLocked()).toBe(true);
  });

  it('闩:文件没锁也锁定;清闩只在文件可读且 lock===null 时成立', () => {
    latchRemoteLock();
    expect(remoteLockState()).toMatchObject({ locked: true, source: 'latch' });
    // ENOENT:清不掉(主进程还没写解锁 —— 只凭本机令牌不许清)
    expect(clearRemoteLatch()).toBe(false);
    expect(remoteLocked()).toBe(true);
    put('{bad');
    expect(clearRemoteLatch()).toBe(false);
    put({ v: 1, lock: { locked: true, at: 1, source: 'tray' } });
    expect(clearRemoteLatch()).toBe(false);
    expect(remoteLocked()).toBe(true);
    put({ v: 1, lock: null });
    expect(clearRemoteLatch()).toBe(true);
    expect(remoteLocked()).toBe(false);
  });

  it('清闩清不掉文件锁', () => {
    latchRemoteLock();
    put({ v: 1, lock: { locked: true, at: 5, source: 'settings' } });
    expect(clearRemoteLatch()).toBe(false);
    expect(remoteLockState()).toMatchObject({ locked: true, source: 'file' });
  });
});
