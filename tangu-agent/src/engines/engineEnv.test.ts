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
import { claudeCloudEnvRules, codexConfigEnvKeys, engineSubprocessEnv, envNameMatcher, layeredLookup } from './engineEnv.js';

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

  it('passEnv:前缀 / 精确名;单独一个 * = 整份继承,但 FORSION_* / TANGU_* 和令牌仍不给', () => {
    const base = { PATH: '/bin', FOO_KEY: '1', FOOBAR: '2', BAR: '3', TANGU_TOKEN: 't', FORSION_X: 'f', tangu_lower: 'l' };
    expect(engineSubprocessEnv({ ...def, passEnv: ['FOO_*', 'bar'] }, {}, base)).toMatchObject({ FOO_KEY: '1', BAR: '3' });
    expect(engineSubprocessEnv({ ...def, passEnv: ['FOO_*'] }, {}, base).FOOBAR).toBeUndefined();
    const all = engineSubprocessEnv({ ...def, passEnv: ['*'] }, {}, base);
    expect(all).toMatchObject({ FOO_KEY: '1', FOOBAR: '2', BAR: '3' });
    for (const k of ['TANGU_TOKEN', 'FORSION_X', 'tangu_lower']) expect(all[k], k).toBeUndefined();
    // 点名放 FORSION_* 也不行;要给只能经 def.env 明写
    expect(engineSubprocessEnv({ ...def, passEnv: ['FORSION_*'] }, {}, base).FORSION_X).toBeUndefined();
    expect(engineSubprocessEnv({ ...def, env: { FORSION_X: 'explicit' } }, {}, base).FORSION_X).toBe('explicit');
  });

  it('git / pip 的配置变量不放(VALUE 里可以是认证头),NODE_OPTIONS 不放', () => {
    const env = engineSubprocessEnv(def, {}, {
      PATH: '/bin', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://example.com/.extraheader', GIT_CONFIG_VALUE_0: 'Authorization: Bearer secret',
      PIP_INDEX_URL: 'https://user:token@pypi.example.com/simple', NODE_OPTIONS: '--require /tmp/x.js',
    });
    for (const k of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'PIP_INDEX_URL', 'NODE_OPTIONS']) expect(env[k], k).toBeUndefined();
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

describe('Codex:config.toml 里服务商点名的变量', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'codex-home-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const keysOf = (home: string) => codexConfigEnvKeys(layeredLookup([{ CODEX_HOME: home }])).sort();

  it('env_key / env_http_headers 放行(带引号的键名也认),别的 *_API_KEY 不放', () => {
    writeFileSync(path.join(dir, 'config.toml'), [
      'model_provider = "ds"',
      '[model_providers.ds]',
      'base_url = "https://api.example.com/v1"',
      'env_key = "DS_RELAY_KEY"',
      '[model_providers.az]',
      "name = 'Azure'",
      'env_http_headers = { "api-key" = "AZURE_OPENAI_API_KEY" }',
      '[model_providers.quoted]',
      '"env_key" = "QUOTED_KEY"',
    ].join('\n'));
    expect(keysOf(dir)).toEqual(['AZURE_OPENAI_API_KEY', 'DS_RELAY_KEY', 'QUOTED_KEY']);
    const env = engineSubprocessEnv(builtin('codex'), {}, { PATH: '/bin', CODEX_HOME: dir, DS_RELAY_KEY: 'k1', OPENAI_API_KEY: 'k2', GROQ_API_KEY: 'k3' });
    expect(env).toMatchObject({ DS_RELAY_KEY: 'k1', OPENAI_API_KEY: 'k2', CODEX_HOME: dir });
    expect(env.GROQ_API_KEY).toBeUndefined();
  });

  it('注释里、服务商之外的 env_key 不算;点名 FORSION_* / TANGU_* 也放不进来', () => {
    writeFileSync(path.join(dir, 'config.toml'), [
      '# env_key = "COMMENTED_KEY"',
      'env_key = "TOP_LEVEL_KEY"',
      'notes = "env_key = \'IN_STRING_KEY\'"',
      '[model_providers.bad]',
      'env_key = "FORSION_ENV_SENTINEL"',
    ].join('\n'));
    expect(keysOf(dir)).toEqual(['FORSION_ENV_SENTINEL']); // 解析出来了,但下面继承时照样挡掉
    const env = engineSubprocessEnv(builtin('codex'), {}, { PATH: '/bin', CODEX_HOME: dir, COMMENTED_KEY: 'c', TOP_LEVEL_KEY: 't', IN_STRING_KEY: 's', FORSION_ENV_SENTINEL: 'f' });
    for (const k of ['COMMENTED_KEY', 'TOP_LEVEL_KEY', 'IN_STRING_KEY', 'FORSION_ENV_SENTINEL']) expect(env[k], k).toBeUndefined();
  });

  it('CODEX_HOME 由清单指到别处时读那一份;没有 / 坏掉的 config.toml 就是空', () => {
    const other = path.join(dir, 'other');
    mkdirSync(other);
    writeFileSync(path.join(other, 'config.toml'), '[model_providers.o]\nenv_key = "OTHER_KEY"\n');
    const env = engineSubprocessEnv({ ...builtin('codex'), env: { CODEX_HOME: other } }, {}, { PATH: '/bin', OTHER_KEY: 'o' });
    expect(env.OTHER_KEY).toBe('o');
    expect(keysOf(path.join(dir, 'missing'))).toEqual([]);
    writeFileSync(path.join(dir, 'config.toml'), 'this is = = not toml [');
    expect(keysOf(dir)).toEqual([]);
  });
});

