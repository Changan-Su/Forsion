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
    expect(await exec({ action: 'create', slug: 'bot-a', ...base, max_iterations: 150 })).toMatch(/已创建 agent: bot-a/);
    expect((await getAgent('bot-a'))?.maxIterations).toBe(150);
  });

  it('update 省略 max_iterations 保留原值(不再变相清空成默认 90)', async () => {
    await exec({ action: 'create', slug: 'bot-a', ...base, max_iterations: 150 });
    expect(await exec({ action: 'update', slug: 'bot-a', ...base, model: 'm1' })).toMatch(/已更新 agent: bot-a/);
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
    expect(await exec({ action: 'update', slug: 'bot-a', ...base, max_iterations: 160 })).toMatch(/已更新/);
    expect((await getAgent('bot-a'))?.maxIterations).toBe(160);
    expect(await exec({ action: 'update', slug: 'bot-b', name: 'Bot B', system_prompt: 'other', max_iterations: AGENT_MAX_ITERATIONS_MIN })).toMatch(/已更新/);
    expect((await getAgent('bot-b'))?.maxIterations).toBe(AGENT_MAX_ITERATIONS_MIN);
  });
});
