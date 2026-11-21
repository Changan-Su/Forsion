/** Coding agent 的「无视 .seeded 补齐」+ 升版本不盖用户改过的指令(11-20 起走内置基线,见 builtinBaseline.ts)回归。
 *  以前这里断言「旧版提示词被刷新」—— 那正是会把用户在配置页改过的指令整份盖掉的行为。
 *  独立文件 → ensureAgentsReady 记忆化不被别的用例污染。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CODING_AGENT_VERSION, CODING_SYSTEM_PROMPT } from './codingPrompt.js';

describe('coding agent force-ensure + 升版本保留用户指令', () => {
  let home: string;
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-agents-'));
    process.env.TANGU_HOME = home;
    mkdirSync(path.join(home, 'agents', 'coding'), { recursive: true });
    writeFileSync(path.join(home, 'agents', '.seeded'), 'old'); // 老安装:那批里没有 coding
    // 模拟旧版 coding:没有基线、指令不是任何一版出厂(= 用户写的)+ 旧 version + 用户调过的模型、思考与权限(都须保留)
    writeFileSync(
      path.join(home, 'agents', 'coding', 'config.toml'),
      'name = "Coding"\nversion = "1.1.0"\nmodel = "user-picked-model"\nmodel_reasoning_effort = "high"\napproval_mode = "readonly"\nmax_iterations = 37\ntools = ["user-tool"]\navatar = "Library/avatar.png"\nshare_default_memory = true\ncloud_sync = true\nactivity_access = true\ntools_mode = "deny"\ntools_list = ["run_bash"]\napps = ["genesis"]\nlibrary_order = ["guide.md"]\ndeveloper_instructions = """OLD_PROMPT_SENTINEL"""\n',
    );
  });
  afterAll(async () => {
    await fs.rm(home, { recursive: true, force: true });
    delete process.env.TANGU_HOME;
  });

  it('coding 存在;没有基线的旧版自定义指令原样保留并在配置页提示,用户模型、思考与权限保留', async () => {
    const { listAgents, getBuiltinUpdate } = await import('./agentRegistry.js');
    const agents = await listAgents();
    const coding = agents.find((a) => a.slug === 'coding');
    expect(coding).toBeTruthy();
    const cfg = await fs.readFile(path.join(home, 'agents', 'coding', 'config.toml'), 'utf-8');
    expect(cfg).toContain('OLD_PROMPT_SENTINEL'); // 没盖掉:没有基线时和新默认不一样就当改过
    expect(coding?.systemPrompt).toBe('OLD_PROMPT_SENTINEL');
    expect(coding?.version).toBe('1.1.0'); // 版本也不升:config.toml 会同步,升了版本的旧版设备会整份覆盖
    const update = await getBuiltinUpdate('coding');
    expect(update?.fields.map((f) => [f.field, f.oldDefault, f.newDefault === CODING_SYSTEM_PROMPT])).toEqual([['systemPrompt', null, true]]);
    expect(update?.toVersion).toBe(CODING_AGENT_VERSION);
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
  }, 90_000);
});
