import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { manageAgentProvider } from './manageAgent.js';
import { getAgent, AGENT_MAX_ITERATIONS_MIN } from '../../agents/agentRegistry.js';
import { agentsDir } from '../../core/tanguHome.js';
import { enterRunContext } from '../../seams/runContext.js';

// Codex 09-13 评审 #1 / 自降守卫:模型能改自己的运行参数,但轮数上限只许持平或调高;省略字段也不许变相清空。
describe('manage_agent · max_iterations 守卫', () => {
  let home = '';
  let prevHome: string | undefined;
  const exec = (args: Record<string, unknown>): Promise<string> =>
    (manageAgentProvider.tools()[0] as any).execute(args, {} as any) as Promise<string>;
  const base = { name: 'Bot A', system_prompt: 'be a bot' };

  beforeEach(() => {
    prevHome = process.env.TANGU_HOME;
    home = mkdtempSync(path.join(tmpdir(), 'tangu-manage-agent-'));
    process.env.TANGU_HOME = home;
    mkdirSync(agentsDir(), { recursive: true });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('create 带 150 → 存 150;低于下限直接拒', async () => {
    expect(await exec({ action: 'create', slug: 'bot-a', ...base, max_iterations: 3 })).toMatch(/^Error: max_iterations must be at least/);
    expect(await exec({ action: 'create', slug: 'bot-a', ...base, max_iterations: 150 })).toMatch(/^Created agent: bot-a \(Bot A\)\./);
    expect((await getAgent('bot-a'))?.maxIterations).toBe(150);
  });

  it('update 省略 max_iterations 保留原值(不再变相清空成默认 90)', async () => {
    await exec({ action: 'create', slug: 'bot-a', ...base, max_iterations: 150 });
    expect(await exec({ action: 'update', slug: 'bot-a', ...base, model: 'm1' })).toMatch(/^Updated agent: bot-a \(Bot A\)\./);
    const def = await getAgent('bot-a');
    expect(def?.model).toBe('m1');
    expect(def?.maxIterations).toBe(150);
  });

  it('对自己:只许持平或调高,调低返回 Error;别的 agent 可以调低(≥ 下限)', async () => {
    await exec({ action: 'create', slug: 'bot-a', ...base, max_iterations: 150 });
    await exec({ action: 'create', slug: 'bot-b', name: 'Bot B', system_prompt: 'other', max_iterations: 150 });
    enterRunContext('u1', 'r1', 'bot-a', 'bot-a');
    expect(await exec({ action: 'update', slug: 'bot-a', ...base, max_iterations: 20 })).toMatch(/^Error: an agent may not lower its own max_iterations/);
    expect((await getAgent('bot-a'))?.maxIterations).toBe(150);
    expect(await exec({ action: 'update', slug: 'bot-a', ...base, max_iterations: 160 })).toMatch(/^Updated agent: bot-a/);
    expect((await getAgent('bot-a'))?.maxIterations).toBe(160);
    expect(await exec({ action: 'update', slug: 'bot-b', name: 'Bot B', system_prompt: 'other', max_iterations: AGENT_MAX_ITERATIONS_MIN })).toMatch(/^Updated agent: bot-b/);
    expect((await getAgent('bot-b'))?.maxIterations).toBe(AGENT_MAX_ITERATIONS_MIN);
  });
});

// 回执是模型读的:整句英文(不只句首)、且 create 撞上已有 slug 时点破「覆盖」——
// 纯中文名不带 slug → slugify 成 'agent',连建两个时第二个悄悄替换第一个(完全放行档不弹卡,模型只看得到回执)。
describe('manage_agent · 成功回执', () => {
  let home = '';
  let prevHome: string | undefined;
  const exec = (args: Record<string, unknown>): Promise<string> =>
    (manageAgentProvider.tools()[0] as any).execute(args, {} as any) as Promise<string>;
  const HAN = /[一-鿿]/;

  beforeEach(() => {
    prevHome = process.env.TANGU_HOME;
    home = mkdtempSync(path.join(tmpdir(), 'tangu-manage-agent-receipt-'));
    process.env.TANGU_HOME = home;
    mkdirSync(agentsDir(), { recursive: true });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('ASCII 名的 create / update 回执整句不含汉字', async () => {
    const created = await exec({ action: 'create', slug: 'bot-r', name: 'Bot R', system_prompt: 'p' });
    expect(created).toMatch(/^Created agent: bot-r \(Bot R\)\. The user can select it/);
    expect(created).not.toMatch(HAN);
    const updated = await exec({ action: 'update', slug: 'bot-r', name: 'Bot R', system_prompt: 'p', model: 'm1' });
    expect(updated).toMatch(/^Updated agent: bot-r \(Bot R\)\. The user can select it/);
    expect(updated).not.toMatch(HAN);
  });

  it('纯中文名不带 slug 连建两个:第二个回执是 Overwrote(不是 Created),省略的 soul 沿用第一个', async () => {
    const first = await exec({ action: 'create', name: '代码审查员', system_prompt: 'review code', soul: 'strict' });
    expect(first).toMatch(/^Created agent: agent \(代码审查员\)\./);
    expect(first).not.toMatch(/replaced/);
    const second = await exec({ action: 'create', name: '写作助手', system_prompt: 'help write' });
    expect(second).toMatch(/^Overwrote existing agent: agent \(写作助手\)\. It replaced the agent that already had this slug; fields you omitted were kept from that agent\. To add a separate agent, pass a different slug\./);
    const stored = await getAgent('agent');
    expect(stored?.name).toBe('写作助手');
    expect(stored?.systemPrompt).toBe('help write');
    expect(stored?.soul).toBe('strict'); // 回执说的「省略项沿用」属实
    // 对照:显式给不同 slug → 各建各的,回执是 Created
    expect(await exec({ action: 'create', slug: 'writer', name: '写作助手', system_prompt: 'help write' })).toMatch(/^Created agent: writer \(写作助手\)\./);
  });
});