describe('Claude Code 走云厂商', () => {
  it('开了 Bedrock 才放 AWS_*;没开不放', () => {
    const base = { PATH: '/bin', AWS_BEARER_TOKEN_BEDROCK: 'b', AWS_REGION: 'us-east-1', GOOGLE_APPLICATION_CREDENTIALS: '/g.json' };
    const off = engineSubprocessEnv(builtin('claude-code'), {}, base);
    expect(off.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    const on = engineSubprocessEnv(builtin('claude-code'), {}, { ...base, CLAUDE_CODE_USE_BEDROCK: '1' });
    expect(on).toMatchObject({ AWS_BEARER_TOKEN_BEDROCK: 'b', AWS_REGION: 'us-east-1', CLAUDE_CODE_USE_BEDROCK: '1' });
    expect(on.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
  });

  it('Vertex / Foundry 各放各的;开关写在清单 env 里也算', () => {
    expect(claudeCloudEnvRules(layeredLookup([{ CLAUDE_CODE_USE_VERTEX: 'true' }]))).toContain('GOOGLE_APPLICATION_CREDENTIALS');
    expect(claudeCloudEnvRules(layeredLookup([{ CLAUDE_CODE_USE_FOUNDRY: '1' }]))).toEqual(['AZURE_*']);
    expect(claudeCloudEnvRules(layeredLookup([{ CLAUDE_CODE_USE_BEDROCK: '0' }]))).toEqual([]);
    const env = engineSubprocessEnv({ ...builtin('claude-code'), env: { CLAUDE_CODE_USE_BEDROCK: '1' } }, {}, { PATH: '/bin', AWS_PROFILE: 'p' });
    expect(env.AWS_PROFILE).toBe('p');
  });
});

describe('layeredLookup', () => {
  it('后层盖前层;Windows 上名字不分大小写,POSIX 上区分', () => {
    const layers = [{ CODEX_HOME: '/a' }, { codex_home: '/b' }];
    expect(layeredLookup(layers, 'win32')('CODEX_HOME')).toBe('/b');
    expect(layeredLookup(layers, 'darwin')('CODEX_HOME')).toBe('/a');
    expect(layeredLookup([{ X: '1' }, undefined, { Y: '2' }], 'linux')('X')).toBe('1');
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

  it('同一 id 写了两条:后一条只和内置的合,不继承前一条的 *', () => {
    const file = path.join(dir, 'engines.json');
    writeFileSync(file, JSON.stringify({ engines: [
      { id: 'pi', name: 'Pi', command: 'npx', passEnv: ['*'] },
      { id: 'pi', name: 'Pi', command: 'npx', passEnv: ['ACME_API_KEY'] },
      { id: 'mine', name: 'Mine', command: 'a', passEnv: ['*'] },
      { id: 'mine', name: 'Mine', command: 'b', passEnv: ['ACME_API_KEY'] },
    ] }));
    const byId = new Map(loadEngines(file).map((e) => [e.id, e]));
    expect(byId.get('pi')?.passEnv?.sort()).toEqual(['ACME_API_KEY', 'PI_*']);
    expect(byId.get('mine')?.passEnv).toEqual(['ACME_API_KEY']);
  });
});
