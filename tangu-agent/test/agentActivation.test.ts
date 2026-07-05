/**
 * Normal Agent 激活解析单测——重点覆盖**云端 worker 路径**:worker 本地 ~/.tangu/agents 为空,
 * 人格必须经 brain.agents 兜底水合(否则云端自定义 agent 静默失效)。此前仅 cloudHydration.test 测了纯
 * parseAgentConfig,这条 resolve+merge 分支(agentLoop 内联时)零直测。
 */
import { describe, it, expect } from 'vitest';
import { applyAgentActivation, type AgentsBrainLike } from '../src/services/agentActivation.js';
import type { NormalAgentDef } from '../src/agents/agentRegistry.js';

const NONE = async (): Promise<NormalAgentDef | null> => null;
function def(p: Partial<NormalAgentDef>): NormalAgentDef {
  return {
    slug: 'researcher', name: 'Researcher', description: '', model: '', tools: [],
    thinkingLevel: '', maxIterations: null, approvalMode: '', createdBy: 'user', createdAt: '',
    systemPrompt: 'be rigorous', ...p,
  };
}

describe('applyAgentActivation', () => {
  it('无 agentSlug → 默认作用域,不读任何源', async () => {
    const cfg: any = {};
    const r = await applyAgentActivation(cfg, 'u1', NONE, null);
    expect(r).toEqual({ activeAgentSlug: 'xyra', memScopeSlug: 'xyra' });
    expect(cfg.systemPrompt).toBeUndefined();
  });

  it('云端 worker:本地 FS 未命中 → 经 brain.agents 水合人格(关键路径)', async () => {
    const brain: AgentsBrainLike = { getAgent: async (_u, slug) => def({ slug, soul: '# soul' }) };
    const cfg: any = { agentSlug: 'researcher' };
    const r = await applyAgentActivation(cfg, 'u1', NONE, brain); // localGet 恒 null = worker
    expect(r.activeAgentSlug).toBe('researcher');
    expect(r.memScopeSlug).toBe('researcher'); // 专属记忆
    expect(cfg.systemPrompt).toBe('be rigorous'); // 人格已并入
    expect(cfg.soul).toBe('# soul');
  });

  it('本地命中优先,不调 brain', async () => {
    let brainCalled = false;
    const brain: AgentsBrainLike = { getAgent: async () => { brainCalled = true; return null; } };
    const local = async (slug: string): Promise<NormalAgentDef> => def({ slug, systemPrompt: 'local persona' });
    const cfg: any = { agentSlug: 'researcher' };
    await applyAgentActivation(cfg, 'u1', local, brain);
    expect(brainCalled).toBe(false);
    expect(cfg.systemPrompt).toBe('local persona');
  });

  it('会话已显式设的字段不被 def 覆盖(会话值优先)', async () => {
    const brain: AgentsBrainLike = { getAgent: async (_u, slug) => def({ slug, systemPrompt: 'def-sp', thinkingLevel: 'high', maxIterations: 50 }) };
    const cfg: any = { agentSlug: 'researcher', systemPrompt: 'session-sp', maxIterations: 7 };
    await applyAgentActivation(cfg, 'u1', NONE, brain);
    expect(cfg.systemPrompt).toBe('session-sp'); // 不被覆盖
    expect(cfg.maxIterations).toBe(7);           // 不被覆盖
    expect(cfg.thinkingLevel).toBe('high');      // 会话未设 → 取 def
  });

  it('shareDefaultMemory 的 agent → 记忆作用域落 xyra(云端命中正确记忆桶)', async () => {
    const brain: AgentsBrainLike = { getAgent: async (_u, slug) => def({ slug, shareDefaultMemory: true }) };
    const cfg: any = { agentSlug: 'cat' };
    const r = await applyAgentActivation(cfg, 'u1', NONE, brain);
    expect(r.activeAgentSlug).toBe('cat');
    expect(r.memScopeSlug).toBe('xyra');
  });

  it('两路都未命中 → 默认,不抛', async () => {
    const cfg: any = { agentSlug: 'ghost' };
    const r = await applyAgentActivation(cfg, 'u1', NONE, { getAgent: NONE as any });
    expect(r).toEqual({ activeAgentSlug: 'xyra', memScopeSlug: 'xyra' });
  });

  it('brain 抛错 → 软失败回落默认,不阻断', async () => {
    const brain: AgentsBrainLike = { getAgent: async () => { throw new Error('cloud 500'); } };
    const cfg: any = { agentSlug: 'researcher' };
    const r = await applyAgentActivation(cfg, 'u1', NONE, brain);
    expect(r.activeAgentSlug).toBe('xyra');
  });
});
