import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync, utimesSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { configExists, loadRawConfig, getRawSection, saveSection, updateSection, migrateLegacyConfig } from './config.js';
import { configFile } from './tanguHome.js';
import { loadMcpConfig } from '../mcp/config.js';

const fsFault = vi.hoisted(() => ({ writeSyncENOSPC: false }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    writeSync: ((...args: Parameters<typeof real.writeSync>) => {
      if (fsFault.writeSyncENOSPC) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      return real.writeSync(...args);
    }) as typeof real.writeSync,
  };
});

let dir: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.TANGU_HOME;
  dir = mkdtempSync(join(tmpdir(), 'tangu-cfg-'));
  process.env.TANGU_HOME = dir;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.TANGU_HOME;
  else process.env.TANGU_HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

describe('config.json 唯一真源', () => {
  it('无文件:configExists=false / loadRawConfig=null / getRawSection=undefined', () => {
    expect(configExists()).toBe(false);
    expect(loadRawConfig()).toBeNull();
    expect(getRawSection('mcp')).toBeUndefined();
  });

  it('saveSection 往返且保留其他段', () => {
    saveSection('mcp', { mcpServers: { a: { command: 'x' } } });
    saveSection('cloud', { url: 'u', token: 't', defaultModel: 'm' });
    expect(getRawSection('mcp')).toEqual({ mcpServers: { a: { command: 'x' } } });
    expect(getRawSection('cloud')).toEqual({ url: 'u', token: 't', defaultModel: 'm' });
    expect(configExists()).toBe(true);
  });

  it('migrate:遗留 JSON → config.json 各段,旧文件 → .bak', () => {
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ cloudUrl: 'C', token: 'T', model: 'M' }));
    writeFileSync(join(dir, 'providers.json'), JSON.stringify([{ providerId: 'ollama', baseUrl: 'http://x/v1' }]));
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { s1: { url: 'http://m' } } }));
    writeFileSync(join(dir, 'special-agents.json'), JSON.stringify({ historian: { enabled: true, modelId: 'gm' } }));
    migrateLegacyConfig();
    expect(getRawSection('cloud')).toEqual({ url: 'C', token: 'T', defaultModel: 'M' });
    expect(getRawSection('providers')).toEqual([{ providerId: 'ollama', baseUrl: 'http://x/v1' }]);
    expect(getRawSection('mcp')).toEqual({ mcpServers: { s1: { url: 'http://m' } } });
    expect((getRawSection('specialAgents') as any).historian.modelId).toBe('gm');
    // 旧文件改名为 .bak(可恢复,不删)
    expect(existsSync(join(dir, 'auth.json'))).toBe(false);
    expect(existsSync(join(dir, 'auth.json.bak'))).toBe(true);
    expect(existsSync(join(dir, 'mcp.json.bak'))).toBe(true);
  });

  it('migrate 幂等:config.json 已存在则跳过,不动遗留文件', () => {
    saveSection('cloud', { url: 'pre' });
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { z: {} } }));
    migrateLegacyConfig();
    expect((getRawSection('cloud') as any).url).toBe('pre');
    expect(getRawSection('mcp')).toBeUndefined(); // 未迁移
    expect(existsSync(join(dir, 'mcp.json'))).toBe(true); // 未 .bak
  });

  it('全新安装(无任何遗留)→ 不落空 config.json', () => {
    migrateLegacyConfig();
    expect(configExists()).toBe(false);
  });

  it('A4 接线:loadMcpConfig 优先读 config.json 的 mcp 段', () => {
    saveSection('mcp', { mcpServers: { x: { command: 'c' } } });
    expect(loadMcpConfig().mcpServers).toEqual({ x: { command: 'c' } });
  });

  it('⚠️文件存在但解析不了 → saveSection 抛错且**一个字节都不动**(否则整份被重写成只剩这一段)', () => {
    saveSection('cloud', { url: 'u', token: 't' });          // 先有一份好配置
    const nested = join(dir, 'tangu', 'config.json');
    const path = existsSync(nested) ? nested : join(dir, 'config.json');
    const before = '{ 坏掉的 json,,,';
    writeFileSync(path, before, 'utf8');
    expect(() => saveSection('approval', { base: 'readonly', allow: [], ask: [], deny: [] })).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(before);          // 没被覆盖
    expect(existsSync(`${path}.lock`)).toBe(false);           // 抛错也放锁
  });

  const leftovers = (): string[] =>
    readdirSync(dirname(configFile())).filter((f) => f.startsWith('config.json') && f !== 'config.json');

  it('原子写:不留临时文件与锁,文件 0600', () => {
    saveSection('mcp', { mcpServers: { a: { command: 'x', env: { KEY: 'secret' } } } });
    expect(leftovers()).toEqual([]);
    if (process.platform !== 'win32') expect(statSync(configFile()).mode & 0o777).toBe(0o600);
  });

  it('跨进程写锁:别的进程占着锁 → saveSection 等它改完放锁,在它写完的内容上合并', async () => {
    saveSection('cloud', { url: 'u' });
    writeFileSync(`${configFile()}.lock`, '');
    // 「另一个进程」(桌面主进程)持锁 300ms,期间写了 channels 段再放锁;saveSection 是同步的,只能靠别的进程放锁
    const other = spawn(process.execPath, ['-e', `setTimeout(() => {
      const fs = require('fs'); const f = process.argv[1];
      fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), channels: { tg: 1 } }));
      fs.rmSync(f + '.lock');
    }, 300)`, configFile()], { stdio: 'ignore' });
    const exited = new Promise((r) => other.on('exit', r));
    const t0 = Date.now();
    saveSection('approval', { base: 'ask' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(loadRawConfig()).toEqual({ cloud: { url: 'u' }, channels: { tg: 1 }, approval: { base: 'ask' } });
    expect(leftovers()).toEqual([]);
    await exited;
  });

  it('updateSection:段级读改写在锁内 —— 别的进程持锁期间改了同一段,等它放锁后在它的结果上改,不盖掉', async () => {
    saveSection('channels', { tg: { on: true } });
    writeFileSync(`${configFile()}.lock`, 'other');
    const other = spawn(process.execPath, ['-e', `setTimeout(() => {
      const fs = require('fs'); const f = process.argv[1]; const c = JSON.parse(fs.readFileSync(f, 'utf8'));
      fs.writeFileSync(f, JSON.stringify({ ...c, channels: { ...c.channels, wechat: { on: true } } }));
      fs.rmSync(f + '.lock');
    }, 200)`, configFile()], { stdio: 'ignore' });
    const exited = new Promise((r) => other.on('exit', r));
    const out = updateSection('channels', (all: any) => ({ ...(all || {}), qq: { on: true } }));
    expect(getRawSection('channels')).toEqual({ tg: { on: true }, wechat: { on: true }, qq: { on: true } });
    expect(out).toEqual(getRawSection('channels'));
    const bytes = readFileSync(configFile(), 'utf8');
    expect(updateSection('channels', () => undefined)).toBeUndefined(); // undefined = 不写
    expect(readFileSync(configFile(), 'utf8')).toBe(bytes);
    expect(leftovers()).toEqual([]);
    await exited;
  });

  it('持锁期间锁被当陈旧锁回收、别人建了新锁(ABA / 挂起超 5s)→ 提交前核 token 抛错不落盘,也不删别人的锁', () => {
    saveSection('cloud', { url: 'u' });
    const lock = `${configFile()}.lock`;
    const before = readFileSync(configFile(), 'utf8');
    expect(() => updateSection('cloud', () => {
      rmSync(lock); // 临界区里:锁被偷锁者挪走,第三个进程抢到新锁
      writeFileSync(lock, 'other-token');
      return { url: 'mine' };
    })).toThrow('被当作陈旧锁回收');
    expect(readFileSync(configFile(), 'utf8')).toBe(before);
    expect(readFileSync(lock, 'utf8')).toBe('other-token');
    expect(leftovers()).toEqual(['config.json.lock']);
  });

  it.skipIf(process.platform === 'win32')('POSIX 上建锁报 EACCES = 真权限错误 → 立刻抛,不当「被占」同步空等 10s', () => {
    saveSection('cloud', { url: 'u' });
    const d = dirname(configFile());
    chmodSync(d, 0o500);
    let code: string | undefined;
    const t0 = performance.now();
    try { saveSection('cloud', { url: 'x' }); } catch (e: any) { code = e.code; } finally { chmodSync(d, 0o700); }
    expect(code).toBe('EACCES');
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('锁建出来了但 token 写不进去(磁盘满)→ 抛原始错误,顺手删掉这把空锁(不让所有写者同步干等 5s)', () => {
    saveSection('cloud', { url: 'u' });
    fsFault.writeSyncENOSPC = true;
    let code: string | undefined;
    try { saveSection('cloud', { url: 'x' }); } catch (e: any) { code = e.code; } finally { fsFault.writeSyncENOSPC = false; }
    expect(code).toBe('ENOSPC');
    expect(leftovers()).toEqual([]);
    const t0 = performance.now();
    saveSection('cloud', { url: 'y' }); // 紧接着的写入不用等
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(getRawSection('cloud')).toEqual({ url: 'y' });
  });

  it('陈旧锁(持锁进程死在临界区,mtime 超 5s)→ 偷锁照写,不留锁与残渣', () => {
    const lock = `${configFile()}.lock`;
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 20_000);
    utimesSync(lock, old, old);
    const t0 = Date.now();
    saveSection('cloud', { url: 'u' });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(getRawSection('cloud')).toEqual({ url: 'u' });
    expect(leftovers()).toEqual([]);
  });
});
