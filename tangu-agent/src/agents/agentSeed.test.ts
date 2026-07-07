/** Coding agent 的「无视 .seeded 补齐」+「版本更新刷新提示词(保留用户 model)」回归。
 *  独立文件 → ensureAgentsReady 记忆化不被别的用例污染。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('coding agent force-ensure + 版本刷新', () => {
  let home: string;
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-agents-'));
    process.env.TANGU_HOME = home;
    mkdirSync(path.join(home, 'agents', 'coding'), { recursive: true });
    writeFileSync(path.join(home, 'agents', '.seeded'), 'old'); // 老安装:那批里没有 coding
    // 模拟旧版 coding:老提示词 + 旧 version + 用户改过的 model(须被保留)
    writeFileSync(
      path.join(home, 'agents', 'coding', 'config.toml'),
      'name = "Coding"\nversion = "1.0.0"\nmodel = "user-picked-model"\ndeveloper_instructions = """OLD_PROMPT_SENTINEL"""\n',
    );
  });
  afterAll(async () => {
    await fs.rm(home, { recursive: true, force: true });
    delete process.env.TANGU_HOME;
  });

  it('coding 存在;旧版被刷新为新提示词,用户 model 保留', async () => {
    const { listAgents } = await import('./agentRegistry.js');
    const agents = await listAgents();
    const coding = agents.find((a) => a.slug === 'coding');
    expect(coding).toBeTruthy();
    const cfg = await fs.readFile(path.join(home, 'agents', 'coding', 'config.toml'), 'utf-8');
    expect(cfg).not.toContain('OLD_PROMPT_SENTINEL'); // 提示词已刷新
    expect(cfg).toContain('esm.sh'); // 新提示词内容
    expect(cfg).toContain('1.1.0'); // 版本已升
    expect(cfg).toContain('user-picked-model'); // 用户 model 保留
  });
});
