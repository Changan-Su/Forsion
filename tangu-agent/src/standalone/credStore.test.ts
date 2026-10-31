import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { authFile } from '../core/tanguHome.js';
import { assertCredsWritable, loadCreds, saveCreds, saveModel } from './credStore.js';

const BAD = ['', '{"cloudUrl":"https://a.test","token":"t",', '[]', 'null', '{"token":1}'];

describe('auth.json 读不出来 ≠ 没有', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tangu-creds-'));
    vi.stubEnv('TANGU_HOME', home);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('坏文件经 saveModel 后内容不变,也不留任何旁支文件', () => {
    for (const bad of BAD) {
      writeFileSync(authFile(), bad);
      expect(() => saveModel('m')).toThrow(/unreadable/);
      expect(readFileSync(authFile(), 'utf8')).toBe(bad);
      expect(readdirSync(dirname(authFile()))).toEqual(['auth.json']);
    }
  });

  it('读本身失败(非 ENOENT)同样拒写', () => {
    mkdirSync(authFile());
    expect(loadCreds()).toEqual({});
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('unreadable'));
    expect(() => saveCreds({ token: 't' })).toThrow(/unreadable/);
    expect(statSync(authFile()).isDirectory()).toBe(true);
  });

  it('坏文件读到空但会说明原因;文件不存在才是干净的未登录', () => {
    writeFileSync(authFile(), '');
    expect(loadCreds()).toEqual({});
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(() => assertCredsWritable()).toThrow(/unreadable/);

    rmSync(authFile());
    vi.mocked(console.error).mockClear();
    expect(loadCreds()).toEqual({});
    expect(console.error).not.toHaveBeenCalled();
    expect(() => assertCredsWritable()).not.toThrow();
  });

  it('修好或删掉坏文件后恢复写入', () => {
    writeFileSync(authFile(), '');
    expect(() => saveModel('m')).toThrow(/unreadable/);
    rmSync(authFile());
    saveModel('m');
    expect(loadCreds()).toEqual({ model: 'm' });
  });

  it('saveCreds 合并写:token 换了,记住的 model 还在;saveModel 不动 token', () => {
    writeFileSync(authFile(), JSON.stringify({ cloudUrl: 'https://old.test', token: 'old', model: 'm' }));
    saveCreds({ cloudUrl: 'https://new.test', token: 'new' });
    expect(loadCreds()).toEqual({ cloudUrl: 'https://new.test', token: 'new', model: 'm' });
    saveModel('m2');
    expect(loadCreds()).toEqual({ cloudUrl: 'https://new.test', token: 'new', model: 'm2' });
  });

  it('原子写:换的是新文件(不是原地截断),0600,不留临时文件和锁', () => {
    writeFileSync(authFile(), JSON.stringify({ token: 't' }), { mode: 0o644 });
    const before = statSync(authFile()).ino;
    saveModel('m');
    expect(statSync(authFile()).ino).not.toBe(before);
    if (process.platform !== 'win32') expect(statSync(authFile()).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(authFile()))).toEqual(['auth.json']);
  });
});
