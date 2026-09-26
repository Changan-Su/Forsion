// 云端空闲扫描版 Historian(网关跑,服务 web/安卓 tangu 会话):标题 + LOG + 长期记忆。
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/agents/cloudAgentStore.js', () => ({
  cloudGetAgent: async (_u: string, slug: string) => (slug === 'gone' ? null : { slug, shareDefaultMemory: false }),
}));

import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { currentAgentSlug } from '../src/seams/runContext.js';
import { tick } from '../src/services/historian.js';
import { setHistorianConfig } from '../src/services/historianConfig.js';

let db: ReturnType<typeof createSqliteHost>['db'];
let mem: { slug: string | undefined; text: string }[];
let logs: { slug: string | undefined; text: string }[];
let prompts: string[];
let reply: string;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString().replace('T', ' ').slice(0, 19);

beforeEach(async () => {
  const local = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u' });
  db = local.db;
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  mem = []; logs = []; prompts = [];
  reply = JSON.stringify({
    title: '新标题',
    log: '完成了部署脚本',
    memory: ['用户偏好简洁直接的回答', '用户的数据库密码是 hunter2', 'Build uses sk-abcdefghijklmnopqrstuvwx1234 style ids', 'x'.repeat(301), '第四条记忆内容', '第五条记忆内容'],
  });
  configureTangu({
    host: local.host,
    profile: createTanguProfile({ sandboxMode: 'none' }),
    brain: {
      llm: {
        resolveModelAndKey: async () => ({ model: { name: 'm', provider: 'p' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
        buildProviderPayload: async (p: any) => { prompts.push(p.messages.at(-1).content); return p; },
        streamProviderCompletion: async () => ({ content: reply, usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      },
      users: { getUserById: async () => null },
      memory: {
        getMemory: async () => ({ content: '已有:用户住在杭州', updatedAt: null }),
        appendMemoryEntry: async (_u: string, text: string) => { mem.push({ slug: currentAgentSlug(), text }); return { appended: true, length: 0 }; },
        appendLogEntry: async (_u: string, text: string) => { logs.push({ slug: currentAgentSlug(), text }); return {}; },
      },
    } as any,
    billing: { calculateCost: async () => 0, logApiUsage: async () => {} } as any,
  });
  await runMigration();
  await setHistorianConfig({ enabled: true, modelId: 'm', idleMinutes: 10 });
  // 顺序 = updated_at 升序:带 agent 的会话先跑,未绑定的后跑 → 验 slug 不漏给后一个
  await query(
    `INSERT INTO chat_sessions (id, user_id, app_id, title, agent_config, updated_at) VALUES
      ('aria-s', 'u', 'tangu', '旧标题', '{"agentSlug":"aria"}', ?),
      ('plain-s', 'u', 'tangu', '', NULL, ?),
      ('ancient', 'u', 'tangu', '三天前', NULL, ?)`,
    [ago(40), ago(30), ago(3 * 24 * 60)],
  );
  for (const id of ['aria-s', 'plain-s', 'ancient']) {
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES (?, ?, 'user', '帮我写部署脚本', ?)`, [`m-${id}`, id, Date.now()]);
  }
});
afterEach(() => db.close());

describe('cloud idle Historian (tangu sessions)', () => {
  it('writes gated memory into each session\'s own scope, skips sessions outside the lookback window', async () => {
    await tick();

    // 回看窗:三天前的会话不碰(打开开关不会重扫全部历史)
    const ancient = (await query<any[]>(`SELECT title, historian_last_summary_at FROM chat_sessions WHERE id = 'ancient'`))[0];
    expect(ancient.title).toBe('三天前');
    expect(ancient.historian_last_summary_at).toBeNull();

    // 记忆:≤3 条、超 300 字的丢弃、密钥脱敏;记忆域各归各的(未绑定会话不继承上一个的 aria)
    // 提到凭据的整条丢(hunter2 不是令牌形状,redactSecrets 认不出);令牌形状的脱敏后保留
    expect(mem.filter((m) => m.slug === 'aria').map((m) => m.text)).toEqual(['用户偏好简洁直接的回答', expect.stringContaining('[REDACTED]'), '第四条记忆内容']);
    expect(mem.some((m) => m.text.includes('hunter2'))).toBe(false);
    expect(mem.filter((m) => m.slug !== 'aria')).toHaveLength(3);
    expect(mem.filter((m) => m.slug !== 'aria').every((m) => m.slug === undefined)).toBe(true);
    expect(mem.some((m) => m.text.includes('sk-abc'))).toBe(false);
    expect(logs.map((l) => l.slug)).toEqual(['aria', undefined]);

    // 判官看得到现有记忆(防重复);两个会话都已标记
    expect(prompts[0]).toContain('[Existing memory]\n已有:用户住在杭州');
    const done = await query<any[]>(`SELECT id, title FROM chat_sessions WHERE historian_last_summary_at IS NOT NULL ORDER BY id`);
    expect(done.map((r) => [r.id, r.title])).toEqual([['aria-s', '新标题'], ['plain-s', '新标题']]);
  });

  it('agent bound but unresolvable (deleted / lookup failed) → no LOG / memory writes, title still maintained', async () => {
    await query(`UPDATE chat_sessions SET agent_config = '{"agentSlug":"gone"}' WHERE id = 'aria-s'`);
    await tick();
    expect(mem.filter((m) => m.slug === 'gone')).toHaveLength(0);
    expect(mem).toHaveLength(3); // 只剩 plain-s 那一趟
    expect(logs).toHaveLength(1);
    const row = (await query<any[]>(`SELECT title, historian_last_summary_at FROM chat_sessions WHERE id = 'aria-s'`))[0];
    expect(row.title).toBe('新标题');
    expect(row.historian_last_summary_at).not.toBeNull();
  });

  it('empty memory array writes nothing; non-JSON output still marks the pass', async () => {
    reply = JSON.stringify({ title: '', log: '', memory: [] });
    await tick();
    expect(mem).toHaveLength(0);
    reply = 'not json';
    await query(`UPDATE chat_sessions SET historian_last_summary_at = NULL`);
    await tick();
    expect(mem).toHaveLength(0);
    const pending = await query<any[]>(`SELECT id FROM chat_sessions WHERE historian_last_summary_at IS NULL`);
    expect(pending.map((r) => r.id)).toEqual(['ancient']);
  });
});
