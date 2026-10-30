/** Muse 的 manage_automation:ask / agent 档只提规则卡,一条规则都不写;auto 档直接建并提醒它说一声。 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  cards: [] as any[],
  pending: [] as any[],
  upserts: [] as any[],
}));

vi.mock('../src/services/museCards.js', () => ({
  postMuseCard: async (_u: string, c: any) => { h.cards.push(c); return { ok: true, id: 'c1' }; },
  listMuseCards: async () => h.pending,
}));
vi.mock('../src/services/museTriggers.js', async (orig) => ({
  ...(await orig<any>()),
  upsertTrigger: async (v: any) => { h.upserts.push(v); return { ok: true, created: true, trigger: { id: 'w-1', cond: v.cond } }; },
  loadTriggers: async () => [],
}));

import { manageAutomationProvider } from '../src/tools/builtin/manageAutomation.js';

const tool = manageAutomationProvider.tools()[0];
const ask = { muse: true, approvalMode: 'auto-edit', cwd: '/tmp', userId: 'u' } as any;
const auto = { ...ask, approvalMode: 'full-auto' };
const run = (a: Record<string, unknown>, ctx: any = ask): Promise<string> => tool.execute(a, ctx) as Promise<string>;
const remind = { action: 'set', desc: 'stretch', cond_type: 'computer.app_opened', params: { app: 'Figma' }, actions: [{ type: 'remind', title: 'stretch' }] };

beforeEach(() => { h.cards.length = 0; h.pending = []; h.upserts.length = 0; });

describe('ask / agent 档', () => {
  it('提醒规则 = 只发卡,不写规则;卡上带校验过的规则和入参', async () => {
    expect(await run(remind)).toMatch(/^Proposed\./);
    expect(h.upserts).toHaveLength(0);
    expect(h.cards[0].kind).toBe('rule');
    expect(h.cards[0].payload.rule.cond).toEqual({ type: 'computer.app_opened', params: { app: 'Figma' } });
    expect(h.cards[0].payload.input).toMatchObject({ cond_type: 'computer.app_opened', cooldown_hours: 2 });
    expect(h.cards[0].payload.input.action).toBeUndefined();
  });

  it('叫醒自己:电脑上 / 日历可以提,时间类是自激回路', async () => {
    expect(await run({ action: 'set', desc: 'w', cond_type: 'computer.returned', params: { minutes: 30 }, prompt: 'catch up' })).toMatch(/^Proposed\./);
    expect(await run({ action: 'set', desc: 'w', cond_type: 'every', interval: '2h', prompt: 'x' })).toMatch(/self-trigger loop/);
    expect(h.cards).toHaveLength(1);
  });

  it('只许提醒 / 通知 / 叫醒自己:别的动作、改已有规则、删规则都拒', async () => {
    const outs = [
      await run({ ...remind, actions: [{ type: 'agent_run', agentSlug: 'default', prompt: 'x' }] }),
      await run({ ...remind, id: 'w-1' }),
      await run({ action: 'remove', id: 'w-1' }),
    ];
    for (const o of outs) expect(o).toMatch(/^Error/);
    expect(h.cards).toHaveLength(0);
    expect(h.upserts).toHaveLength(0);
  });

  it('卡上只写得下一步:带两个动作的不提', async () => {
    const out = await run({ ...remind, actions: [{ type: 'remind', title: 'a' }, { type: 'notify', title: 'b' }] });
    expect(out).toMatch(/^Error/);
    expect(h.cards).toHaveLength(0);
  });

  it('建卡时的目录随卡存', async () => {
    await run(remind, { ...ask, cwd: '/proj' });
    expect(h.cards[0].payload.cwd).toBe('/proj');
  });

  it('list 照常;已有三张待回的规则卡就不再提', async () => {
    expect(await run({ action: 'list' })).not.toMatch(/^Error/);
    h.pending = [{ kind: 'rule' }, { kind: 'rule' }, { kind: 'rule' }, { kind: 'plugin' }];
    expect(await run(remind)).toMatch(/already waiting/);
    expect(h.cards).toHaveLength(0);
  });
});

describe('auto 档', () => {
  it('直接建,不发卡,工具结果让它在私聊说一声', async () => {
    const out = await run(remind, auto);
    expect(out).toMatch(/^Created automation/);
    expect(out).toContain('message_user');
    expect(h.upserts).toHaveLength(1);
    expect(h.cards).toHaveLength(0);
  });
});
