/** 「由谁来跑」(config.toml `engine`,11-14 DSH 融合底层第 2 步)的读写与自带的 DSH:
 *  字段往返、保存只收认识的引擎、没提交就保留、内置 DSH 只在本机播种一次且删了不回来、名册里排在内置几位之后。
 *  独立文件 → ensureAgentsReady 的记忆化不被别的用例污染(每个用例 resetModules 重来)。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tangu-agent-engine-'));
  process.env.TANGU_HOME = home;
  vi.resetModules();
});
afterEach(() => {
  delete process.env.TANGU_HOME;
  rmSync(home, { recursive: true, force: true });
});

async function configure(hostExec: boolean) {
  const { configureTangu } = await import('../seams/runtime.js');
  const { createTanguProfile } = await import('../profiles/index.js');
  const { createSqliteHost } = await import('../adapters/standalone/sqliteHost.js');
  const { host } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  const profile = createTanguProfile({ sandboxMode: 'none', toolBuiltins: ['read_file'] });
  configureTangu({ host, profile: hostExec ? profile : { ...profile, capabilities: { ...profile.capabilities, hostExec: false } } } as any);
}

describe('engine 字段的读写', { timeout: 60_000 }, () => {
  it('config.toml 往返:engine / engine_model 原样留;tangu 与空串等于缺席', async () => {
    const { parseAgentConfig, serializeAgentConfig } = await import('./agentRegistry.js');
    const def = parseAgentConfig('a', 'name = "A"\nengine = "dsh"\nengine_model = "[\\"deepseek-account\\",\\"x\\"]"\ndeveloper_instructions = "hi"\n', '');
    expect(def.engine).toBe('dsh');
    expect(def.engineModel).toBe('["deepseek-account","x"]');
    const back = parseAgentConfig('a', serializeAgentConfig(def), '');
    expect(back.engine).toBe('dsh');
    expect(back.engineModel).toBe('["deepseek-account","x"]');
    expect(parseAgentConfig('a', 'name = "A"\nengine = "tangu"\n', '').engine).toBeUndefined();
    expect(parseAgentConfig('a', 'name = "A"\nengine = ""\n', '').engine).toBeUndefined();
    // 本版本不认识的值(新版本写的 / 手改的)照留,运行时按「不认识」明确失败,不当 Tangu
    expect(parseAgentConfig('a', 'name = "A"\nengine = "claude-code"\n', '').engine).toBe('claude-code');
  });

  it('保存只收认识的引擎;没提交就保留;tangu / 空串清掉;engineModel 空串清掉', async () => {
    const { buildAgentDef } = await import('./agentRegistry.js');
    const base = buildAgentDef('a', null, { name: 'A', systemPrompt: 'p', engine: 'dsh', engineModel: 'm1' });
    expect(base.engine).toBe('dsh');
    expect(base.engineModel).toBe('m1');
    const kept = buildAgentDef('a', base, { name: 'A', systemPrompt: 'p' });
    expect(kept.engine).toBe('dsh');
    expect(kept.engineModel).toBe('m1');
    expect(buildAgentDef('a', base, { name: 'A', systemPrompt: 'p', engine: 'tangu' }).engine).toBeUndefined();
    expect(buildAgentDef('a', base, { name: 'A', systemPrompt: 'p', engine: '' }).engine).toBeUndefined();
    expect(buildAgentDef('a', base, { name: 'A', systemPrompt: 'p', engineModel: '' }).engineModel).toBeUndefined();
    expect(() => buildAgentDef('a', base, { name: 'A', systemPrompt: 'p', engine: 'claude-code' })).toThrow(/unsupported engine/);
  });

  it('patchAgent 只改提交了的:改名不动 engine;换回 Tangu 时 Tangu 的 model 还在', async () => {
    await configure(true);
    const { saveAgent, patchAgent, getAgent } = await import('./agentRegistry.js');
    await saveAgent({ slug: 'mine', name: 'Mine', systemPrompt: 'p', model: 'tangu-model', engine: 'dsh', engineModel: 'dsh-model' });
    await patchAgent('mine', { name: 'Renamed' });
    expect((await getAgent('mine'))?.engine).toBe('dsh');
    await patchAgent('mine', { engine: '' });
    const back = await getAgent('mine');
    expect(back?.engine).toBeUndefined();
    expect(back?.model).toBe('tangu-model');
    expect(back?.engineModel).toBe('dsh-model');
  });
});

describe('自带的 DSH', { timeout: 60_000 }, () => {
  it('本机播种一次:跑在 DSH 上、名字叫 DSH;排在内置几位之后、Muse 之前', async () => {
    await configure(true);
    const { listAgents, DSH_AGENT_SLUG } = await import('./agentRegistry.js');
    const agents = await listAgents();
    const dsh = agents.find((a) => a.slug === DSH_AGENT_SLUG);
    expect(dsh?.engine).toBe('dsh');
    expect(dsh?.nameZh).toBe('DSH');
    expect(dsh?.nameEn).toBe('DSH');
    expect(existsSync(join(home, 'agents', '.seeded-dsh-v1'))).toBe(true);
    const order = agents.map((a) => a.slug);
    expect(order.indexOf('dsh')).toBeGreaterThan(order.indexOf('coding'));
    if (order.includes('muse')) expect(order.indexOf('dsh')).toBeLessThan(order.indexOf('muse'));
  });

  it('删了不再回来', async () => {
    await configure(true);
    let reg = await import('./agentRegistry.js');
    await reg.listAgents();
    rmSync(join(home, 'agents', 'dsh'), { recursive: true, force: true });
    vi.resetModules();
    await configure(true);
    reg = await import('./agentRegistry.js');
    expect((await reg.listAgents()).some((a) => a.slug === 'dsh')).toBe(false);
  });

  it('已有同名文件夹(用户自己建的 dsh)不覆盖', async () => {
    mkdirSync(join(home, 'agents', 'dsh'), { recursive: true });
    writeFileSync(join(home, 'agents', 'dsh', 'config.toml'), 'name = "My DSH notes"\ndeveloper_instructions = "mine"\n');
    await configure(true);
    const { listAgents } = await import('./agentRegistry.js');
    const mine = (await listAgents()).find((a) => a.slug === 'dsh');
    expect(mine?.engine).toBeUndefined();
    expect(readFileSync(join(home, 'agents', 'dsh', 'config.toml'), 'utf-8')).toContain('My DSH notes');
  });

  it('不是本机形态(云端 worker)不播种', async () => {
    await configure(false);
    const { listAgents } = await import('./agentRegistry.js');
    expect((await listAgents()).some((a) => a.slug === 'dsh')).toBe(false);
    expect(existsSync(join(home, 'agents', '.seeded-dsh-v1'))).toBe(false);
  });
});
