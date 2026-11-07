/**
 * 电脑历史逐行加密的引擎侧:黄金向量(与 desktop/electron/computerHistoryCrypto.test.ts 钉同一个字面量)、
 * 桌面经 stdin 交钥匙的私有通道、读端「解不开 ≠ 没有」。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createCipheriv, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chKeyFromHex, computerHistoryKey, readChLine, resetComputerHistoryKeyForTests, setComputerHistoryKey, type ChKey,
} from './computerHistoryCrypto.js';
import { handleHostMessage, startHostChannel, HOST_STDIN_ENV } from '../core/hostChannel.js';
import {
  CH_DESKTOP_CONFIG_ENV, CH_LOCKED_NOTICE, computerHistoryDigest, computerHistoryDir, readChSignals, readComputerHistory, type ChEvent,
} from './computerHistory.js';

const GOLDEN = {
  keyHex: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  json: '{"t":1759000000000,"kind":"app","app":{"name":"Notes","bundleId":"com.apple.Notes"}}',
  line: 'ch1.b40ebba7.oKGio6SlpqeoqaqrnToID3/6NYpbVbfjN0rw7kCcdTL53iwIvjQE5w/bVy3wFzePjRgoHzH9aa0rQKG3KG8jO0D8OBw0MG8ywTnhko6e5gBdi4WQhI6aNsGhuN++KdbZ0NnRdYOE6IHwXILeL+JU8A==',
};

/** 测试里自己加密(引擎镜像只读,不带加密函数):与桌面 encryptLine 同一口径。 */
function encryptLine(k: ChKey, json: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k.key, iv);
  c.setAAD(Buffer.from('forsion-computer-history/1'));
  const ct = Buffer.concat([c.update(json, 'utf8'), c.final()]);
  return `ch1.${k.kid}.${Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64')}`;
}

describe('格式镜像', () => {
  it('黄金向量:桌面写出的那一行,引擎用同一把钥匙解回原文;没钥匙 / 别的钥匙 = locked', () => {
    const k = chKeyFromHex(GOLDEN.keyHex)!;
    expect(k.kid).toBe('b40ebba7');
    expect(readChLine(GOLDEN.line, k)).toEqual({ kind: 'enc', text: GOLDEN.json });
    expect(readChLine(GOLDEN.line, null)).toEqual({ kind: 'locked' });
    expect(readChLine(GOLDEN.line, chKeyFromHex('ab'.repeat(32)))).toEqual({ kind: 'locked' });
    expect(readChLine(GOLDEN.line.slice(0, 70), k)).toEqual({ kind: 'broken' });
    expect(readChLine('{"t":1}', null)).toEqual({ kind: 'plain', text: '{"t":1}' });
  });
});

describe('stdin 私有通道(core/hostChannel)', () => {
  afterEach(() => resetComputerHistoryKeyForTests());

  it('只在桌面拉起时启用;开关读完即从 env 删掉(子进程不继承);逐行收钥匙,形状不对的不顶掉原来那把', () => {
    const input = Object.assign(new EventEmitter(), { setEncoding: () => {}, unref: () => {} }) as unknown as NodeJS.ReadableStream;
    expect(startHostChannel(input, {})).toBe(false);
    const env: NodeJS.ProcessEnv = { [HOST_STDIN_ENV]: '1' };
    expect(startHostChannel(input, env)).toBe(true);
    expect(HOST_STDIN_ENV in env).toBe(false);
    const k = chKeyFromHex(GOLDEN.keyHex)!;
    // 一条消息拆成两块到达
    (input as unknown as EventEmitter).emit('data', `{"computerHistoryKey":"${GOLDEN.keyHex.slice(0, 20)}`);
    expect(computerHistoryKey()).toBeNull();
    (input as unknown as EventEmitter).emit('data', `${GOLDEN.keyHex.slice(20)}"}\n`);
    expect(computerHistoryKey()?.kid).toBe(k.kid);
    handleHostMessage('{"computerHistoryKey":"nope"}');
    handleHostMessage('not json');
    expect(computerHistoryKey()?.kid).toBe(k.kid);
    expect(setComputerHistoryKey('cd'.repeat(32))).toBe(true);
    expect(computerHistoryKey()?.kid).not.toBe(k.kid);
  });
});

