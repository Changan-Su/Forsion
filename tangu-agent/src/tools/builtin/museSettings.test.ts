/** propose_muse_settings:只给 Muse;能改的只有四项;只出卡不写配置。 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ cards: [] as any[], muse: {} as any }));
vi.mock('../../services/specialAgentsConfig.js', () => ({ loadSpecialAgentsConfig: () => ({ muse: h.muse }) }));
vi.mock('../../agents/agentRegistry.js', () => ({ MUSE_AGENT_SLUG: 'muse' }));
vi.mock('../../services/museCards.js', async () => {
  const fields = ['heartbeatMinutes', 'activeHours', 'notify', 'maxDmPerDay'];
  return {
    postMuseCard: async (_u: string, c: any) => { h.cards.push(c); return { ok: true }; },
    pickMuseSettings: (cur: any, w: any) => {
      const changes = fields.filter((f) => f in w && JSON.stringify(w[f]) !== JSON.stringify(cur[f])).map((field) => ({ field, from: cur[field], to: w[field] }));
      return { changes, patch: Object.fromEntries(changes.map((c) => [c.field, c.to])) };
    },
  };
});

import { museSettingsProvider } from './museSettings.js';

const tool = (museSettingsProvider.tools() as any[])[0];
const run = (args: any) => tool.execute(args, { userId: 'u', agentSlug: 'muse' });
const profile = { capabilities: { hostExec: true } };

beforeEach(() => { h.cards.length = 0; h.muse = { heartbeatMinutes: 120, activeHours: null, notify: 'immediate', maxDmPerDay: 0 }; });

describe('propose_muse_settings', () => {
  it('只给 Muse,子代理没有', () => {
    expect(tool.isEnabledFor(profile, { agentSlug: 'muse' })).toBe(true);
    expect(tool.isEnabledFor(profile, { agentSlug: 'xyra' })).toBe(false);
    expect(tool.isEnabledFor(profile, { agentSlug: 'muse', subAgentDepth: 1 })).toBe(false);
    expect(tool.isEnabledFor({ capabilities: {} }, { agentSlug: 'muse' })).toBe(false);
  });
  it('出一张卡,旧值 → 新值,不写配置', async () => {
    expect(await run({ active_hours: { start: 9, end: 23 } })).toMatch(/Nothing changes until they tap/);
    expect(h.cards[0]).toMatchObject({ kind: 'settings', uncapped: true });
    expect(h.cards[0].payload.changes).toEqual([{ field: 'activeHours', from: null, to: { start: 9, end: 23 } }]);
    expect(h.muse.activeHours).toBeNull();
  });
  it.each([['mode'], ['granted_folders'], ['max_iterations_per_cycle']])('%s 不能经卡片改', async (k) => {
    expect(await run({ [k]: 'auto', notify: 'digest' })).toMatch(/only when the user does it in Settings/);
    expect(h.cards).toEqual([]);
  });
  it('值已经是这样:不出卡', async () => {
    expect(await run({ heartbeat_minutes: 120 })).toMatch(/nothing to change/);
    expect(h.cards).toEqual([]);
  });
  it.each([[{ heartbeat_minutes: -5 }], [{ max_messages_per_day: 99 }], [{ notify: 'loud' }], [{ active_hours: { start: 9, end: 9 } }], [{ active_hours: { start: 25, end: 3 } }]])('超范围拒绝:%j', async (a) => {
    expect(await run(a)).toMatch(/out of range/);
    expect(h.cards).toEqual([]);
  });
  it('all_day 把作息改回全天', async () => {
    h.muse.activeHours = { start: 9, end: 21 };
    await run({ all_day: true });
    expect(h.cards[0].payload.patch).toEqual({ activeHours: null });
  });
});
