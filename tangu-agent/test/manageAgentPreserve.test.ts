/**
 * H2 manage_agent(审批档重设计 2026-09-25 §3.4):
 *   ① schema 不再暴露 approval_mode;模型照旧传 → 固定英文报错,**什么都不写**(审批档只归用户在设置里改);
 *   ② update(以及覆盖已存在 slug 的 create)省略的字段保留原值 —— buildAgentDef 对 description / model / tools /
 *      thinkingLevel / approvalMode 的省略项写空,而 approvalMode 写空 = 激活时回落 auto-edit:
 *      用户设成只读的 Agent,被模型改一次模型就悄悄放宽成自动编辑。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { manageAgentProvider } from '../src/tools/builtin/manageAgent.js';
import { getAgent, saveAgent } from '../src/agents/agentRegistry.js';
import { agentsDir } from '../src/core/tanguHome.js';

const tool = (): any => manageAgentProvider.tools()[0];
const exec = (args: Record<string, unknown>): Promise<string> => tool().execute(args, {} as any) as Promise<string>;
const APPROVAL_ERR = 'Error: approval_mode can only be changed by the user in Settings. Nothing was saved; call again without approval_mode.';

let home = '';
let prevHome: string | undefined;
beforeEach(async () => {
  prevHome = process.env.TANGU_HOME;
  home = mkdtempSync(path.join(tmpdir(), 'tangu-h2-'));
  process.env.TANGU_HOME = home;
  mkdirSync(agentsDir(), { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // 用户在设置里配好的 Agent:只读、高思考、指定模型 / 工具 / 描述
  await saveAgent({
    slug: 'bot', name: 'Bot', description: 'user-written summary', model: 'm0', tools: ['t1', 't2'],
    thinkingLevel: 'high', approvalMode: 'readonly', maxIterations: 120, systemPrompt: 'be a bot', createdBy: 'user',
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const cfgBytes = (slug: string): string => readFileSync(path.join(agentsDir(), slug, 'config.toml'), 'utf8');

describe('manage_agent · approval_mode 只归用户', () => {
  it('schema 里没有 approval_mode', () => {
    expect(Object.keys(tool().definition.function.parameters.properties)).not.toContain('approval_mode');
  });

  it('update 传 approval_mode → 固定报错,config.toml 一个字节都不变', async () => {
    const before = cfgBytes('bot');
    expect(await exec({ action: 'update', slug: 'bot', name: 'Bot', system_prompt: 'be a bot', approval_mode: 'full-auto', model: 'm9' })).toBe(APPROVAL_ERR);
    expect(cfgBytes('bot')).toBe(before);
    expect((await getAgent('bot'))?.approvalMode).toBe('readonly');
  });

  it('create 传 approval_mode → 报错,不建出 agent', async () => {
    expect(await exec({ action: 'create', slug: 'fresh', name: 'Fresh', system_prompt: 'p', approval_mode: 'full-auto' })).toBe(APPROVAL_ERR);
    expect(existsSync(path.join(agentsDir(), 'fresh'))).toBe(false);
  });
});

describe('manage_agent · 省略 ≠ 清空', () => {
  it('update 只改 model:审批档 / 思考档 / 工具 / 描述 / 轮数全部保留', async () => {
    expect(await exec({ action: 'update', slug: 'bot', name: 'Bot', system_prompt: 'be a bot', model: 'm1' })).toMatch(/bot/);
    const def = await getAgent('bot');
    expect(def).toMatchObject({
      model: 'm1', approvalMode: 'readonly', thinkingLevel: 'high', tools: ['t1', 't2'],
      description: 'user-written summary', maxIterations: 120,
    });
  });

  it('update 只改思考档:model 不被清空', async () => {
    await exec({ action: 'update', slug: 'bot', name: 'Bot', system_prompt: 'be a bot', thinking_level: 'low' });
    expect(await getAgent('bot')).toMatchObject({ model: 'm0', thinkingLevel: 'low', approvalMode: 'readonly' });
  });

  it('显式传值照常生效(含显式清空 model / tools)', async () => {
    await exec({ action: 'update', slug: 'bot', name: 'Bot', system_prompt: 'be a bot', model: '', tools: [], description: 'new' });
    expect(await getAgent('bot')).toMatchObject({ model: '', tools: [], description: 'new', approvalMode: 'readonly' });
  });

  it('create 撞已存在的 slug(saveAgent 覆盖)同样不许把审批档洗空', async () => {
    await exec({ action: 'create', slug: 'bot', name: 'Bot', system_prompt: 'be a bot' });
    expect((await getAgent('bot'))?.approvalMode).toBe('readonly');
  });

  it('全新 create:没有旧值可保留 → 审批档为空(跟随会话 / 缺省)', async () => {
    await exec({ action: 'create', slug: 'nb', name: 'NB', system_prompt: 'p', model: 'mx' });
    expect(await getAgent('nb')).toMatchObject({ approvalMode: '', model: 'mx', thinkingLevel: '' });
  });
});
