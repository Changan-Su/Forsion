import { describe, it, expect, vi, afterEach } from 'vitest';
import { applyAgentActivation } from './agentActivation.js';
import { AGENT_MAX_ITERATIONS_MIN, type NormalAgentDef } from '../agents/agentRegistry.js';

const defWith = (maxIterations: number | null): NormalAgentDef => ({
  slug: 'xyra', name: 'Xyra', version: '1.0.0', description: '', model: '', tools: [], thinkingLevel: '',
  maxIterations, approvalMode: '', createdBy: 'user', createdAt: '', systemPrompt: 'be helpful', soul: '', libraryOrder: [],
} as unknown as NormalAgentDef);

// 09-13 用户导出:Agent 定义里 max_iterations=3 让每回合两次工具调用就收尾,用户只看到「空话空转」。
describe('applyAgentActivation · Agent 级 maxIterations 下限', () => {
  afterEach(() => vi.restoreAllMocks());

  it('低于下限的 Agent 定义值不并入,回落默认并告警点名值', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg: any = { agentSlug: 'xyra' };
    await applyAgentActivation(cfg, 'u1', async () => defWith(3));
    expect(cfg.maxIterations).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('max_iterations=3');
  });

  it('达到下限的 Agent 定义值照常并入', async () => {
    const cfg: any = { agentSlug: 'xyra' };
    await applyAgentActivation(cfg, 'u1', async () => defWith(AGENT_MAX_ITERATIONS_MIN));
    expect(cfg.maxIterations).toBe(AGENT_MAX_ITERATIONS_MIN);
  });

  it('会话级 /loop 值优先于 Agent 定义,且不套下限(显式意图)', async () => {
    const cfg: any = { agentSlug: 'xyra', maxIterations: 2 };
    await applyAgentActivation(cfg, 'u1', async () => defWith(50));
    expect(cfg.maxIterations).toBe(2);
  });
});