describe('读端:密文行解得开照常读;解不开 ≠ 没有活动', () => {
  const NOW = new Date(2026, 8, 27, 14, 30).getTime();
  const at = (h: number, m: number): number => new Date(2026, 8, 27, h, m).getTime();
  const KEY_HEX = 'ab'.repeat(32);
  const key = chKeyFromHex(KEY_HEX)!;
  const OTHER = chKeyFromHex('cd'.repeat(32))!;
  let home: string;
  const prev = { home: process.env.TANGU_HOME, cfg: process.env[CH_DESKTOP_CONFIG_ENV] };
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'tangu-chenc-'));
    process.env.TANGU_HOME = home;
    mkdirSync(join(home, 'userData'), { recursive: true });
    writeFileSync(join(home, 'userData', 'cfg.json'), JSON.stringify({ computerHistoryEnabled: true }));
    process.env[CH_DESKTOP_CONFIG_ENV] = join(home, 'userData', 'cfg.json');
  });
  afterAll(() => {
    if (prev.home === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prev.home;
    if (prev.cfg === undefined) delete process.env[CH_DESKTOP_CONFIG_ENV]; else process.env[CH_DESKTOP_CONFIG_ENV] = prev.cfg;
    rmSync(home, { recursive: true, force: true });
  });
  beforeEach(() => {
    resetComputerHistoryKeyForTests();
    mkdirSync(computerHistoryDir(), { recursive: true });
    writeFileSync(join(computerHistoryDir(), 'state.json'), JSON.stringify({ v: 1, enabled: true, pausedUntil: null, status: 'recording', since: at(9, 0), updatedAt: at(9, 0), platform: 'darwin' }));
    rmSync(join(computerHistoryDir(), 'events'), { recursive: true, force: true });
    mkdirSync(join(computerHistoryDir(), 'events'), { recursive: true });
  });
  afterEach(() => resetComputerHistoryKeyForTests());
  const write = (lines: string[]): void => {
    for (const l of lines) appendFileSync(join(computerHistoryDir(), 'events', '2026-09-27.jsonl'), `${l}\n`);
  };
  const ev = (e: ChEvent): string => JSON.stringify(e);
  const CODE = { name: 'Code', bundleId: 'com.microsoft.VSCode' };

  it('有钥匙:明文行(迁移前)与密文行混在一起照常读', async () => {
    setComputerHistoryKey(KEY_HEX);
    write([
      ev({ t: at(13, 0), kind: 'app', app: CODE, title: 'plain-title.md' }),
      encryptLine(key, ev({ t: at(13, 30), kind: 'window', app: CODE, title: 'enc-title.md' })),
      encryptLine(key, ev({ t: at(14, 0), kind: 'text', app: CODE, text: 'typed secretly' })),
    ]);
    const out = await readComputerHistory({ detail: 'events' }, NOW);
    expect(out).toContain('plain-title.md');
    expect(out).toContain('enc-title.md');
    expect(out).toContain('typed secretly');
    expect(out).not.toContain(CH_LOCKED_NOTICE);
    expect(await readChSignals(NOW - 12 * 3_600_000, NOW)).toHaveLength(3);
  });

  it('没钥匙:不说「这段时间没有活动」,如实说读不出来;信号 null(规则不按残缺数据触发);摘要不给', async () => {
    write([encryptLine(key, ev({ t: at(13, 0), kind: 'app', app: CODE, title: 'x' })), encryptLine(key, ev({ t: at(14, 0), kind: 'app', app: CODE }))]);
    const out = await readComputerHistory({}, NOW);
    expect(out).toContain(CH_LOCKED_NOTICE);
    expect(out).not.toMatch(/no activity recorded/);
    expect(out).toMatch(/latest event unreadable/);
    expect(await readChSignals(NOW - 12 * 3_600_000, NOW)).toBeNull();
    expect(await computerHistoryDigest(NOW)).toBe('');
  });

  it('一部分是别的钥匙加的:读得出的照给,并注明缺了几条', async () => {
    setComputerHistoryKey(KEY_HEX);
    write([
      encryptLine(key, ev({ t: at(13, 0), kind: 'app', app: CODE, title: 'visible.md' })),
      encryptLine(OTHER, ev({ t: at(13, 10), kind: 'app', app: CODE, title: 'hidden.md' })),
    ]);
    const out = await readComputerHistory({ detail: 'events' }, NOW);
    expect(out).toContain('visible.md');
    expect(out).not.toContain('hidden.md');
    expect(out).toMatch(/1 encrypted record on these days could not be read/);
  });
});
