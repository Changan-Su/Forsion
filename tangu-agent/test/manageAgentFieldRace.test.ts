/**
 * manage_agent × 用户并发改设置(09-26,审批档 KEEP 的同类窗口):
 *   旧口径 manage_agent 先 getAgent 预读 existing,再把模型**省略**的字段(model / tools / description / thinking / 轮数)
 *   从这份预读里补齐传给 saveAgent。预读到落盘之间用户在设置里收窄了工具、换了模型 → 模型这次「只改思考档」的更新把旧值写回去。
 *   守卫同理:人格主权(system_prompt 必须原样回传)与「不许自降轮数」只对预读判 —— 用户刚改的人格 / 调高的轮数,
 *   被模型按预读「原样回传」的旧 prompt、「不低于预读值」的轮数改回去。
 *   现在:覆盖已有 agent 走 patchAgent —— 在按 slug 串行化的保存里现读 cur,只改模型传了的字段,守卫对锁内的 cur 再判一次。
 *
 * 注入点(同 manageAgentApprovalRace):vi.mock 包一层 getAgent —— manage_agent 的**预读**走被包的那个,
 * patchAgent / saveAgent 内部的读走模块内原函数,恰好能把「用户的保存」插在预读与落盘之间。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hooks = vi.hoisted(() => ({ afterPreRead: null as null | (() => Promise<unknown>) }));
vi.mock('../src/agents/agentRegistry.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/agents/agentRegistry.js')>();
  return {
    ...orig,
    getAgent: async (slug: string) => {
      const r = await orig.getAgent(slug);
      const h = hooks.afterPreRead;
      hooks.afterPreRead = null;
      if (h) await h();
      return r; // 预读结果是「用户改之前」的快照
    },
  };
});

import { manageAgentProvider } from '../src/tools/builtin/manageAgent.js';
import { getAgent, saveAgent, type SaveAgentInput } from '../src/agents/agentRegistry.js';

const exec = (args: Record<string, unknown>, ctx: Record<string, unknown> = {}): Promise<string> =>
  (manageAgentProvider.tools()[0] as any).execute(args, ctx as any) as Promise<string>;

/** 用户在设置里配好的 bot(整份显式字段,模拟设置页保存)。 */
const USER_BOT: SaveAgentInput = {
  slug: 'bot', name: 'Bot', description: 'user summary', model: 'm0', tools: ['t1', 't2'], thinkingLevel: 'high',
  maxIterations: 100, approvalMode: 'full-auto', systemPrompt: 'be a bot', soul: 'calm', createdBy: 'user',
};
const userSave = (patch: Partial<SaveAgentInput>): Promise<unknown> => saveAgent({ ...USER_BOT, ...patch });

let home = '';
let prevHome: string | undefined;
beforeEach(async () => {
  prevHome = process.env.TANGU_HOME;
  home = mkdtempSync(path.join(tmpdir(), 'tangu-agent-field-race-'));
  process.env.TANGU_HOME = home;
  mkdirSync(path.join(home, 'agents'), { recursive: true });
  hooks.afterPreRead = null;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await userSave({});
});
afterEach(() => {
  vi.restoreAllMocks();
  hooks.afterPreRead = null;
  if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('manage_agent · 模型省略的字段按保存那一刻的磁盘值保留', () => {
  it('预读之后用户收窄工具、换模型、收紧审批档 → 模型只改思考档的 update 不把旧值写回去', async () => {
    hooks.afterPreRead = () => userSave({ tools: ['t1'], model: 'm2', approvalMode: 'readonly', description: 'user v2', maxIterations: 140 });
    expect(await exec({ action: 'update', slug: 'bot', name: 'Bot', system_prompt: 'be a bot', thinking_level: 'low' })).toMatch(/^Updated agent: bot/);
    expect(await getAgent('bot')).toMatchObject({
      thinkingLevel: 'low', // 模型传了的照写
      tools: ['t1'], model: 'm2', approvalMode: 'readonly', description: 'user v2', maxIterations: 140, // 用户刚改的全留下
      soul: 'calm', createdBy: 'user',
    });
  });

  it('预读之后用户改了思考档 → 模型只改 model 的 update 不把思考档改回去', async () => {
    hooks.afterPreRead = () => userSave({ thinkingLevel: 'minimal', tools: [] });
    await exec({ action: 'update', slug: 'bot', name: 'Bot', system_prompt: 'be a bot', model: 'm9' });
    expect(await getAgent('bot')).toMatchObject({ model: 'm9', thinkingLevel: 'minimal', tools: [], approvalMode: 'full-auto' });
  });

  it('create 撞已有 slug(覆盖)同样只改传了的字段:预读之后用户收窄的工具留下', async () => {
    hooks.afterPreRead = () => userSave({ tools: ['t1'], approvalMode: 'readonly' });
    expect(await exec({ action: 'create', slug: 'bot', name: 'Bot', system_prompt: 'be a bot', model: 'm9' })).toMatch(/^Overwrote existing agent: bot/);
    expect(await getAgent('bot')).toMatchObject({ model: 'm9', tools: ['t1'], approvalMode: 'readonly', thinkingLevel: 'high' });
  });
});

describe('manage_agent · 自我守卫对锁内现读的 cur 判', () => {
  const self = { subAgentDelegator: 'bot' }; // 委派方 = bot → 对 bot 而言「自己」

  it('预读之后用户改了人格 → 模型按预读原样回传的旧 system_prompt 被拒,用户的新人格留下', async () => {
    hooks.afterPreRead = () => userSave({ systemPrompt: 'be a better bot', soul: 'warm' });
    expect(await exec({ action: 'update', slug: 'bot', name: 'Bot', system_prompt: 'be a bot', model: 'm9' }, self))
      .toMatch(/^Error: you cannot change your own persona/);
    expect(await getAgent('bot')).toMatchObject({ systemPrompt: 'be a better bot', soul: 'warm', model: 'm0' });
  });

  it('预读之后用户把轮数调高 → 模型「不低于预读值」的轮数被拒(= 自降),用户的值留下', async () => {
    hooks.afterPreRead = () => userSave({ maxIterations: 150 });
    expect(await exec({ action: 'update', slug: 'bot', name: 'Bot', system_prompt: 'be a bot', max_iterations: 120 }, self))
      .toMatch(/^Error: an agent may not lower its own max_iterations \(current 150, requested 120\)/);
    expect((await getAgent('bot'))?.maxIterations).toBe(150);
  });

  it('没有并发改动时对自己的调参照常生效(守卫不误伤)', async () => {
    expect(await exec({ action: 'update', slug: 'bot', name: 'Bot', system_prompt: 'be a bot', max_iterations: 120, model: 'm9' }, self)).toMatch(/^Updated agent: bot/);
    expect(await getAgent('bot')).toMatchObject({ maxIterations: 120, model: 'm9', systemPrompt: 'be a bot', approvalMode: 'full-auto' });
  });
});
