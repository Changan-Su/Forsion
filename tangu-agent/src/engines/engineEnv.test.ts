/** 外部引擎每轮起进程(以及探测能力)时,子进程环境走白名单:本进程环境里的哨兵变量进不去。
 *  真起一个子进程(经 spawnEngine,和跑一轮、探测用的是同一个入口)把它拿到的环境原样吐出来看 ——
 *  旧代码整份继承、只剥 C2 令牌,这里的 FORSION_* / TANGU_* / 别家的 key / 随便一个密钥都会漏进去。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnEngine } from './acpEngine.js';
import { loadEngines, type EngineDef } from './config.js';
import { dshEngineDef } from './dsh.js';
import { codexConfigEnvKeys, engineSubprocessEnv, envNameMatcher } from './engineEnv.js';

// 子进程把自己的环境写到 stdout。Windows 上 spawnEngine 用 shell:true,node 路径可能带空格,加引号;代码里不含 cmd 特殊字符。
const DUMP = 'process.stdout.write(JSON.stringify(process.env))';
const asDumper = (def: EngineDef): EngineDef => ({
  ...def,
  command: process.platform === 'win32' ? `"${process.execPath}"` : process.execPath,
  args: ['-e', DUMP],
});
function childEnv(def: EngineDef, env?: Record<string, string>): Promise<Record<string, string>> {
  const c = spawnEngine(asDumper(def), { env });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  return new Promise((resolve, reject) => {
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`dumper exited ${code}`))));
  });
}
/** Windows 的环境变量名不分大小写(`Path`),按名找值也不分。 */
const get = (env: Record<string, string | undefined>, name: string): string | undefined =>
  Object.entries(env).find(([k]) => k.toUpperCase() === name.toUpperCase())?.[1];

const builtin = (id: string): EngineDef => {
  const def = loadEngines(path.join(tmpdir(), 'tangu-engine-env-no-such-file.json')).find((e) => e.id === id);
  if (!def) throw new Error(`no builtin ${id}`);
  return def;
};

const SENTINELS = {
  FORSION_ENV_SENTINEL: 'sentinel-forsion',
  TANGU_ENV_SENTINEL: 'sentinel-tangu',
  ACME_DB_PASSWORD: 'sentinel-random-secret',
  OPENAI_API_KEY: 'sentinel-openai',
  ANTHROPIC_API_KEY: 'sentinel-anthropic',
  DEEPSEEK_API_KEY: 'sentinel-deepseek',
  TANGU_TOKEN: 'sentinel-c2-token',
  HTTPS_PROXY: 'http://127.0.0.1:9',
};

describe('外部引擎子进程环境:白名单', () => {
  beforeEach(() => { for (const [k, v] of Object.entries(SENTINELS)) vi.stubEnv(k, v); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('DSH:FORSION_* / TANGU_* / 别家的 key / 随便一个密钥 / 令牌都拿不到;自己的 key、PATH、HOME、代理、这一轮的指令目录都在', async () => {
    const env = await childEnv(dshEngineDef(), { DSH_AGENTS_HOME: '/tmp/agents-home' });
    for (const k of ['FORSION_ENV_SENTINEL', 'TANGU_ENV_SENTINEL', 'ACME_DB_PASSWORD', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'TANGU_TOKEN']) {
      expect(get(env, k), k).toBeUndefined();
    }
    expect(get(env, 'DEEPSEEK_API_KEY')).toBe('sentinel-deepseek');
    expect(get(env, 'PATH')).toBeTruthy();
    expect(get(env, process.platform === 'win32' ? 'USERPROFILE' : 'HOME')).toBeTruthy();
    expect(get(env, 'HTTPS_PROXY')).toBe('http://127.0.0.1:9');
    expect(get(env, 'DSH_AGENTS_HOME')).toBe('/tmp/agents-home');
  });

  it('Claude Code(内置定义):拿得到自己的 ANTHROPIC_API_KEY,拿不到 DeepSeek / OpenAI 的', async () => {
    const env = await childEnv(builtin('claude-code'));
    expect(get(env, 'ANTHROPIC_API_KEY')).toBe('sentinel-anthropic');
    for (const k of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'FORSION_ENV_SENTINEL', 'TANGU_ENV_SENTINEL', 'ACME_DB_PASSWORD', 'TANGU_TOKEN']) {
      expect(get(env, k), k).toBeUndefined();
    }
  });

  it('引擎清单明写的 env 原样给,但写进去的令牌照样剥掉', async () => {
    const def: EngineDef = { id: 'custom', name: 'Custom', command: 'x', env: { MY_ENGINE_FLAG: 'on', TANGU_TOKEN: 'smuggled', FORSION_TOKEN: 'smuggled' } };
    const env = await childEnv(def);
    expect(get(env, 'MY_ENGINE_FLAG')).toBe('on');
    expect(get(env, 'TANGU_TOKEN')).toBeUndefined();
    expect(get(env, 'FORSION_TOKEN')).toBeUndefined();
    expect(get(env, 'ACME_DB_PASSWORD')).toBeUndefined();
  });
});

describe('engineSubprocessEnv(纯函数)', () => {
  const def: EngineDef = { id: 'x', name: 'X', command: 'x' };

  it('名字不分大小写:Windows 的 Path / SystemRoot、小写的 http_proxy 都放行', () => {
    const env = engineSubprocessEnv(def, {}, { Path: '/bin', SystemRoot: 'C:\\Windows', http_proxy: 'http://p', npm_config_registry: 'https://r', LC_ALL: 'C', XDG_CONFIG_HOME: '/c', SECRET: 's' });
    expect(env.Path).toContain('/bin');
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.http_proxy).toBe('http://p');
    expect(env.npm_config_registry).toBe('https://r');
    expect(env.LC_ALL).toBe('C');
    expect(env.XDG_CONFIG_HOME).toBe('/c');
    expect(env.SECRET).toBeUndefined();
  });

  it('passEnv:前缀 / 精确名;单独一个 * = 整份继承,令牌仍剥', () => {
    const base = { PATH: '/bin', FOO_KEY: '1', FOOBAR: '2', BAR: '3', TANGU_TOKEN: 't' };
    expect(engineSubprocessEnv({ ...def, passEnv: ['FOO_*', 'bar'] }, {}, base)).toMatchObject({ FOO_KEY: '1', BAR: '3' });
    expect(engineSubprocessEnv({ ...def, passEnv: ['FOO_*'] }, {}, base).FOOBAR).toBeUndefined();
    const all = engineSubprocessEnv({ ...def, passEnv: ['*'] }, {}, base);
    expect(all).toMatchObject({ FOO_KEY: '1', FOOBAR: '2', BAR: '3' });
    expect(all.TANGU_TOKEN).toBeUndefined();
  });

  it('detect.env 和 agentsHomeEnv 自动算这个引擎自己的', () => {
    const env = engineSubprocessEnv({ ...def, detect: { env: ['ACME_TOKEN'] }, agentsHomeEnv: 'ACME_AGENTS' }, {}, { ACME_TOKEN: 'a', ACME_AGENTS: '/h', ACME_OTHER: 'x' });
    expect(env).toMatchObject({ ACME_TOKEN: 'a', ACME_AGENTS: '/h' });
    expect(env.ACME_OTHER).toBeUndefined();
  });

  it('engines.json 里写坏的 passEnv(非字符串 / 空串)忽略,不放行全部', () => {
    const env = engineSubprocessEnv({ ...def, passEnv: [123 as any, '', '  ', null as any] }, {}, { PATH: '/bin', SECRET: 's' });
    expect(env.SECRET).toBeUndefined();
  });

  it('envNameMatcher', () => {
    const m = envNameMatcher(['PATH', 'LC_*']);
    expect(m('Path')).toBe(true);
    expect(m('lc_ctype')).toBe(true);
    expect(m('PATHEXT')).toBe(false);
  });
});

