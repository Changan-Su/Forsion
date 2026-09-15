/**
 * manage_agent 的「不能删/改自己」守卫必须连**委派方**一起保护(Codex 09-15 复审 #1)。
 * 具名子代理 B 在自己的 ALS 身份里跑,父代理 A 对守卫来说就是「别人」:A 授 B `manage_agent`,
 * B 就能删掉 A / 改写 A 的人格 —— A 借子代理拿到了自己没有的能力,违反「子代理不比父代理更强」。
 * 修法:ctx.subAgentDelegator(subAgent.ts 从父 ctx 填)进守卫;本块只 mock 注册表与 ALS 身份。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const reg = vi.hoisted(() => ({
  deleteAgent: vi.fn(async () => true),
  saveAgent: vi.fn(async (d: any) => ({ slug: d.slug, name: d.name })),
  getAgent: vi.fn(async (slug: string) => (slug === 'parenty' || slug === 'subby' || slug === 'other'
    ? { slug, name: slug, systemPrompt: 'ORIGINAL', soul: '', maxIterations: 20 } : null)),
  listAgents: vi.fn(async () => []),
}));
vi.mock('../../agents/agentRegistry.js', async (orig) => ({
  ...(await orig<typeof import('../../agents/agentRegistry.js')>()),
  ...reg,
}));
// 执行身份 = subby(具名子代理在自己的 ALS 里跑)。
vi.mock('../../seams/runContext.js', () => ({ currentAgentSlug: () => 'subby', currentDisplayAgentSlug: () => '' }));

import { manageAgentProvider } from './manageAgent.js';

const tool = manageAgentProvider.tools()[0];
const run = (args: any, ctx: any) => tool.execute(args, ctx);
const subCtx = { subAgentDepth: 1, subAgentDelegator: 'parenty' } as any;

beforeEach(() => { reg.deleteAgent.mockClear(); reg.saveAgent.mockClear(); });

describe('manage_agent 守卫连委派方一起保护', () => {
  it('子代理 subby 删委派方 parenty → 拒,注册表未被动', async () => {
    const out = await run({ action: 'delete', slug: 'parenty' }, subCtx);
    expect(String(out)).toMatch(/^Error/);
    expect(reg.deleteAgent).not.toHaveBeenCalled();
  });

  it('子代理 subby 改写委派方 parenty 的人格 → 拒', async () => {
    const out = await run({ action: 'update', slug: 'parenty', name: 'parenty', system_prompt: 'HIJACKED' }, subCtx);
    expect(String(out)).toMatch(/^Error/);
    expect(reg.saveAgent).not.toHaveBeenCalled();
  });

  it('子代理 subby 给委派方 parenty 调低 max_iterations → 拒(与对自己的规则同口径)', async () => {
    const out = await run({ action: 'update', slug: 'parenty', name: 'parenty', system_prompt: 'ORIGINAL', max_iterations: 12 }, subCtx);
    expect(String(out)).toMatch(/^Error/);
    expect(reg.saveAgent).not.toHaveBeenCalled();
  });

  it('执行身份自己(subby)照旧受保护 —— 加委派方没有削弱原守卫', async () => {
    const out = await run({ action: 'delete', slug: 'subby' }, subCtx);
    expect(String(out)).toMatch(/^Error/);
    expect(reg.deleteAgent).not.toHaveBeenCalled();
  });

  it('负对照:第三方 other 不受保护(守卫只挡自己 + 委派方,不是整体禁用)', async () => {
    const out = await run({ action: 'delete', slug: 'other' }, subCtx);
    expect(String(out)).not.toMatch(/^Error/);
    expect(reg.deleteAgent).toHaveBeenCalledWith('other');
  });

  it('负对照:深度 0(没有 subAgentDelegator)时 parenty 就是「别人」,老行为零变化', async () => {
    const out = await run({ action: 'delete', slug: 'parenty' }, { subAgentDepth: 0 } as any);
    expect(String(out)).not.toMatch(/^Error/);
    expect(reg.deleteAgent).toHaveBeenCalledWith('parenty');
  });
});
