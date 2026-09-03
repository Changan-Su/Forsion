/**
 * 动作链执行器集成测试:真 SQLite(内存)+ 真 triggers.json(tmp TANGU_HOME)+ 真 executeTool
 * (经 registerToolProvider 注册测试工具,automationSafe 正向声明)。
 * 覆盖:notify 落库+执行账本、tool_call 直执行、白名单外工具 → 停用规则+通知用户、
 * 失败即停、试跑(manual)不烧 lastFiredAt(由调用方语义保证——runActions 本身不 mark)、
 * upsert 缺席 actions 保留旧值(旧客户端整量启停不抹链)。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { registerToolProvider } from '../src/tools/toolRegistry.js';
import { runActions, listExecutions, isAutomationTool } from '../src/services/automation.js';
import { validateTriggerInput, upsertTrigger, loadTriggers, type MuseTrigger } from '../src/services/museTriggers.js';
import { setCursors, loadCursors } from '../src/services/dbCursors.js';

const USER = 'local'; // automationUserId() 缺省

beforeAll(async () => {
  process.env.TANGU_HOME = mkdtempSync(join(tmpdir(), 'tangu-auto-test-'));
  delete process.env.TANGU_USER_ID;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  registerToolProvider({
    id: 'test:auto-tools',
    tools: () => [
      {
        name: 'test_echo',
        mode: 'both',
        capabilities: { automationSafe: true },
        definition: { type: 'function', function: { name: 'test_echo', description: 'echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
        execute: async (args) => `echo: ${args.text}`,
      },
      {
        name: 'test_fail',
        mode: 'both',
        capabilities: { automationSafe: true },
        definition: { type: 'function', function: { name: 'test_fail', description: 'always fails', parameters: { type: 'object', properties: {} } } },
        execute: async () => 'Error: boom',
      },
    ],
  });
});

function trig(over: Partial<MuseTrigger>): MuseTrigger {
  return {
    id: `w-${Math.random().toString(36).slice(2, 8)}`,
    desc: 'test automation',
    cond: { type: 'event_seen', match: 'x' },
    cooldownHours: 1,
    lastFiredAt: null,
    enabled: true,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe('runActions', () => {
  it('notify 步骤:直插 inbox_messages(sender=automation:<id>)+ 账本 done + transcript 投影', async () => {
    const t = trig({ actions: [{ type: 'notify', title: '晨间提醒', body: '今天的日程…' }] });
    const r = await runActions(t, 'auto');
    expect(r.status).toBe('done');
    expect(r.steps).toHaveLength(1);
    const msgs = await query<any[]>(`SELECT * FROM inbox_messages WHERE user_id = ?`, [USER]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].title).toBe('晨间提醒');
    expect(msgs[0].sender_id).toBe(`automation:${t.id}`);
    const ledger = await listExecutions(t.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe('done');
    expect(ledger[0].origin).toBe('auto');
    expect(ledger[0].steps[0].ok).toBe(true);
    // transcript 投影:常驻会话 + role='model' 消息
    const sess = await query<any[]>(`SELECT id FROM chat_sessions WHERE kind = 'automation'`);
    const rows = await query<any[]>(`SELECT role, content FROM chat_messages WHERE session_id = ?`, [sess[0].id]);
    expect(rows[0].role).toBe('model');
    expect(rows[0].content).toContain('notified');
  });

  it('tool_call 直执行(automationSafe 测试工具);失败即停链', async () => {
    const t = trig({ actions: [
      { type: 'tool_call', tool: 'test_echo', args: { text: 'hi' } },
      { type: 'tool_call', tool: 'test_fail', args: {} },
      { type: 'notify', title: '不应到达' },
    ] });
    const r = await runActions(t, 'manual');
    expect(r.status).toBe('failed');
    expect(r.steps).toHaveLength(2); // 第三步没跑
    expect(r.steps[0]).toMatchObject({ ok: true });
    expect(r.steps[0].summary).toContain('echo: hi');
    expect(r.steps[1].ok).toBe(false);
    const notReached = await query<any[]>(`SELECT * FROM inbox_messages WHERE title = '不应到达'`);
    expect(notReached).toHaveLength(0);
    const ledger = await listExecutions(t.id);
    expect(ledger[0].origin).toBe('manual');
  });

  it('白名单外工具:步骤失败 + 规则停用 + 通知用户', async () => {
    expect(isAutomationTool('ask_user')).toBe(false);
    // 先把规则落盘(disableTrigger 要能找到它)
    const v = validateTriggerInput(
      { desc: 'bad tool rule', cond_type: 'event_seen', match: 'y', actions: [{ type: 'tool_call', tool: 'test_echo', args: { text: 'x' } }] },
      { allowToolCall: true },
    );
    expect(v.ok).toBe(true);
    const saved = v.ok ? await upsertTrigger(v.value) : null;
    expect(saved?.ok).toBe(true);
    const rule = saved && saved.ok ? saved.trigger : null!;
    // 篡改成不在白名单的工具再执行(模拟插件被卸载/未声明)
    const tampered: MuseTrigger = { ...rule, actions: [{ type: 'tool_call', tool: 'ask_user', args: {} }] };
    const r = await runActions(tampered, 'auto');
    expect(r.status).toBe('failed');
    const after = (await loadTriggers()).find((x) => x.id === rule.id);
    expect(after?.enabled).toBe(false); // 已停用
    const note = await query<any[]>(`SELECT * FROM inbox_messages WHERE title LIKE '%已停用%'`);
    expect(note.length).toBeGreaterThan(0);
  });
});

describe('upsertTrigger cond 变化重置触发状态', () => {
  it('cond 实质变化 → createdAt 刷新+lastFiredAt 清;仅改描述 → 全保留', async () => {
    const v1 = validateTriggerInput({ desc: 'daily rule', cond_type: 'daily_at', time: '22:00' });
    const created = v1.ok ? await upsertTrigger(v1.value) : null;
    const rule = created && created.ok ? created.trigger : null!;
    // 直改落盘文件,伪造成长期存在且触发过的规则(loadTriggers 每次读盘,改内存副本不生效)
    const file = join(process.env.TANGU_HOME!, 'agents', 'muse', 'triggers.json');
    const oldCreated = '2026-01-01T00:00:00.000Z';
    const oldFired = '2026-07-01T22:01:00.000Z';
    const raw = JSON.parse(readFileSync(file, 'utf8')) as MuseTrigger[];
    const cur = raw.find((x) => x.id === rule.id)!;
    cur.createdAt = oldCreated;
    cur.lastFiredAt = oldFired;
    writeFileSync(file, JSON.stringify(raw));
    // 仅改描述(cond 同值)→ createdAt/lastFiredAt 保留
    const vDesc = validateTriggerInput({ desc: 'renamed', cond_type: 'daily_at', time: '22:00' });
    const r1 = vDesc.ok ? await upsertTrigger(vDesc.value, rule.id) : null;
    expect(r1 && r1.ok && r1.trigger.createdAt).toBe(oldCreated);
    expect(r1 && r1.ok && r1.trigger.lastFiredAt).toBe(oldFired);
    // 改时间(cond 变化)→ 重置(21:00 把 22:00 改成 08:00 不得按旧 createdAt 立即补发)
    const vCond = validateTriggerInput({ desc: 'renamed', cond_type: 'daily_at', time: '08:00' });
    const r2 = vCond.ok ? await upsertTrigger(vCond.value, rule.id) : null;
    expect(r2 && r2.ok && r2.trigger.createdAt).not.toBe(oldCreated);
    expect(r2 && r2.ok && r2.trigger.lastFiredAt).toBeNull();
  });
});

describe('upsertTrigger actions 保留语义', () => {
  it('缺席=保留旧链(旧客户端整量启停不抹);null=显式清空', async () => {
    const v1 = validateTriggerInput(
      { desc: 'keep me', cond_type: 'event_seen', match: 'z', actions: [{ type: 'notify', title: 'n1' }] },
      { allowToolCall: true },
    );
    const created = v1.ok ? await upsertTrigger(v1.value) : null;
    const id = created && created.ok ? created.trigger.id : '';
    expect(id).toBeTruthy();
    // 旧客户端形态:整量回传但不带 actions 键(undefined)→ 保留
    const v2 = validateTriggerInput({ desc: 'keep me', cond_type: 'event_seen', match: 'z', enabled: false });
    const toggled = v2.ok ? await upsertTrigger(v2.value, id) : null;
    expect(toggled && toggled.ok && toggled.trigger.actions?.length).toBe(1);
    expect(toggled && toggled.ok && toggled.trigger.enabled).toBe(false);
    // 显式 null → 清空回旧语义
    const v3 = validateTriggerInput({ desc: 'keep me', cond_type: 'event_seen', match: 'z', actions: null });
    const cleared = v3.ok ? await upsertTrigger(v3.value, id) : null;
    expect(cleared && cleared.ok && cleared.trigger.actions).toBeUndefined();
  });
});

describe('upsertTrigger cond 变化 → db 游标一起作废(真源在 upsertTrigger,不在 HTTP 路由)', () => {
  it('换表 → 游标清;只改描述 → 游标留', async () => {
    // manage_automation(tools/builtin/manageAutomation.ts)直接调 upsertTrigger,从前**不丢游标** ——
    // 「cond 变了 → dropCursors」只写在 routes/special.ts。于是经工具换表:拿 A 表的基线去比 B 表,
    // B 的满表现有行全被当成「刚加的」当场误触发。读端的 cursorFits 只自证「哪几列」,换 path / row_added
    // 换表它一点忙都帮不上 —— 这条只能靠写端。
    const mk = (path: string, desc = 'erp rule') =>
      validateTriggerInput({ desc, cond_type: 'db_changed', path, vault: '/v', event: 'row_added' });
    const v1 = mk('订单.db');
    const created = v1.ok ? await upsertTrigger(v1.value) : null;
    const id = created && created.ok ? created.trigger.id : '';
    expect(id).toBeTruthy();
    await setCursors({ [id]: { v: 1, rowIds: ['o1', 'o2'] } });
    // 只改描述(cond 同值)→ 游标必须留着,否则改个名字就重播种、丢一窗事件
    const vDesc = mk('订单.db', '改个名字');
    expect(vDesc.ok && (await upsertTrigger(vDesc.value, id)).ok).toBe(true);
    expect((await loadCursors())[id]).toEqual({ v: 1, rowIds: ['o1', 'o2'] });
    // 换表 → 游标清空(下一 tick 按新表重播种)
    const vPath = mk('出库.db');
    expect(vPath.ok && (await upsertTrigger(vPath.value, id)).ok).toBe(true);
    // 负对照(实跑过):删掉 upsertTrigger 里 cond 变化分支的 `await dropCursors([cur.id])` → 此断言拿到旧的 {rowIds:['o1','o2']} → 红
    expect((await loadCursors())[id]).toBeUndefined();
  });
});