describe('Codex:config.toml 里 env_key 点名的变量', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'codex-home-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('自定义服务商的 key 放行,别的 *_API_KEY 不放', () => {
    writeFileSync(path.join(dir, 'config.toml'), [
      'model_provider = "ds"',
      '[model_providers.ds]',
      'base_url = "https://api.example.com/v1"',
      'env_key = "DS_RELAY_KEY"',
      '[model_providers.az]',
      "name = 'Azure'",
      "env_key='AZURE_OPENAI_API_KEY'",
    ].join('\n'));
    expect(codexConfigEnvKeys({ CODEX_HOME: dir }).sort()).toEqual(['AZURE_OPENAI_API_KEY', 'DS_RELAY_KEY']);
    const env = engineSubprocessEnv(builtin('codex'), {}, { PATH: '/bin', CODEX_HOME: dir, DS_RELAY_KEY: 'k1', OPENAI_API_KEY: 'k2', GROQ_API_KEY: 'k3' });
    expect(env).toMatchObject({ DS_RELAY_KEY: 'k1', OPENAI_API_KEY: 'k2', CODEX_HOME: dir });
    expect(env.GROQ_API_KEY).toBeUndefined();
  });

  it('CODEX_HOME 由清单指到别处时读那一份;没有 config.toml 就是空', () => {
    const other = path.join(dir, 'other');
    mkdirSync(other);
    writeFileSync(path.join(other, 'config.toml'), 'env_key = "OTHER_KEY"\n');
    const env = engineSubprocessEnv({ ...builtin('codex'), env: { CODEX_HOME: other } }, {}, { PATH: '/bin', OTHER_KEY: 'o' });
    expect(env.OTHER_KEY).toBe('o');
    expect(codexConfigEnvKeys({ CODEX_HOME: path.join(dir, 'missing') })).toEqual([]);
  });
});

describe('loadEngines:按 id 覆盖内置条目时 passEnv 取并集', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'engines-json-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('覆盖条目没写 passEnv → 沿用内置的;写了 → 和内置的合在一起', () => {
    const file = path.join(dir, 'engines.json');
    writeFileSync(file, JSON.stringify({ engines: [
      { id: 'dsh', name: 'DSH (local)', command: '/opt/node', args: ['bin.js', '--profile', 'acp'] },
      { id: 'pi', name: 'Pi', command: 'npx', args: ['-y', 'pi-acp'], passEnv: ['GROQ_API_KEY'] },
    ] }));
    const byId = new Map(loadEngines(file).map((e) => [e.id, e]));
    expect(byId.get('dsh')?.passEnv).toEqual(expect.arrayContaining(['DSH_*', 'DEEPSEEK_*']));
    expect(byId.get('pi')?.passEnv).toEqual(expect.arrayContaining(['PI_*', 'GROQ_API_KEY']));
  });
});
