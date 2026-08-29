/**
 * 外部引擎快速检测(isEngineAvailable):配置目录/env/PATH 任一命中即「detected」。
 * 不 spawn、不依赖真实安装——用确定存在的 home 目录与临时 env 覆盖各分支。
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { isEngineAvailable, engineStatus, loadEngines, extraBinDirs, envWithFullPath } from '../src/engines/config.js';

const base = { id: 'x', name: 'X', command: 'foo' } as const;

describe('isEngineAvailable — 快速检测', () => {
  it('无 detect 提示 → 默认可用(不隐藏用户自配引擎)', () => {
    expect(isEngineAvailable({ ...base })).toBe(true);
  });

  it('配置目录存在(~ 展开为 home)→ 可用', () => {
    expect(isEngineAvailable({ ...base, detect: { dirs: ['~'] } })).toBe(true);
  });

  it('相关 env 已设 → 可用', () => {
    const KEY = 'TANGU_TEST_ENGINE_KEY_XYZ';
    process.env[KEY] = '1';
    try {
      expect(isEngineAvailable({ ...base, detect: { env: [KEY] } })).toBe(true);
    } finally {
      delete process.env[KEY];
    }
  });

  it('目录/env/bin 全不命中 → 不可用', () => {
    expect(
      isEngineAvailable({
        ...base,
        detect: {
          dirs: ['/nonexistent/forsion/tangu/zzz'],
          env: ['TANGU_DEFINITELY_UNSET_ZZZ'],
          bin: 'tangu-nonexistent-bin-zzz',
        },
      }),
    ).toBe(false);
  });
});

describe('engineStatus — 三态检测', () => {
  const gone = { dirs: ['/nonexistent/forsion/tangu/zzz'], env: ['TANGU_DEFINITELY_UNSET_ZZZ'] };

  it('无 detect → available(不隐藏用户自配引擎)', () => {
    expect(engineStatus({ ...base })).toBe('available');
  });

  it('有鉴权信号(配置目录存在)→ available', () => {
    expect(engineStatus({ ...base, detect: { dirs: ['~'] } })).toBe('available');
  });

  it('有鉴权信号(env 已设)→ available', () => {
    const KEY = 'TANGU_TEST_ENGINE_KEY_XYZ';
    process.env[KEY] = '1';
    try {
      expect(engineStatus({ ...base, detect: { env: [KEY] } })).toBe('available');
    } finally {
      delete process.env[KEY];
    }
  });

  it('bin 在 PATH 但无鉴权信号 → needs-signin(装了没登录)', () => {
    // node 一定在 PATH 上;用它当「已安装的 bin」而无 dirs/env 鉴权信号。
    expect(engineStatus({ ...base, detect: { ...gone, bin: 'node' } })).toBe('needs-signin');
  });

  it('三者全不命中 → not-installed', () => {
    expect(engineStatus({ ...base, detect: { ...gone, bin: 'tangu-nonexistent-bin-zzz' } })).toBe('not-installed');
  });
});

describe('内置引擎清单 — 新增三个外部引擎', () => {
  it('claude-code/codex/openclaw/pi/dsh 都在,且都有可拉起的命令', () => {
    const ids = loadEngines('/nonexistent/engines.json').map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining(['claude-code', 'codex', 'openclaw', 'pi', 'dsh']));
    for (const e of loadEngines('/nonexistent/engines.json')) {
      expect(e.command, e.id).toBeTruthy();
      expect(e.setup, e.id).toBeTruthy(); // 未检测到时给用户看的安装命令
    }
  });

  it('pi-acp 版本必须钉死(非厂商官方包,升级只能是显式改动)', () => {
    const pi = loadEngines('/nonexistent/engines.json').find((e) => e.id === 'pi')!;
    expect(pi.args?.join(' ')).toMatch(/pi-acp@\d+\.\d+\.\d+/);
  });

  it('dsh:命令指向引擎目录、静态声明空 models/commands(automation-only,不探测)', () => {
    const dsh = loadEngines('/nonexistent/engines.json').find((e) => e.id === 'dsh')!;
    expect(dsh.command).toBe('npm');
    expect(dsh.args).toContain('--prefix');
    expect(dsh.args?.some((a) => a.endsWith('cordis.yml'))).toBe(true);
    expect(dsh.models).toEqual([]);
    expect(dsh.commands).toEqual([]);
    // 只认 node_modules:文件是我们种的,种了≠能跑
    expect(dsh.detect?.dirs?.[0]).toMatch(/node_modules$/);
  });
});

describe('envWithFullPath — spawn 端 PATH 补全', () => {
  it('把真实存在的常见安装目录补进 PATH(检测端扫了,spawn 端也得扫)', () => {
    const dirs = extraBinDirs().filter((d) => existsSync(d));
    const out = envWithFullPath({ PATH: '/nonexistent-zzz' });
    for (const d of dirs) expect(out.PATH!.split(path.delimiter)).toContain(d);
    expect(out.PATH!.startsWith('/nonexistent-zzz')).toBe(true); // 原 PATH 优先,补的追加在后
  });

  it('已在 PATH 上的目录不重复追加', () => {
    const d = extraBinDirs().find((x) => existsSync(x));
    if (!d) return; // 环境上一个都不存在则跳过
    const out = envWithFullPath({ PATH: d });
    expect(out.PATH!.split(path.delimiter).filter((x) => x === d)).toHaveLength(1);
  });

  it('Windows 的 `Path` 键按原大小写回写,不产生 Path/PATH 两份', () => {
    const out = envWithFullPath({ Path: '/nonexistent-zzz' }) as Record<string, string>;
    expect(Object.keys(out).filter((k) => k.toUpperCase() === 'PATH')).toHaveLength(1);
  });
});
