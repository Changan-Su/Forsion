/** 主动消息的一天上限与磨合期:配置 0 = 不限、磨合期封 3 条且作息外不发、uncapped(设置卡 / 三问 / 小结)不占额度。 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ db: null as any, muse: { maxDmPerDay: 0, activeHours: null } as any, onboarding: null as any }));
vi.mock('../core/db.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  h.db = new Database(':memory:');
  h.db.exec(`CREATE TABLE chat_sessions (id TEXT, updated_at TEXT, proactive_at BIGINT, awaiting_user INT)`);
  h.db.exec(`CREATE TABLE chat_messages (id TEXT, session_id TEXT, role TEXT, content TEXT, timestamp BIGINT, model_id TEXT, is_error INT, agent_slug TEXT, origin TEXT)`);
  return { query: async (sql: string, params: any[] = []) => { const st = h.db.prepare(sql); return st.reader ? st.all(...params) : (st.run(...params.map((p) => (typeof p === 'boolean' ? Number(p) : p))), []); } };
});
vi.mock('../routes/solo.js', () => ({ ensureSoloSession: async () => ({ id: 's' }) }));
vi.mock('./childSessions.js', () => ({ endsWithQuestion: () => false }));
vi.mock('../agents/agentRegistry.js', () => ({ MUSE_AGENT_SLUG: 'muse' }));
vi.mock('./specialAgentsConfig.js', () => ({
  loadSpecialAgentsConfig: () => ({ muse: h.muse }),
  isWithinActiveHours: (cfg: any) => cfg.activeHours !== 'closed',
}));
vi.mock('./museState.js', async (orig) => ({ ...(await orig<any>()), readMuseOnboarding: async () => h.onboarding }));

import { postMuseDm } from './museDm.js';
import { MUSE_ONBOARDING_MS, onboardingActive } from './museState.js';

const HOUR = 3_600_000;
const seed = (n: number, ago = HOUR * 2) => { for (let i = 0; i < n; i++) h.db.prepare(`INSERT INTO chat_messages (id, session_id, role, content, timestamp, origin) VALUES (?, 's', 'model', 'x', ?, 'proactive')`).run(`seed${i}`, Date.now() - ago); };

beforeEach(() => {
  h.db.exec('DELETE FROM chat_messages; DELETE FROM chat_sessions');
  h.muse = { maxDmPerDay: 0, activeHours: null };
  h.onboarding = null;
});

describe('一天上限', () => {
  it('0 = 不限(只剩每小时 3 条)', async () => {
    seed(10);
    expect((await postMuseDm('u', 'hi')).ok).toBe(true);
  });
  it('配置 2 条:第三条拒,模型卡也算', async () => {
    h.muse.maxDmPerDay = 2;
    seed(2);
    expect(await postMuseDm('u', 'hi')).toMatchObject({ ok: false, error: expect.stringMatching(/2 times/) });
    expect((await postMuseDm('u', 'card', 'proactive:card')).ok).toBe(false);
  });
  it('24 小时滚动:昨天的不算', async () => {
    h.muse.maxDmPerDay = 1;
    seed(1, 25 * HOUR);
    expect((await postMuseDm('u', 'hi')).ok).toBe(true);
  });
  it('notice(第一次见面 / 设置卡)不受闸,也不占额度:答完三问选「每天一条」,第一条普通消息照发', async () => {
    h.muse.maxDmPerDay = 1;
    seed(1);
    expect((await postMuseDm('u', 'card', 'proactive:notice')).ok).toBe(true);
    h.db.exec('DELETE FROM chat_messages');
    await postMuseDm('u', 'hello', 'proactive:notice');
    expect((await postMuseDm('u', 'hi')).ok).toBe(true);
  });
  it('待办 / 审批自有配额,不受这道闸', async () => {
    h.muse.maxDmPerDay = 1;
    seed(1);
    expect((await postMuseDm('u', 'todo', 'proactive:todo')).ok).toBe(true);
  });
});

describe('磨合期', () => {
  const fresh = () => { h.onboarding = { startedAt: Date.now(), fresh: true }; };
  it('新用户一天封 3 条,哪怕配置不限', async () => {
    fresh();
    seed(3);
    expect((await postMuseDm('u', 'hi')).ok).toBe(false);
  });
  it('配置更严时听配置', async () => {
    fresh();
    h.muse.maxDmPerDay = 1;
    seed(1);
    expect((await postMuseDm('u', 'hi')).ok).toBe(false);
  });
  it('作息外不发;过了磨合期不再拦', async () => {
    fresh();
    h.muse.activeHours = 'closed';
    expect(await postMuseDm('u', 'hi')).toMatchObject({ ok: false, error: expect.stringMatching(/active hours/) });
    h.onboarding.startedAt = Date.now() - MUSE_ONBOARDING_MS - 1;
    expect((await postMuseDm('u', 'hi')).ok).toBe(true);
  });
  it('老用户(fresh=false)不走这道闸', async () => {
    h.onboarding = { startedAt: Date.now(), fresh: false };
    seed(5);
    expect((await postMuseDm('u', 'hi')).ok).toBe(true);
  });
  it('onboardingActive 只算新用户的 14 天', () => {
    const now = Date.now();
    expect(onboardingActive({ startedAt: now, fresh: true }, now)).toBe(true);
    expect(onboardingActive({ startedAt: now - MUSE_ONBOARDING_MS, fresh: true }, now)).toBe(false);
    expect(onboardingActive({ startedAt: now, fresh: false }, now)).toBe(false);
    expect(onboardingActive(null, now)).toBe(false);
  });
});
