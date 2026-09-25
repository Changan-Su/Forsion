/**
 * manage_agent × 用户并发收紧审批档(Codex 09-25 P1):
 *   旧口径 manage_agent 先 getAgent 读 existing,再把 existing.approvalMode 传给 saveAgent;saveAgent 虽然重读,
 *   仍用传入值覆盖。两次读取之间用户在设置里把目标 Agent 从 full-auto 收紧成 readonly → 模型这次更新把 full-auto 写回去。
 *   现在:manage_agent 传 KEEP_APPROVAL_MODE,saveAgent 在按 slug 串行化的保存里现读现留;先读到了却在保存前被删 → 报错不新建;
 *   先读到不存在(按新建批的)却在保存前冒出同名的 → 报错不接管(09-25 #5)。
 *
 * 注入点:vi.mock 包一层 getAgent —— manage_agent 的**预读**走被包的那个,saveAgent 内部的读走模块内原函数,
 * 恰好能把「用户的保存」插在预读与落盘之间。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, existsSync, promises as fsp } from 'node:fs';
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
import { getAgent, saveAgent, deleteAgent, KEEP_APPROVAL_MODE } from '../src/agents/agentRegistry.js';
import { agentsDir } from '../src/core/tanguHome.js';

const exec = (args: Record<string, unknown>): Promise<string> =>
  (manageAgentProvider.tools()[0] as any).execute(args, {} as any) as Promise<string>;
const userSave = (approvalMode: 'readonly' | 'full-auto'): Promise<unknown> =>
  saveAgent({ slug: 'bot', name: 'Bot', systemPrompt: 'be a bot', approvalMode, createdBy: 'user' });

let home = '';
let prevHome: string | undefined;
beforeEach(() => {
  prevHome = process.env.TANGU_HOME;
  home = mkdtempSync(path.join(tmpdir(), 'tangu-agent-race-'));
  process.env.TANGU_HOME = home;
  mkdirSync(agentsDir(), { recursive: true });
  hooks.afterPreRead = null;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  hooks.afterPreRead = null;
  if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('manage_agent · 审批档按保存那一刻的磁盘值保留', () => {
  it('预读之后用户把 full-auto 收紧成 readonly → 模型的 update 不把 full-auto 写回去', async () => {
    await userSave('full-auto');
    hooks.afterPreRead = () => userSave('readonly');
    expect(await exec({ action: 'update', slug: 'bot', name: 'Bot', system_prompt: 'be a bot', model: 'm9' })).toMatch(/^Updated agent: bot/);
    expect(await getAgent('bot')).toMatchObject({ approvalMode: 'readonly', model: 'm9' });
  });

  it('预读时还不存在(按「新建」批的)、保存前冒出同名 agent → 报错不落盘,不把指令写进现成的(可能 full-auto)Agent', async () => {
    // 09-25 #5:旧口径 KEEP 会接管保存那一刻的档 —— 卡上写的是「new agent · 跟随会话」,落盘却进了 full-auto 的现成 Agent。
    for (const tier of ['full-auto', 'readonly'] as const) {
      await deleteAgent('bot');
      hooks.afterPreRead = () => userSave(tier);
      expect(await exec({ action: 'create', slug: 'bot', name: 'Bot', system_prompt: 'be evil', model: 'm9' })).toMatch(/^Error: agent already exists: bot/);
      const d = await getAgent('bot');
      expect(d).toMatchObject({ approvalMode: tier, systemPrompt: 'be a bot', createdBy: 'user' }); // 用户那份原封不动
      expect(d?.model || '').toBe('');
    }
    // 重来一次(此时预读看得见它)= 覆盖已有 agent,审批档照旧保留 —— 审批卡在这一次会如实写「overwrites existing agent」
    expect(await exec({ action: 'create', slug: 'bot', name: 'Bot', system_prompt: 'be a bot', model: 'm9' })).toMatch(/^Overwrote existing agent: bot/);
    expect(await getAgent('bot')).toMatchObject({ approvalMode: 'readonly', model: 'm9' });
  });

  it('预读时存在、保存前被用户删了 → 报错,不悄悄新建一个空档(跟随会话)的', async () => {
    await userSave('readonly');
    hooks.afterPreRead = () => deleteAgent('bot');
    expect(await exec({ action: 'update', slug: 'bot', name: 'Bot', system_prompt: 'be a bot', model: 'm9' })).toMatch(/^Error: agent not found: bot/);
    expect(existsSync(path.join(agentsDir(), 'bot', 'config.toml'))).toBe(false);
  });
});

describe('saveAgent · 同 slug 串行化', () => {
  it('用户收紧的保存先到、模型那次(KEEP)后到且与之交错 → 读到的是收紧后的档', async () => {
    await userSave('full-auto');
    const cfg = path.join(agentsDir(), 'bot', 'config.toml');
    const realRead = fsp.readFile.bind(fsp) as (...a: any[]) => Promise<any>;
    const realWrite = fsp.writeFile.bind(fsp) as (...a: any[]) => Promise<void>;
    let reads = 0;
    let secondRead!: () => void;
    const sawSecondRead = new Promise<void>((r) => { secondRead = r; });
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    vi.spyOn(fsp, 'readFile').mockImplementation(((...a: any[]) => {
      if (a[0] === cfg && ++reads === 2) secondRead();
      return realRead(...a);
    }) as any);
    vi.spyOn(fsp, 'writeFile').mockImplementation((async (...a: any[]) => {
      if (a[0] === cfg) {
        // 用户那次:等模型那次读过配置再写(无锁时模型读到的就是旧的 full-auto);有锁时模型读不到,150ms 后照写。
        if (String(a[1]).includes('approval_mode = "readonly"')) await Promise.race([sawSecondRead, sleep(150)]);
        else await sleep(30); // 模型那次晚一点落盘,让「后写覆盖先写」成形
      }
      return realWrite(...a);
    }) as any);
    const user = userSave('readonly');
    const model = saveAgent({ slug: 'bot', name: 'Bot', systemPrompt: 'be a bot', model: 'm9', approvalMode: KEEP_APPROVAL_MODE });
    await Promise.all([user, model]);
    vi.mocked(fsp.readFile).mockRestore();
    vi.mocked(fsp.writeFile).mockRestore();
    expect(await getAgent('bot')).toMatchObject({ approvalMode: 'readonly', model: 'm9' });
  });

  it('KEEP 对不存在的 slug = 空档(与全新 create 同口径);一次失败不卡住后续保存', async () => {
    const d = await saveAgent({ slug: 'fresh', name: 'Fresh', systemPrompt: 'p', approvalMode: KEEP_APPROVAL_MODE });
    expect(d.approvalMode).toBe('');
    await expect(saveAgent({ slug: 'ghost', name: 'Ghost', systemPrompt: 'p', mustExist: true })).rejects.toThrow(/agent not found: ghost/);
    await expect(saveAgent({ slug: 'fresh', name: 'Fresh', systemPrompt: 'p2', mustNotExist: true })).rejects.toThrow(/agent already exists: fresh/);
    expect((await getAgent('fresh'))?.systemPrompt).toBe('p');
    await expect(saveAgent({ slug: 'ghost', name: 'Ghost', systemPrompt: 'p' })).resolves.toMatchObject({ slug: 'ghost' });
  });
});
