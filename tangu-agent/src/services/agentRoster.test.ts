/** 系统提示「Other Agents」名册:列其他 agent,自己与系统 agent 不列;共享技能按主人挂行尾;只有自己 → 空串。 */
import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({ agents: [] as Array<Record<string, unknown>>, shared: [] as Array<Record<string, unknown>> }));
vi.mock('../agents/agentRegistry.js', () => ({ listAgents: async () => h.agents }));
vi.mock('../skills/localSkills.js', () => ({
  SHARED_SKILL_ID_RE: /^local:@([a-z0-9][a-z0-9-]{0,63})\/([^/]+)$/,
  listSharedAgentSkills: async (exclude: string | null) => h.shared.filter((s) => s.ownerSlug !== exclude),
}));
import { buildAgentRoster } from './agentRoster.js';

describe('buildAgentRoster', () => {
  it('列其他 agent;自己与系统 agent 不列;共享技能挂在主人行尾', async () => {
    h.agents = [
      { slug: 'xyra', name: 'Arioso', description: 'default', createdBy: 'user' },
      { slug: 'coding', name: 'Coding', description: 'Build apps', createdBy: 'user' },
      { slug: 'muse', name: 'Muse', description: 'bg', createdBy: 'system' },
      { slug: 'aria', name: 'Aria', description: '', createdBy: 'user' },
    ];
    h.shared = [{ id: 'local:@coding/forsion-webapp', name: 'x', ownerSlug: 'coding' }, { id: 'local:@coding/web-debugging', name: 'y', ownerSlug: 'coding' }, { id: 'local:@xyra/mine', name: 'z', ownerSlug: 'xyra' }];
    const r = await buildAgentRoster('xyra');
    const lines = r.split('\n');
    expect(lines[0]).toBe('## Other Agents');
    expect(lines).toContain('- Coding (slug: `coding`) — Build apps · shares skills: forsion-webapp, web-debugging');
    expect(lines).toContain('- Aria (slug: `aria`)');
    expect(r).not.toContain('Arioso');
    expect(r).not.toContain('muse');
    expect(r).toContain('`delegate`');
    expect(r).toContain('`start_discussion`');
  });
  it('只有自己 / 只剩系统 agent → 空串,不注入', async () => {
    h.agents = [{ slug: 'xyra', name: 'Arioso', description: '', createdBy: 'user' }, { slug: 'muse', name: 'Muse', description: '', createdBy: 'system' }];
    h.shared = [];
    expect(await buildAgentRoster('xyra')).toBe('');
  });
});
