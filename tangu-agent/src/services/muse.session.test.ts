/**
 * Muse 会话轮换 / 预算口径 / kickoff 拆分(2026-09-14 C1+C2)。
 * 从前:取**最老**的 kind='muse' 行永久复用、预算只看那一个会话、5k 字符时点摘要落库逐周期回放。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const db = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: any[] }>,
  sessionRows: [] as any[],
  msgCount: 0,
  usageRows: [] as any[],
}));

vi.mock('../core/db.js', () => ({
  query: vi.fn(async (sql: string, params: any[] = []) => {
    db.calls.push({ sql, params });
    if (/FROM chat_sessions/.test(sql)) return db.sessionRows;
    if (/COUNT\(\*\) AS n FROM chat_messages/.test(sql)) return [{ n: db.msgCount }];
    if (/FROM agent_run_events/.test(sql)) return db.usageRows;
    return [];
  }),
  getOlderThanSql: (col: string, minutes: number) => `${col} < CURRENT_TIMESTAMP - INTERVAL '${minutes} minutes'`,
}));
vi.mock('../seams/runtime.js', () => ({
  deps: () => ({ profile: { appId: 'tangu', capabilities: { hostExec: true } }, host: { log: () => {} } }),
}));

import {
  shouldRotateMuseSession, MUSE_SESSION_MAX_MESSAGES, getMuseSessionId, ensureMuseSession,
  tokensInWindow, buildCycleMessages, museAgentConfig, readLastCycleAt, writeLastCycleAt, museStateFile,
} from './muse.js';
import { SPECIAL_AGENTS_DEFAULTS } from './specialAgentsConfig.js';
import { protectedHostPaths } from '../sandbox/hostSandboxProtection.js';

beforeEach(() => {
  db.calls.length = 0;
  db.sessionRows = [];
  db.usageRows = [];
  db.msgCount = 0;
});

describe('C1a 会话轮换', () => {
  it('轮换判据:攒够 30 条就换,差一条不换', () => {
    expect(MUSE_SESSION_MAX_MESSAGES).toBe(30);
    expect(shouldRotateMuseSession(0)).toBe(false);
    expect(shouldRotateMuseSession(29)).toBe(false);
    expect(shouldRotateMuseSession(30)).toBe(true);
    expect(shouldRotateMuseSession(120)).toBe(true);
  });

  it('活动会话 = 最**新**的那行(从前取最老 → 永不轮换)', async () => {
    db.sessionRows = [{ id: 'newest' }];
    expect(await getMuseSessionId('u1')).toBe('newest');
    const sql = db.calls[0].sql;
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(sql).not.toContain('created_at ASC');
  });

  it('未满 → 复用活动会话,一行都不插', async () => {
    db.sessionRows = [{ id: 's-active' }];
    db.msgCount = MUSE_SESSION_MAX_MESSAGES - 1;
    expect(await ensureMuseSession('u1', 'm1')).toBe('s-active');
    expect(db.calls.some((c) => /INSERT INTO chat_sessions/.test(c.sql))).toBe(false);
  });

  it('已满 → 插一行新会话并改用它', async () => {
    db.sessionRows = [{ id: 's-full' }];
    db.msgCount = MUSE_SESSION_MAX_MESSAGES;
    const id = await ensureMuseSession('u1', 'm1');
    expect(id).not.toBe('s-full');
    const ins = db.calls.find((c) => /INSERT INTO chat_sessions/.test(c.sql));
    expect(ins).toBeTruthy();
    expect(ins!.params[0]).toBe(id);
    expect(ins!.sql).toContain("'muse'");
  });

  it('一条会话都没有 → 建首个', async () => {
    db.sessionRows = [];
    const id = await ensureMuseSession('u1', 'm1');
    expect(id).toBeTruthy();
    expect(db.calls.some((c) => /INSERT INTO chat_sessions/.test(c.sql))).toBe(true);
  });
});

describe('C1a 预算口径:跨全部 Muse 会话', () => {
  it('按 kind+user 计,不按单个会话(轮换后预算不清零)', async () => {
    await tokensInWindow('u1', 5);
    const c = db.calls.find((x) => /FROM agent_run_events/.test(x.sql))!;
    expect(c.sql).toContain("s.kind = 'muse'");
    expect(c.sql).toContain('s.user_id = ?');
    expect(c.sql).not.toContain('r.session_id = ?');
    expect(c.params).toEqual(['u1']);
  });

  it('计费 = Σ(prompt−cached)+completion;毛量 = Σprompt;PG 对象与 SQLite JSON 串都算', async () => {
    db.usageRows = [
      { payload: { prompt: 100_000, cached: 90_000, completion: 500 } }, // PG
      { payload: JSON.stringify({ prompt: 50_000, cached: 0, completion: 1_000 }) }, // SQLite
      { payload: 'not json' }, // 坏行按 0
    ];
    const { billable, gross } = await tokensInWindow('u1', 5);
    expect(billable).toBe(10_000 + 500 + 50_000 + 1_000);
    expect(gross).toBe(150_000);
  });
});

describe('C1b kickoff 拆分', () => {
  const cfg = { ...SPECIAL_AGENTS_DEFAULTS.muse, mode: 'ask' as const, escalateTo: '', notify: 'immediate' as const };
  const dynA = { extraKickoff: '\n\n[Watch rule fired] x', hint: '\n\n[User\'s long-term memory]\nsecret', pending: 3, quietSince: true };
  const dynB = { extraKickoff: '', hint: '\n\n[Recent in-app user activity (last 12h…)]\nother', pending: 0, quietSince: false };

  it('落库的那条同配置下逐字不变(会话内回放是稳定前缀)', () => {
    expect(buildCycleMessages(cfg, dynA).message).toBe(buildCycleMessages(cfg, dynB).message);
    expect(buildCycleMessages(cfg, {}).message).toBe(buildCycleMessages(cfg, dynA).message);
  });

  it('落库的那条是短指令(仍带权限档 / Space / TODO 配额三条规矩)', () => {
    const { message } = buildCycleMessages(cfg, dynA);
    expect(message.length).toBeLessThan(2500);
    expect(message).toContain('Permission tier: ask');
    expect(message).toContain('Your Space:');
    expect(message).toContain('add_muse_todo');
  });

  it('时点数据只在 ephemeralHint 里(顺序:安静 → 待批 → 触发 → 摘要)', () => {
    const { message, ephemeralHint } = buildCycleMessages(cfg, dynA);
    for (const mark of ['No new user messages', '3 of your earlier actions', 'Watch rule fired', "[User's long-term memory]"]) {
      expect(ephemeralHint).toContain(mark);
      expect(message).not.toContain(mark);
    }
    expect(ephemeralHint.indexOf('No new user messages')).toBeLessThan(ephemeralHint.indexOf('3 of your earlier actions'));
    expect(ephemeralHint.indexOf('Watch rule fired')).toBeLessThan(ephemeralHint.indexOf("[User's long-term memory]"));
  });

  it('无时点数据 → 空简报(不发一段空白)', () => {
    expect(buildCycleMessages(cfg, {}).ephemeralHint).toBe('');
  });
});

describe('D3 后台思考档', () => {
  it('缺省 low;用户在 muse 的 config.toml 设过就尊重他的', () => {
    expect(museAgentConfig(SPECIAL_AGENTS_DEFAULTS.muse).thinkingLevel).toBe('low');
    expect(museAgentConfig(SPECIAL_AGENTS_DEFAULTS.muse, 'high').thinkingLevel).toBe('high');
    expect(museAgentConfig(SPECIAL_AGENTS_DEFAULTS.muse, '').thinkingLevel).toBe('low'); // 空串=没设
  });
});

describe('C2 lastCycleAt 落盘', () => {
  const withHome = async (fn: () => Promise<void>): Promise<void> => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'muse-home-'));
    const prev = process.env.TANGU_HOME;
    process.env.TANGU_HOME = home;
    try { await fn(); } finally {
      if (prev === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prev;
      await fsp.rm(home, { recursive: true, force: true });
    }
  };

  // 调度控制态**不能**住在模型可写的 agents/<slug>/ 里:Muse(或提示注入)把 lastCycleAt 写成远未来,
  // 下次启动读回后心跳条件长期不成立 = 把自己永久停掉。
  it('落盘位置在 agent 目录之外(引擎自有状态域)', async () => {
    await withHome(async () => {
      expect(museStateFile().startsWith(path.join(process.env.TANGU_HOME!, 'agents'))).toBe(false);
      expect(path.dirname(museStateFile())).toBe(process.env.TANGU_HOME);
    });
  });

  it('写—读往返;文件不存在 / 坏值 / 未来时刻 → 0(退回「没跑过」)', async () => {
    await withHome(async () => {
      expect(await readLastCycleAt()).toBe(0);
      await writeLastCycleAt(1_757_000_000_000);
      expect(await readLastCycleAt()).toBe(1_757_000_000_000);
      await fsp.writeFile(museStateFile(), '{oops', 'utf8');
      expect(await readLastCycleAt()).toBe(0);
      // 晚于当前时刻的值只可能来自篡改或时钟回拨 → 当没跑过(最多多跑一个周期,而不是永久停摆)。
      await writeLastCycleAt(Date.now() + 86_400_000);
      expect(await readLastCycleAt()).toBe(0);
    });
  });

  // 「住 agent 目录之外」只挡住 write 工具的可写根;run_bash 走的是 host sandbox 的 deny 列表,
  // 那份列表漏了这个文件 = 模型一条 shell 就能改调度控制态。两道闸都要钉。
  it('在 host sandbox 保护名单里(run_bash 也改不动调度控制态)', async () => {
    await withHome(async () => {
      expect(protectedHostPaths()).toContain(museStateFile());
    });
  });
});
