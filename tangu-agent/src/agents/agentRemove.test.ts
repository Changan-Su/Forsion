/** removeAgentKeepFiles:从名册移除但文件整目录挪进 agents/.removed/(名册不再加载);默认 Agent 拒删、文件原样不动。
 *  独立文件(自己的 TANGU_HOME)→ ensureAgentsReady 记忆化不被别的用例污染。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('removeAgentKeepFiles', () => {
  let home: string;
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-remove-'));
    process.env.TANGU_HOME = home;
  });
  afterAll(async () => {
    await fs.rm(home, { recursive: true, force: true });
    delete process.env.TANGU_HOME;
  });

  it('挪进 .removed/<slug>-<时间戳>/(记忆与 Library 都在),名册不再列出;同名再建再删不撞', async () => {
    const { saveAgent, listAgents, removeAgentKeepFiles } = await import('./agentRegistry.js');
    await saveAgent({ slug: 'helper', name: 'Helper', systemPrompt: 'help', description: 'd' });
    writeFileSync(path.join(home, 'agents', 'helper', 'MEMORY.md'), '- remembers\n');
    const first = await removeAgentKeepFiles('helper');
    expect(first.ok).toBe(true);
    expect(path.dirname(first.keptAt!)).toBe(path.join(home, 'agents', '.removed'));
    expect(readFileSync(path.join(first.keptAt!, 'MEMORY.md'), 'utf8')).toBe('- remembers\n');
    expect(existsSync(path.join(home, 'agents', 'helper'))).toBe(false);
    expect((await listAgents()).map((a) => a.slug)).not.toContain('helper');

    await saveAgent({ slug: 'helper', name: 'Helper 2', systemPrompt: 'help', description: 'd' });
    await new Promise((r) => setTimeout(r, 5)); // 时间戳到毫秒
    const second = await removeAgentKeepFiles('helper');
    expect(second.ok && second.keptAt !== first.keptAt && existsSync(second.keptAt!) && existsSync(first.keptAt!)).toBe(true);
  });

  it('遗留扁平 <slug>.md 一起挪走(留在原地下次启动会被迁回来);只剩扁平文件时也是挪不是删', async () => {
    const { saveAgent, removeAgentKeepFiles } = await import('./agentRegistry.js');
    await saveAgent({ slug: 'both', name: 'Both', systemPrompt: 'x', description: 'd' });
    writeFileSync(path.join(home, 'agents', 'both.md'), '---\nname: Both\n---\nold');
    const both = await removeAgentKeepFiles('both');
    expect(both.ok && existsSync(path.join(both.keptAt!, 'config.toml')) && existsSync(path.join(both.keptAt!, 'both.md'))).toBe(true);
    expect(existsSync(path.join(home, 'agents', 'both.md'))).toBe(false);
    writeFileSync(path.join(home, 'agents', 'flat.md'), '---\nname: Flat\n---\nold');
    const flat = await removeAgentKeepFiles('flat');
    expect(readFileSync(path.join(flat.keptAt!, 'flat.md'), 'utf8')).toContain('name: Flat');
    expect(await removeAgentKeepFiles('ghost')).toEqual({ ok: true }); // 本来就不在
  });

  it('默认 Agent / 非法 slug → 拒,文件不动', async () => {
    const { removeAgentKeepFiles, listAgents } = await import('./agentRegistry.js');
    await listAgents(); // 播种默认 Agent
    expect(await removeAgentKeepFiles('xyra')).toEqual({ ok: false });
    expect(existsSync(path.join(home, 'agents', 'xyra'))).toBe(true);
    expect(await removeAgentKeepFiles('../evil')).toEqual({ ok: false });
  });
});
