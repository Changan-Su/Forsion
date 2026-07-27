/**
 * inbox_send 工具测试:真 SQLite(内存)+ fake brain/billing。
 * 覆盖:落库字段/agentSlug 缺省 xyra/频控 20 条每小时/hostExec=false profile 下不可见/
 * 定时参数已下线(传了也当普通即时消息,schema 无此参数)。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile, createAiStudioProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { inboxSendProvider, sendInboxMessage } from '../src/tools/builtin/inboxSend.js';

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

  it('定时参数已下线:传 deliver_at 也按即时投递(schema 无此参数,execute 直接无视)', async () => {
    const r = await tool.execute({ title: 't', deliver_at: new Date(Date.now() + 3600_000).toISOString() }, ctx);
    expect(String(r)).toContain('已投递');
    const [m] = await rows();
    expect(m.deliver_at).toBeNull();
  });

  it('工具 schema 不再暴露 deliver_at', () => {
    const props = (tool.definition as any).function.parameters.properties;
    expect(props.deliver_at).toBeUndefined();
    expect(Object.keys(props).sort()).toEqual(['body', 'title']);
  });

  it('频控:第 21 条被拒', async () => {
    for (let i = 0; i < 20; i++) {
      expect(String(await tool.execute({ title: `t${i}` }, ctx))).toContain('已投递');
    }
    expect(String(await tool.execute({ title: 'overflow' }, ctx))).toContain('上限');
    expect((await rows()).length).toBe(20);
  });

  it('sendInboxMessage 投递内核:自定义 senderId 落库(自动化 notify 用)', async () => {
    const r = await sendInboxMessage(USER, { title: '提醒', body: 'b', senderId: 'automation:w-abc123' });
    expect(r.ok).toBe(true);
    const [m] = await rows();
    expect(m.sender_id).toBe('automation:w-abc123');
    expect(m.sender_kind).toBe('agent');
  });

  it('hostExec=false profile(ai-studio)下不可见', () => {
    const local = createTanguProfile({ sandboxMode: 'none' });
    const cloud = createAiStudioProfile();
    expect(tool.isEnabledFor!(local, ctx)).toBe(true);
    expect(tool.isEnabledFor!(cloud, ctx)).toBe(false);
  });
});
