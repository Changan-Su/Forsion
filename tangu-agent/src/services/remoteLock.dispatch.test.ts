/**
 * P1 · K2 §3.3 · 真 loop(内存 SQLite + 真 agentLoop + 脚本化 fake llm):锁定时 dispatchRun 的单一扼流点。
 *   - 锁定 + 远程 / 通道 / Muse / 自动化 input → 终态 aborted、事件 error:'remote_locked' + reason、模型一次都没被调;
 *   - 锁定 + 本机 run → 照常跑完(S10:锁只收紧,本机不受影响);
 *   - 锁定前已排队、锁定后才轮到的远程 run 同样被拦(覆盖排队 / 重启恢复);
 *   - remoteLocked 读不出(桩成抛异常)→ 仍拒(不许经外层 catch 回落 runLoop = fail open)。
 * 负对照:改前(无扼流点)远程 run 照常起跑到 done → 红。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/index.js';
import { createSqliteHost } from '../adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import { runMigration } from '../db/migrate.js';
import { query } from '../core/db.js';
import { createRun, getRun } from './runStore.js';
import { subscribe } from './eventBus.js';
import { enqueueRun } from './agentLoop.js';
import * as remoteLock from './remoteLock.js';
import { REMOTE_LOCK_FILE_ENV, __resetRemoteLatchForTests } from './remoteLock.js';

const USER = 'u1';
let home: string;
let lockFile: string;
let llmCalls: number;
let gate: (() => Promise<void>) | null;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-remote-lock-'));
  process.env.TANGU_HOME = home;
  lockFile = join(home, 'remote-lock.json');
  process.env[REMOTE_LOCK_FILE_ENV] = lockFile;
  __resetRemoteLatchForTests();
  llmCalls = 0;
  gate = null;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
      streamProviderCompletion: async (o: any) => {
        if (!o.onToken) return { content: 'bg', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' };
        llmCalls++;
        if (gate) await gate();
        return { content: 'ran', reasoning: '', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 }, finishReason: 'stop' };
      },
    },
    users: { getUserById: async () => ({ id: USER, username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false },
  };
  const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) } as any);
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`, [USER]);
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('Q', ?, 'tangu', 't', 'm1', 'user')`, [USER]);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TANGU_HOME;
  delete process.env[REMOTE_LOCK_FILE_ENV];
  __resetRemoteLatchForTests();
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

const lock = (): void => writeFileSync(lockFile, JSON.stringify({ v: 1, lock: { locked: true, at: Date.now(), source: 'hotkey' }, hotkey: '' }));
const unlock = (): void => writeFileSync(lockFile, JSON.stringify({ v: 1, lock: null, hotkey: '' }));

let runSeq = 0;
async function create(extra: Record<string, unknown>, session = 'S'): Promise<string> {
  const runId = `D${++runSeq}`;
  const { agentConfig, ...rest } = extra as any;
  await createRun({
    id: runId, sessionId: session, userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `${runId}-a`,
    input: { message: 'go', userMessageId: `${runId}-u`, attachments: [], agentConfig: { execMode: 'host', cwd: home, ...(agentConfig || {}) }, ...rest },
  });
  return runId;
}
async function settle(runId: string, errors: any[]): Promise<{ status: string; errors: any[] }> {
  const t0 = Date.now();
  for (;;) {
    const r = await getRun(runId);
    if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) return { status: String(r.status), errors };
    if (Date.now() - t0 > 15_000) throw new Error(`run 未结束(status=${r?.status})`);
    await new Promise((res) => setTimeout(res, 20));
  }
}
async function runTo(extra: Record<string, unknown>): Promise<{ status: string; errors: any[] }> {
  const runId = await create(extra);
  const errors: any[] = [];
  const off = subscribe(runId, (ev) => { if (ev.type === 'error') errors.push(ev.payload); });
  enqueueRun('S', runId);
  try { return await settle(runId, errors); } finally { off(); }
}

const REMOTE = { remote: { via: 'tunnel', marked: true } };
const CHANNEL = { source: { channel: 'wechat', accountId: 'a', openid: 'p', messageId: 'm' } };
const MUSE = { background: 'muse' };
const AUTOMATION = { agentConfig: { automationOrigin: 'trigger-1' } };

describe('锁定 × dispatchRun 扼流点', () => {
  it.each([['remote', REMOTE], ['channel', CHANNEL], ['muse', MUSE], ['automation', AUTOMATION]])('锁定 + %s run → aborted / remote_locked,模型零调用', async (_k, extra) => {
    lock();
    const r = await runTo(extra);
    expect(r.status).toBe('aborted');
    expect(r.errors).toEqual([expect.objectContaining({ error: 'remote_locked', aborted: true, reason: 'remote_locked' })]);
    expect(llmCalls).toBe(0);
  });

  it('锁定 + 本机 run → 照常跑完(S10)', async () => {
    lock();
    const r = await runTo({});
    expect(r.status).toBe('done');
    expect(llmCalls).toBe(1);
  });

  it('未锁(lock:null)→ 远程 run 照常跑完;锁文件不存在 → 同样照常', async () => {
    unlock();
    expect((await runTo(REMOTE)).status).toBe('done');
    rmSync(lockFile, { force: true });
    expect((await runTo(REMOTE)).status).toBe('done');
  });

  it('锁定前已排队、锁定后才轮到的远程 run 同样被拦', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    gate = () => held;
    const first = await create({}, 'Q');
    const queued = await create(REMOTE, 'Q');
    const errors: any[] = [];
    const off = subscribe(queued, (ev) => { if (ev.type === 'error') errors.push(ev.payload); });
    enqueueRun('Q', first);
    enqueueRun('Q', queued); // 排在本机 run 后面
    await new Promise((r) => setTimeout(r, 50));
    lock(); // 排队期间急停
    gate = null;
    release();
    try {
      expect((await settle(first, [])).status).toBe('done');
      const r = await settle(queued, errors);
      expect(r.status).toBe('aborted');
      expect(errors[0]).toMatchObject({ error: 'remote_locked', reason: 'remote_locked' });
    } finally { off(); }
  });

  it('被拒之后同会话下一条本机 run 照常跑(拒跑分支释放了会话队列)', async () => {
    lock();
    expect((await runTo(REMOTE)).status).toBe('aborted');
    expect((await runTo({})).status).toBe('done');
  });

  it('坏锁文件 → fail closed(远程 run 被拒)', async () => {
    writeFileSync(lockFile, '{not json');
    expect((await runTo(REMOTE)).status).toBe('aborted');
  });

  it('remoteLocked 抛异常 → 仍拒(不经外层 catch 回落 runLoop)', async () => {
    vi.spyOn(remoteLock, 'remoteLocked').mockImplementation(() => { throw new Error('boom'); });
    const r = await runTo(REMOTE);
    expect(r.status).toBe('aborted');
    expect(llmCalls).toBe(0);
  });

  it('拒跑分支不落任何助手消息(S13:锁状态不进上下文)', async () => {
    lock();
    const runId = await create(REMOTE);
    enqueueRun('S', runId);
    await settle(runId, []);
    const rows = await query<any[]>(`SELECT role, content FROM chat_messages WHERE session_id = 'S'`);
    expect(rows.filter((m) => m.role !== 'user' && String(m.content || '').includes('locked'))).toEqual([]);
  });
});
