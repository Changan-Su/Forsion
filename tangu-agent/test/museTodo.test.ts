/**
 * add_muse_todo 的收件箱投影(2026-09-11,用户报「Muse 的信里没有审批 / 执行按钮」):
 * 正文 = detail + 引擎拼在末尾的 forsion-task 卡(`todo:` = muse_todos 行 id,任务书 = 标题 + detail)。
 * 真 SQLite(内存)+ 临时 TANGU_HOME(digest 档读 config.json)。
 * 共享夹具 test/fixtures/muse-todo-mail*.md:桌面 suggest.test 与 e2e:inboxamadeus 读同一份,键名 / 形状一漂就在这里先红
 * (有意改格式:`UPDATE_FIXTURES=1 npx vitest run test/museTodo.test.ts` 重生夹具,再跑桌面那两处)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { closeOpenFence, museTodoProvider, todoMailBody } from '../src/tools/builtin/museTodo.js';

const USER = 'u1';
const tool = museTodoProvider.tools()[0];
const ctx: any = { userId: USER, sessionId: 's1', appId: 'tangu', muse: true };
const FIXTURES = {
  'muse-todo-mail.md': {
    id: 'todo-fixture-1',
    title: '恢复并验收鹈鹕骑自行车网页动画',
    detail: '上次生成 run 失败，产物可能不完整。先确认 `/Users/me/Forsion/pelican-cycling.html` 能在浏览器打开、动画真的在动；缺失或损坏再用最小可运行 HTML 重做，交付前截图验证。',
  },
  // detail 末尾的代码块没收口:引擎补收口,桌面照样摘出卡(Codex 09-11 P1)
  'muse-todo-mail-openfence.md': {
    id: 'todo-fixture-2',
    title: '给导出脚本补上错误处理',
    detail: "现在导出失败时直接退出、没有任何提示。照这段改：\n```js\ntry { await exportAll() } catch (e) { console.error('导出失败', e) }",
  },
};
const FIXTURE_INPUT = FIXTURES['muse-todo-mail.md'];
let home: string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-musetodo-'));
  process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
});

afterEach(() => {
  delete process.env.TANGU_HOME;
  rmSync(home, { recursive: true, force: true });
});

const mails = (): Promise<any[]> => query<any[]>(`SELECT * FROM inbox_messages WHERE user_id = ?`, [USER]);
const todos = (): Promise<any[]> => query<any[]>(`SELECT * FROM muse_todos WHERE user_id = ?`, [USER]);

describe('add_muse_todo → 收件箱信带任务卡', () => {
  it('信 = detail + 末尾 forsion-task 卡:todo 头 = TODO 行 id,任务书 = 标题 + detail', async () => {
    expect(String(await tool.execute({ title: FIXTURE_INPUT.title, detail: FIXTURE_INPUT.detail }, ctx))).toContain('已记录');
    const [t] = await todos();
    const [m] = await mails();
    expect(m.sender_id).toBe('muse');
    expect(m.body).toBe(todoMailBody({ id: t.id, title: t.title, detail: t.detail }));
    expect(m.body.startsWith(`${FIXTURE_INPUT.detail}\n\n\`\`\`forsion-task\n`)).toBe(true);
    expect(m.body).toContain(`\ntodo: ${t.id}\n---\n${FIXTURE_INPUT.title}\n\n${FIXTURE_INPUT.detail}\n\`\`\``);
    expect(m.body.endsWith('\n```')).toBe(true);
  });

  it('detail 里有 ``` → 卡的围栏加长,detail 收不了它', () => {
    const body = todoMailBody({ id: 'x', title: 't', detail: '改这段:\n```js\nconst a = 1\n```' });
    expect(body).toContain('\n````forsion-task\n');
    expect(body.endsWith('\n````')).toBe(true);
  });

  it('detail 末尾留着没收口的围栏(``` / ~~~)→ 卡前补一行收口,卡不会被吞进代码块', () => {
    expect(todoMailBody({ id: 'x', title: 't', detail: '改这段:\n```js\nconst a = 1' }).startsWith('改这段:\n```js\nconst a = 1\n```\n\n````forsion-task\n')).toBe(true);
    expect(todoMailBody({ id: 'x', title: 't', detail: '~~~sh\nls' }).startsWith('~~~sh\nls\n~~~\n\n```forsion-task\n')).toBe(true);
    expect(closeOpenFence('```js\nx\n```')).toBe('```js\nx\n```'); // 收口了的不动
    expect(closeOpenFence('~~~\nx\n```')).toBe('~~~\nx\n```\n~~~'); // 异种字符收不了口
    expect(closeOpenFence('```js\nx\n```\u00a0')).toBe('```js\nx\n```\u00a0\n```'); // 收口行带 NBSP 不算收口(与桌面同规则)
    expect(closeOpenFence('``` a`b\nx')).toBe('``` a`b\nx'); // 反引号开栏的 info 带反引号 = 不是围栏
  });

  it('detail 是 4000 个连续反引号:围栏 4001,整封照实落库不截(卡在最后)', async () => {
    const detail = '`'.repeat(4000);
    await tool.execute({ title: 'ticks', detail }, ctx);
    const [t] = await todos();
    const [m] = await mails();
    expect(m.body).toBe(todoMailBody({ id: t.id, title: 'ticks', detail }));
    expect(m.body.endsWith(`\n${'`'.repeat(4001)}`)).toBe(true);
  });

  it('4000 字 detail:收件箱 4000 上限不截掉卡(卡在最后、任务书完整)', async () => {
    const detail = 'd'.repeat(4000);
    await tool.execute({ title: 'long', detail }, ctx);
    const [t] = await todos();
    const [m] = await mails();
    expect(m.body).toBe(todoMailBody({ id: t.id, title: 'long', detail }));
    expect(m.body.length).toBeGreaterThan(8000);
  });

  it('digest 档:TODO 照落,不逐条发信', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ specialAgents: { muse: { notify: 'digest' } } }), 'utf8');
    await tool.execute({ title: 't', detail: 'd' }, ctx);
    expect((await todos()).length).toBe(1);
    expect((await mails()).length).toBe(0);
  });

  it('共享夹具 = todoMailBody(固定输入)(桌面 suggest.test / e2e:inboxamadeus 读它们)', () => {
    for (const [file, input] of Object.entries(FIXTURES)) {
      const p = fileURLToPath(new URL(`./fixtures/${file}`, import.meta.url));
      const body = todoMailBody(input);
      if (process.env.UPDATE_FIXTURES) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body, 'utf8'); }
      expect(readFileSync(p, 'utf8'), file).toBe(body);
    }
  });
});
