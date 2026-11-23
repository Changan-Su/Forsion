/** 多账号模式的账号上下文原语:没账号就抛、两个账号的路径各是各的、绑定跟着回调走。开关要在 import 前设好。 */
import { describe, it, expect, vi } from 'vitest';

const env = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-scope-'));
  process.env.TANGU_MULTI_ACCOUNT = '1';
  process.env.TANGU_HOME = home;
  return { home };
});

import { accountHome, bindAccount, currentAccountId, engineRoot, isMultiAccount, isValidAccountId, perAccount, requireAccountId, runWithAccount, withinAccountRoot } from './accountScope.js';
import { configFile, envFile, forsionSharedDir, loadTanguEnv, stateDbPath, tanguHome } from './tanguHome.js';

describe('accountScope (multi-account mode)', () => {
  it('is on only through the real environment variable', () => {
    expect(isMultiAccount()).toBe(true);
    expect(engineRoot()).toBe(env.home);
  });

  it('accepts only lower-case ids', () => {
    for (const ok of ['alice', 'a', 'a-b_c', '0x9']) expect(isValidAccountId(ok)).toBe(true);
    for (const bad of ['Alice', '', '-a', '_a', 'a/b', '..', 'a'.repeat(65), 'a b', 'tangu/../x']) expect(isValidAccountId(bad)).toBe(false);
    expect(() => runWithAccount('Alice', () => 1)).toThrow(/invalid account id/);
  });

  it('throws without an account instead of falling into a shared folder', () => {
    expect(currentAccountId()).toBeUndefined();
    expect(() => requireAccountId('x')).toThrow('multi-account: no account in context for x');
    expect(() => tanguHome()).toThrow(/no account in context for tanguHome/);
    expect(() => configFile()).toThrow(/no account/);
  });

  it('gives each account its own home and shared domain', () => {
    const a = runWithAccount('alice', () => ({ home: tanguHome(), shared: forsionSharedDir(), db: stateDbPath(), cfg: configFile() }));
    const b = runWithAccount('bob', () => ({ home: tanguHome(), shared: forsionSharedDir(), db: stateDbPath(), cfg: configFile() }));
    expect(a.home).toBe(accountHome('alice'));
    expect(a.shared).toBe(a.home);
    expect(b.home).toBe(accountHome('bob'));
    expect(a.db).not.toBe(b.db);
    expect(a.cfg).not.toBe(b.cfg);
    // 账号 id 叫 tangu 也不跳到 accounts/(单人模式的「目录名叫 tangu 就跳父目录」不适用)
    expect(runWithAccount('tangu', () => forsionSharedDir())).toBe(accountHome('tangu'));
    // .env 是引擎级的
    expect(envFile()).toBe(`${env.home}/.env`);
  });

  it('keeps the account across async hops and in bound callbacks', async () => {
    const seen = await runWithAccount('alice', async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentAccountId();
    });
    expect(seen).toBe('alice');
    let later: (() => string | undefined) | undefined;
    runWithAccount('bob', () => { later = bindAccount(() => currentAccountId()); });
    expect(later!()).toBe('bob');
    // 没绑的回调在账号外执行就拿不到账号
    expect(bindAccount(() => currentAccountId())()).toBeUndefined();
  });

  it('splits perAccount caches and refuses outside an account', () => {
    const slot = perAccount(() => ({ n: 0 }));
    runWithAccount('alice', () => { slot().n = 5; });
    expect(runWithAccount('bob', () => slot().n)).toBe(0);
    expect(runWithAccount('alice', () => slot().n)).toBe(5);
    expect(() => slot()).toThrow(/no account/);
  });

  it('stops upward walks at the account folder', () => {
    runWithAccount('alice', () => {
      expect(withinAccountRoot(`${accountHome('alice')}/workspace/p`)).toBe(true);
      expect(withinAccountRoot(accountHome('alice'))).toBe(true);
      expect(withinAccountRoot(`${env.home}/accounts`)).toBe(false);
      expect(withinAccountRoot(accountHome('bob'))).toBe(false);
    });
    expect(withinAccountRoot(accountHome('alice'))).toBe(false); // 没有账号上下文 = 不在任何账号里
  });

  it('ignores TANGU_HOME and TANGU_MULTI_ACCOUNT in .env: the engine root only comes from the real environment', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-envhome-'));
    fs.mkdirSync(path.join(fakeHome, '.tangu'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.tangu', '.env'), 'TANGU_HOME=/somewhere/else\nTANGU_MULTI_ACCOUNT=0\nMA_ENV_TEST_KEY=ok\n');
    const saved = { HOME: process.env.HOME, TANGU_HOME: process.env.TANGU_HOME, MA: process.env.TANGU_MULTI_ACCOUNT };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env.HOME = fakeHome; // engineRoot() = ~/.tangu
      delete process.env.TANGU_HOME;
      delete process.env.TANGU_MULTI_ACCOUNT;
      expect(envFile()).toBe(path.join(fakeHome, '.tangu', '.env'));
      loadTanguEnv();
      expect(process.env.TANGU_HOME).toBeUndefined();
      expect(process.env.TANGU_MULTI_ACCOUNT).toBeUndefined();
      expect(process.env.MA_ENV_TEST_KEY).toBe('ok');
      expect(engineRoot()).toBe(path.join(fakeHome, '.tangu'));
      expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => /ignoring TANGU_(HOME|MULTI_ACCOUNT)/.test(m))).toHaveLength(2);
    } finally {
      warn.mockRestore();
      process.env.HOME = saved.HOME;
      process.env.TANGU_HOME = saved.TANGU_HOME;
      process.env.TANGU_MULTI_ACCOUNT = saved.MA;
      delete process.env.MA_ENV_TEST_KEY;
    }
  });
});
