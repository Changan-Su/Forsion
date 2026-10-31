/** trashAgent:从名册移除,整个目录挪进回收站(<tanguHome>/trash/,名册不再加载);默认 Agent 拒删、文件原样不动。
 *  独立文件(自己的 TANGU_HOME)→ ensureAgentsReady 记忆化不被别的用例污染。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('trashAgent', () => {
  let home: string;
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-remove-'));
    process.env.TANGU_HOME = home;
  });
  afterAll(async () => {
    await fs.rm(home, { recursive: true, force: true });
    delete process.env.TANGU_HOME;
  });
  const stored = async (entry: any, role: string): Promise<string> => {
    const { trashDir } = await import('../services/trash.js');
    return path.join(trashDir(), entry.id, entry.items.find((i: any) => i.role === role).stored);
  };

  it('挪进回收站(记忆与 Library 都在),名册不再列出;同名再建再删各占一条', async () => {
    const { saveAgent, listAgents, trashAgent } = await import('./agentRegistry.js');
    await saveAgent({ slug: 'helper', name: 'Helper', systemPrompt: 'help', description: 'd' });
    writeFileSync(path.join(home, 'agents', 'helper', 'MEMORY.md'), '- remembers\n');
    const first = await trashAgent('helper');
    expect(first.ok && first.entry?.kind === 'agent' && first.entry.name === 'Helper').toBe(true);
    expect(readFileSync(path.join(await stored(first.entry, 'dir'), 'MEMORY.md'), 'utf8')).toBe('- remembers\n');
    expect(existsSync(path.join(home, 'agents', 'helper'))).toBe(false);
    expect((await listAgents()).map((a) => a.slug)).not.toContain('helper');

    await saveAgent({ slug: 'helper', name: 'Helper 2', systemPrompt: 'help', description: 'd' });
    const second = await trashAgent('helper');
    expect(second.ok && second.entry!.id !== first.entry!.id && existsSync(await stored(second.entry, 'dir')) && existsSync(await stored(first.entry, 'dir'))).toBe(true);
  });

  it('遗留扁平 <slug>.md 一起挪走(留在原地下次启动会被迁回来);只剩扁平文件时也是挪不是删', async () => {
    const { saveAgent, trashAgent } = await import('./agentRegistry.js');
    await saveAgent({ slug: 'both', name: 'Both', systemPrompt: 'x', description: 'd' });
    writeFileSync(path.join(home, 'agents', 'both.md'), '---\nname: Both\n---\nold');
    const both = await trashAgent('both');
    expect(existsSync(path.join(await stored(both.entry, 'dir'), 'config.toml')) && existsSync(await stored(both.entry, 'flat'))).toBe(true);
    expect(existsSync(path.join(home, 'agents', 'both.md'))).toBe(false);
    writeFileSync(path.join(home, 'agents', 'flat.md'), '---\nname: Flat\n---\nold');
    const flat = await trashAgent('flat');
    expect(readFileSync(await stored(flat.entry, 'flat'), 'utf8')).toContain('name: Flat');
    expect(await trashAgent('ghost')).toEqual({ ok: true }); // 本来就不在
  });

  it('恢复回原处;原名被占落到 <slug>-2,名册两个都在', async () => {
    const { saveAgent, trashAgent, listAgents } = await import('./agentRegistry.js');
    const { restoreAgent } = await import('../services/agentUninstall.js');
    await saveAgent({ slug: 'back', name: 'Back', systemPrompt: 'x', description: 'd' });
    const a = await trashAgent('back');
    expect(await restoreAgent('u', a.entry!)).toEqual({ slug: 'back', renamed: false });
    const b = await trashAgent('back');
    await saveAgent({ slug: 'back', name: 'New back', systemPrompt: 'x', description: 'd' });
    expect(await restoreAgent('u', b.entry!)).toEqual({ slug: 'back-2', renamed: true });
    const names = (await listAgents()).filter((x) => x.slug.startsWith('back')).map((x) => [x.slug, x.name]);
    expect(names).toEqual(expect.arrayContaining([['back', 'New back'], ['back-2', 'Back']]));
  });

  it('默认 Agent / 非法 slug → 拒,文件不动', async () => {
    const { trashAgent, listAgents } = await import('./agentRegistry.js');
    await listAgents(); // 播种默认 Agent
    expect(await trashAgent('xyra')).toEqual({ ok: false });
    expect(existsSync(path.join(home, 'agents', 'xyra'))).toBe(true);
    expect(await trashAgent('../evil')).toEqual({ ok: false });
  });
});
