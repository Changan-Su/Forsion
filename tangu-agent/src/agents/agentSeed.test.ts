/** Coding agent 的「无视 .seeded 补齐」+「版本更新刷新提示词(保留用户 model)」回归。
 *  独立文件 → ensureAgentsReady 记忆化不被别的用例污染。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CODING_AGENT_VERSION, CODING_SYSTEM_PROMPT } from './codingPrompt.js';

describe('coding agent force-ensure + 版本刷新', () => {
  let home: string;
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-agents-'));
    process.env.TANGU_HOME = home;
    mkdirSync(path.join(home, 'agents', 'coding'), { recursive: true });
    writeFileSync(path.join(home, 'agents', '.seeded'), 'old'); // 老安装:那批里没有 coding
    // 模拟旧版 coding:老提示词 + 旧 version + 用户调过的模型、思考与权限(须被保留)
    writeFileSync(
      path.join(home, 'agents', 'coding', 'config.toml'),
      'name = "Coding"\nversion = "1.1.0"\nmodel = "user-picked-model"\nmodel_reasoning_effort = "high"\napproval_mode = "readonly"\nmax_iterations = 37\ntools = ["user-tool"]\navatar = "Library/avatar.png"\nshare_default_memory = true\ncloud_sync = true\nactivity_access = true\ntools_mode = "deny"\ntools_list = ["run_bash"]\napps = ["genesis"]\nlibrary_order = ["guide.md"]\ndeveloper_instructions = """OLD_PROMPT_SENTINEL"""\n',
    );
  });
  afterAll(async () => {
    await fs.rm(home, { recursive: true, force: true });
    delete process.env.TANGU_HOME;
  });

  it('coding 存在;旧版被刷新为新提示词,用户模型、思考与权限保留', async () => {
    const { listAgents } = await import('./agentRegistry.js');
    const agents = await listAgents();
    const coding = agents.find((a) => a.slug === 'coding');
    expect(coding).toBeTruthy();
    const cfg = await fs.readFile(path.join(home, 'agents', 'coding', 'config.toml'), 'utf-8');
    expect(cfg).not.toContain('OLD_PROMPT_SENTINEL'); // 提示词已刷新
    expect(cfg).toContain('esm.sh'); // 新提示词内容
    expect(coding?.version).toBe(CODING_AGENT_VERSION);
    expect(coding?.systemPrompt).toBe(CODING_SYSTEM_PROMPT);
    expect(cfg).toContain('user-picked-model'); // 用户 model 保留
    expect(coding?.thinkingLevel).toBe('high');
    expect(coding?.approvalMode).toBe('readonly');
    expect(coding?.maxIterations).toBe(37);
    expect(coding?.tools).toEqual(['user-tool']);
    expect(coding?.avatar).toBe('Library/avatar.png');
    expect(coding?.shareDefaultMemory).toBe(true);
    expect(coding?.cloudSync).toBe(true);
    expect(coding?.activityAccess).toBe(true);
    expect(coding?.toolsMode).toBe('deny');
    expect(coding?.toolsList).toEqual(['run_bash']);
    expect(coding?.apps).toEqual(['genesis']);
    expect(coding?.libraryOrder).toEqual(['guide.md']);
  });
});
