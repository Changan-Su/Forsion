/**
 * inbox_send 工具测试:真 SQLite(内存)+ fake brain/billing。
 * 覆盖:落库字段/agentSlug 缺省 xyra/deliver_at 全分支(未来 ISO、裸本地格式、非法、过去>5min 拒、
 * 过去≤5min 容忍、超一年拒)/频控 20 条每小时/hostExec=false profile 下不可见。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile, createAiStudioProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { inboxSendProvider } from '../src/tools/builtin/inboxSend.js';

const USER = 'u1';
const tool = inboxSendProvider.tools()[0];
const ctx: any = { userId: USER, sessionId: 's1', appId: 'tangu' };

beforeEach(async () => {
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({
    host,
    brain: {} as any,
    billing: {} as any,
    profile: createTanguProfile({ sandboxMode: 'none' }),
  });
  await runMigration();
});

async function rows(): Promise<any[]> {
  return query<any[]>(`SELECT * FROM inbox_messages WHERE user_id = ? ORDER BY created_at ASC`, [USER]);
}

describe('inbox_send', () => {
  it('立即发送落库:sender_kind=agent、slug 缺省 xyra、deliver_at NULL', async () => {
    const r = await tool.execute({ title: ' 测试标题 ', body: '正文' }, ctx);
    expect(String(r)).toContain('已投递');
    const [m] = await rows();
    expect(m.title).toBe('测试标题');
    expect(m.body).toBe('正文');
    expect(m.sender_kind).toBe('agent');
    expect(m.sender_id).toBe('xyra');
    expect(m.deliver_at).toBeNull();
  });

  it('ctx.agentSlug 存在时作为 sender_id', async () => {
    await tool.execute({ title: 't' }, { ...ctx, agentSlug: 'qinche' });
    const [m] = await rows();
    expect(m.sender_id).toBe('qinche');
  });

  it('title 缺失/空 → Error', async () => {
    expect(String(await tool.execute({ title: '  ' }, ctx))).toContain('Error');
    expect((await rows()).length).toBe(0);
  });

  it('deliver_at 未来 ISO(带时区)→ 正确 UTC 串落库', async () => {
    // 48h 后(秒对齐),以 +08:00 表示同一时刻
    const t = Math.floor(Date.now() / 1000) * 1000 + 48 * 3600_000;
    const iso8 = `${new Date(t + 8 * 3600_000).toISOString().slice(0, 19)}+08:00`;
    const r = await tool.execute({ title: 't', deliver_at: iso8 }, ctx);
    expect(String(r)).toContain('定时投递');
    const [m] = await rows();
    expect(m.deliver_at).toBe(new Date(t).toISOString().slice(0, 19).replace('T', ' '));
  });

  it('deliver_at 裸 "YYYY-MM-DD HH:mm" → 按本地时区换算', async () => {
    const l = new Date(Date.now() + 24 * 3600_000);
    const p = (n: number): string => String(n).padStart(2, '0');
    const raw = `${l.getFullYear()}-${p(l.getMonth() + 1)}-${p(l.getDate())} ${p(l.getHours())}:${p(l.getMinutes())}`;
    await tool.execute({ title: 't', deliver_at: raw }, ctx);
    const [m] = await rows();
    const expected = new Date(raw.replace(' ', 'T')).toISOString().slice(0, 19).replace('T', ' ');
    expect(m.deliver_at).toBe(expected);
  });

  it('deliver_at 非法 → Error;过去>5min → Error;超一年 → Error', async () => {
    expect(String(await tool.execute({ title: 't', deliver_at: 'not-a-date' }, ctx))).toContain('无法解析');
    const past = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(String(await tool.execute({ title: 't', deliver_at: past }, ctx))).toContain('过去时间');
    const far = new Date(Date.now() + 400 * 24 * 3600_000).toISOString();
    expect(String(await tool.execute({ title: 't', deliver_at: far }, ctx))).toContain('一年');
    expect((await rows()).length).toBe(0);
  });

  it('deliver_at 过去 ≤5min → 容忍,立即投递(deliver_at NULL)', async () => {
    const nearPast = new Date(Date.now() - 60_000).toISOString();
    const r = await tool.execute({ title: 't', deliver_at: nearPast }, ctx);
    expect(String(r)).toContain('已过期');
    const [m] = await rows();
    expect(m.deliver_at).toBeNull();
  });

  it('频控:第 21 条被拒', async () => {
    for (let i = 0; i < 20; i++) {
      expect(String(await tool.execute({ title: `t${i}` }, ctx))).toContain('已投递');
    }
    expect(String(await tool.execute({ title: 'overflow' }, ctx))).toContain('上限');
    expect((await rows()).length).toBe(20);
  });

  it('hostExec=false profile(ai-studio)下不可见', () => {
    const local = createTanguProfile({ sandboxMode: 'none' });
    const cloud = createAiStudioProfile();
    expect(tool.isEnabledFor!(local, ctx)).toBe(true);
    expect(tool.isEnabledFor!(cloud, ctx)).toBe(false);
  });
});
