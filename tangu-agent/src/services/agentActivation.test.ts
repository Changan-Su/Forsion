import { describe, it, expect, vi, afterEach } from 'vitest';
import { agentIdentitySection, applyAgentActivation } from './agentActivation.js';
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

// 09-18 用户实报「改了 Agent 名字,它没反应过来」:名字 / 简介过去从不进系统提示词,模型只认人格正文里写死的旧名。
describe('applyAgentActivation · 当前名字 / 简介进身份段', () => {
  it('返回定义里的当前名字与简介(每次 run 现读,改名下一轮即生效)', async () => {
    const def = { ...defWith(null), name: ' Orion ', description: 'Plans night-sky trips', systemPrompt: 'You are Nova.' } as NormalAgentDef;
    const r = await applyAgentActivation({ agentSlug: 'xyra' }, 'u1', async () => def);
    expect(r.profile).toEqual({ name: 'Orion', description: 'Plans night-sky trips' });
  });

  it('未选 agent / 定义缺失 → 不带身份段', async () => {
    expect((await applyAgentActivation({}, 'u1', async () => defWith(null))).profile).toBeUndefined();
    expect((await applyAgentActivation({ agentSlug: 'xyra' }, 'u1', async () => null)).profile).toBeUndefined();
  });

  it('身份段点名当前名字并声明压过正文里的旧名;简介为空不出那一行', () => {
    const full = agentIdentitySection({ name: 'Orion', description: 'Plans night-sky trips' });
    expect(full).toContain('- Name: Orion');
    expect(full).toContain('- Description (shown to the user): Plans night-sky trips');
    expect(full).toMatch(/different name, treat that name as outdated/);
    expect(agentIdentitySection({ name: 'Orion', description: '' })).not.toContain('Description');
  });
});
