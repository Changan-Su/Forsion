/** renameAgent:文件夹搬家 + 各处引用跟着改;内置 / 云同步过 / 插件播种 / 在飞 run 四类拒绝。
 *  独立文件(自己的 TANGU_HOME)→ ensureAgentsReady 记忆化不被别的用例污染。 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { promises as fs, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const h = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown[]]>,
  sessions: [] as Array<{ id: string; agent_config: unknown }>,
  active: new Set<string>(),
}));
vi.mock('../core/db.js', () => ({
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    h.calls.push([sql, params]);
    return sql.startsWith('SELECT id, agent_config') ? h.sessions : [];
  }),
}));
vi.mock('../services/agentLoop.js', () => ({ sessionHasActiveRun: (id: string) => h.active.has(id) }));

describe('renameAgent', () => {
  let home: string;
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-rename-'));
    process.env.TANGU_HOME = home;
  });
  afterAll(async () => {
    await fs.rm(home, { recursive: true, force: true });
    delete process.env.TANGU_HOME;
  });

  it('搬文件夹,并改 meta / 会话 / 消息 / 团队 / 自动化 / 通道里的引用', async () => {
    const { saveAgent, writeAgentsMeta, readAgentsMeta, getAgent, parseAgentConfig } = await import('./agentRegistry.js');
    const { saveTeam, getTeam } = await import('./teamRegistry.js');
    const { saveTriggers, loadTriggers } = await import('../services/museTriggers.js');
    const { saveChannelSettings, channelSettings } = await import('../channels/config.js');
    const { renameAgent, renameInAgentConfig } = await import('./agentRename.js');

    await saveAgent({ slug: 'old-bot', name: 'Old Bot', systemPrompt: 'be old', description: 'd' });
    writeFileSync(path.join(home, 'agents', 'old-bot', 'MEMORY.md'), '- remembers\n');
    await writeAgentsMeta({ order: ['old-bot', 'xyra'], defaultSlug: 'old-bot' });
    await saveTeam({ slug: 'duo', name: 'Duo', members: [{ slug: 'old-bot', role: 'lead' }, { slug: 'aria' }], lead: 'old-bot' });
    await saveTriggers([{ id: 't1', desc: 'x', cond: { type: 'every', interval: '1h' } as any, cooldownHours: 0, lastFiredAt: null, enabled: true, createdAt: 'now', agentSlug: 'old-bot', actions: [{ type: 'agent_run', agentSlug: 'old-bot', prompt: 'go' }] }]);
    saveChannelSettings('wechat', { agentSlug: 'old-bot' });
    h.sessions = [
      { id: 's1', agent_config: JSON.stringify({ agentSlug: 'old-bot', soloAgentSlug: 'old-bot', cwd: '/x' }) },
      { id: 's2', agent_config: { groupChat: true, groupAgents: ['old-bot', 'aria'] } },
      { id: 's3', agent_config: JSON.stringify({ agentSlug: 'xyra' }) },
    ];

    const { agent, warnings } = await renameAgent('old-bot', 'new-bot');
    expect(warnings).toEqual([]);
    expect(agent.slug).toBe('new-bot');
    expect(agent.name).toBe('Old Bot');
    expect(existsSync(path.join(home, 'agents', 'old-bot'))).toBe(false);
    expect(await fs.readFile(path.join(home, 'agents', 'new-bot', 'MEMORY.md'), 'utf8')).toBe('- remembers\n');
    expect(await getAgent('old-bot')).toBeNull();
    expect(parseAgentConfig('new-bot', await fs.readFile(path.join(home, 'agents', 'new-bot', 'config.toml'), 'utf8'), '').name).toBe('Old Bot');
    expect(readAgentsMeta()).toEqual({ order: ['new-bot', 'xyra'], defaultSlug: 'new-bot' });
    const team = await getTeam('duo');
    expect(team?.members.map((m) => m.slug)).toEqual(['new-bot', 'aria']);
    expect(team?.lead).toBe('new-bot');
    const [trigger] = await loadTriggers();
    expect(trigger.agentSlug).toBe('new-bot');
    expect((trigger.actions?.[0] as any).agentSlug).toBe('new-bot');
    expect(channelSettings('wechat').agentSlug).toBe('new-bot');

    const updates = h.calls.filter(([sql]) => sql.startsWith('UPDATE'));
    expect(updates).toContainEqual(['UPDATE chat_sessions SET agent_config = ? WHERE id = ?', [JSON.stringify({ agentSlug: 'new-bot', soloAgentSlug: 'new-bot', cwd: '/x' }), 's1']]);
    expect(updates).toContainEqual(['UPDATE chat_sessions SET agent_config = ? WHERE id = ?', [JSON.stringify({ groupChat: true, groupAgents: ['new-bot', 'aria'] }), 's2']]);
    expect(updates.some(([, p]) => (p as string[])[1] === 's3')).toBe(false);
    expect(updates).toContainEqual(['UPDATE chat_messages SET agent_slug = ? WHERE agent_slug = ?', ['new-bot', 'old-bot']]);
    expect(updates).toContainEqual(['UPDATE pending_approvals SET agent_slug = ? WHERE agent_slug = ?', ['new-bot', 'old-bot']]);
    expect(updates.some(([sql]) => sql.startsWith('UPDATE inbox_messages'))).toBe(true);
    expect(renameInAgentConfig({ agentSlug: 'other' }, 'old-bot', 'new-bot')).toBeNull();
  });

  it('拒绝:内置 / 目标已存在 / 云同步过 / 插件播种 / 在飞 run / 不存在', async () => {
    const { saveAgent } = await import('./agentRegistry.js');
    const { renameAgent, AgentRenameError } = await import('./agentRename.js');
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof AgentRenameError ? e.code : `other:${e}`));

    expect(await code(renameAgent('xyra', 'arioso'))).toBe('builtin');
    expect(await code(renameAgent('new-bot', 'aria'))).toBe('builtin');
    expect(await code(renameAgent('new-bot', 'Bad Slug'))).toBe('invalid_slug');
    expect(await code(renameAgent('new-bot', 'new-bot'))).toBe('unchanged');
    expect(await code(renameAgent('ghost', 'x'))).toBe('not_found');

    await saveAgent({ slug: 'taken', name: 'Taken', systemPrompt: 'x' });
    expect(await code(renameAgent('new-bot', 'taken'))).toBe('exists');

    await saveAgent({ slug: 'synced-on', name: 'S', systemPrompt: 'x', cloudSync: true });
    expect(await code(renameAgent('synced-on', 'free-a'))).toBe('cloud_synced');
    await saveAgent({ slug: 'synced-once', name: 'S', systemPrompt: 'x' });
    writeFileSync(path.join(home, 'agents', 'synced-once', '.cloudsync-abc123.json'), '{}');
    expect(await code(renameAgent('synced-once', 'free-b'))).toBe('cloud_synced');
    await saveAgent({ slug: 'toggled', name: 'S', systemPrompt: 'x' });
    writeFileSync(path.join(home, 'agents', 'toggled', '.cloudsync-accounts.json'), '{"accounts":{}}'); // 只开过开关没同步过 → 放行
    expect(await code(renameAgent('toggled', 'free-c'))).toBe('ok');

    await saveAgent({ slug: 'seeded', name: 'S', systemPrompt: 'x' });
    writeFileSync(path.join(home, 'agents', 'seeded', '.bundle-origin'), 'some-plugin');
    expect(await code(renameAgent('seeded', 'free-d'))).toBe('plugin_seeded');

    h.sessions = [{ id: 'live', agent_config: JSON.stringify({ agentSlug: 'new-bot' }) }];
    h.active.add('live');
    expect(await code(renameAgent('new-bot', 'free-e'))).toBe('busy');
    expect(existsSync(path.join(home, 'agents', 'new-bot'))).toBe(true);
    h.active.clear();
    expect(await code(renameAgent('new-bot', 'free-e'))).toBe('ok');
  });
});
